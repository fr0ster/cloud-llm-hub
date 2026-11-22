import { AsyncResource } from 'node:async_hooks';
import { AnthropicProvider } from '@mcp-abap-adt/anthropic-llm';
import {
  addTokenUsage,
  findThrottled,
  type ILlm,
  staticApiKey,
  type ThrottleContext,
  type TokenUsage,
} from '@mcp-abap-adt/llm-agent';
import {
  LlmAdapter,
  LlmProviderBridge,
  RetryLlm,
} from '@mcp-abap-adt/llm-agent-libs';
import { HubAnthropicProvider, makeHubLlm } from '../../srv/lib/llm-factory';
import {
  captureTokenUsage,
  llmFailure,
  observeLlmSpend,
  reliableLlm,
  reportLlmSpend,
} from '../../srv/lib/llm-failure';

test('a successful chat without provider usage counts one request', async () => {
  const llm = reliableLlm({
    model: 'chat-model',
    chat: async () => ({
      ok: true,
      value: { content: 'answer', finishReason: 'stop' },
    }),
    async *streamChat() {},
  });
  const spend = captureTokenUsage();
  const result = await spend.run(() => llm.chat([]));

  expect(result).toEqual({
    ok: true,
    value: { content: 'answer', finishReason: 'stop' },
  });
  expect(spend.usage()).toEqual({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    models: {
      'chat-model': {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requests: 1,
      },
    },
  });
});

test('a usage-free stream keeps its owner when consumed from another async resource', async () => {
  const llm = reliableLlm({
    model: 'stream-model',
    chat: async () => ({
      ok: true,
      value: { content: 'answer', finishReason: 'stop' },
    }),
    async *streamChat() {
      yield { ok: true, value: { content: 'answer' } };
    },
  });
  const owner = captureTokenUsage();
  const reader = captureTokenUsage();
  const resource = reader.run(() => new AsyncResource('StreamReader'));
  const stream = owner.run(() => llm.streamChat([]));
  try {
    await resource.runInAsyncScope(async () => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toEqual([{ ok: true, value: { content: 'answer' } }]);
    });

    expect(owner.usage()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      models: {
        'stream-model': {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          requests: 1,
        },
      },
    });
    expect(reader.usage()).toBeUndefined();
  } finally {
    resource.emitDestroy();
  }
});

test('provider stream start exposes cache counts and finalizes a single request', async () => {
  const initial: TokenUsage = {
    promptTokens: 1531,
    completionTokens: 0,
    totalTokens: 1531,
    cachedInputTokens: 1527,
    cacheCreationInputTokens: 0,
  };
  const provider: ILlm = {
    model: 'claude',
    chat: async () => ({
      ok: true,
      value: { content: '', finishReason: 'stop' },
    }),
    async *streamChat() {
      yield { ok: true, value: { content: '', usage: initial } };
      yield { ok: true, value: { content: 'answer' } };
      yield {
        ok: true,
        value: {
          content: '',
          usage: { promptTokens: 0, completionTokens: 177, totalTokens: 177 },
        },
      };
    },
  };
  const llm = reliableLlm(provider);
  const spend = captureTokenUsage();
  const pipelineUsage: TokenUsage = {
    ...initial,
    models: { unknown: { ...initial, requests: 1 } },
  };
  expect(spend.usage(pipelineUsage)).toBe(pipelineUsage);
  await spend.run(async () => {
    for await (const chunk of llm.streamChat([])) {
      if (!chunk.ok) throw chunk.error;
      if (chunk.value.content)
        expect(spend.streamUsage(pipelineUsage)?.models).toEqual({
          claude: { ...initial, requests: 1 },
        });
    }
  });
  expect(spend.usage(pipelineUsage)?.models).toEqual({
    claude: {
      ...initial,
      completionTokens: 177,
      totalTokens: 1708,
      requests: 1,
    },
  });
});

function attemptResponse(
  inputTokens: number | undefined,
  outcome: 'rate_limit_error' | 'api_error' | 'stop',
  outputTokens = 0,
): Response {
  const event = (name: string, data: object) =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(
    (inputTokens === undefined
      ? ''
      : event('message_start', {
          message: { usage: { input_tokens: inputTokens, output_tokens: 0 } },
        })) +
      (outcome === 'rate_limit_error'
        ? ''
        : event('content_block_delta', {
            delta: { type: 'text_delta', text: 'partial' },
          })) +
      (outcome === 'stop'
        ? event('message_delta', {
            delta: { stop_reason: 'stop' },
            usage:
              inputTokens === undefined
                ? undefined
                : { output_tokens: outputTokens },
          })
        : event('error', { error: { type: outcome, message: 'private' } })),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

test.each(['api_error', 'stop'] as const)(
  'attributes both real Anthropic attempts when a retry ends in %s',
  async (outcome) => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(attemptResponse(7, 'rate_limit_error'))
      .mockResolvedValueOnce(attemptResponse(11, outcome, 3));
    try {
      const llm = await makeHubLlm(
        {
          provider: 'anthropic',
          apiKey: 'spend-retry-test',
          // Explicit: these attempts are about spend, not model metadata.
          maxTokens: 1024,
          model: 'test',
          whenThrottled: {
            name: 'test',
            decide: () => ({ retry: true, waitMs: 0 }),
          },
        },
        0,
      );
      const reports: TokenUsage[] = [];
      let spent: TokenUsage | undefined;
      let seenAtFailure: TokenUsage | undefined;
      const chunks = await observeLlmSpend(
        async () => {
          const result = [];
          for await (const chunk of llm.streamChat([], undefined, {
            model: 'public-alias',
          })) {
            result.push(chunk);
            if (!chunk.ok) seenAtFailure = spent;
          }
          return result;
        },
        (usage) => {
          reports.push(usage);
          spent = addTokenUsage(spent, usage);
        },
      );
      const completionTokens = outcome === 'stop' ? 3 : 0;
      const expected = {
        promptTokens: 18,
        completionTokens,
        totalTokens: 18 + completionTokens,
        models: {
          test: {
            promptTokens: 18,
            completionTokens,
            totalTokens: 18 + completionTokens,
            requests: 2,
          },
        },
      };
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual([
        expect.stringContaining('"model":"test"'),
        expect.stringContaining('"model":"test"'),
      ]);
      expect(reports).toHaveLength(2);
      for (const [index, usage] of reports.entries()) {
        const promptTokens = index === 0 ? 7 : 11;
        const output = index === 0 ? 0 : completionTokens;
        expect(usage).toEqual({
          promptTokens,
          completionTokens: output,
          totalTokens: promptTokens + output,
          models: {
            test: {
              promptTokens,
              completionTokens: output,
              totalTokens: promptTokens + output,
              requests: 1,
            },
          },
        });
      }
      expect(spent).toEqual(expected);
      expect(chunks.at(-1)?.ok).toBe(outcome === 'stop');
      if (outcome === 'api_error') expect(seenAtFailure).toEqual(expected);
    } finally {
      fetch.mockRestore();
    }
  },
);

test('keeps retry spend separate for two actual models in one observer', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(attemptResponse(7, 'rate_limit_error'))
    .mockResolvedValueOnce(attemptResponse(11, 'api_error'))
    .mockResolvedValueOnce(attemptResponse(13, 'rate_limit_error'))
    .mockResolvedValueOnce(attemptResponse(17, 'stop', 5));
  try {
    let spent: TokenUsage | undefined;
    await observeLlmSpend(
      async () => {
        for (const model of ['test', 'other']) {
          const llm = await makeHubLlm(
            {
              provider: 'anthropic',
              apiKey: 'spend-two-models-test',
              // Explicit: these attempts are about spend, not model metadata.
              maxTokens: 1024,
              model,
              whenThrottled: {
                name: 'test',
                decide: () => ({ retry: true, waitMs: 0 }),
              },
            },
            0,
          );
          for await (const chunk of llm.streamChat([], undefined, {
            model: 'public-alias',
          })) {
            if (!chunk.ok) expect(model).toBe('test');
          }
        }
      },
      (usage) => {
        const entries = Object.values(usage.models ?? {});
        for (const field of [
          'promptTokens',
          'completionTokens',
          'totalTokens',
        ] as const) {
          expect(entries.reduce((sum, entry) => sum + entry[field], 0)).toBe(
            usage[field],
          );
        }
        spent = addTokenUsage(spent, usage);
      },
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual(
      ['test', 'test', 'other', 'other'].map((model) =>
        expect.stringContaining(`"model":"${model}"`),
      ),
    );
    expect(spent).toEqual({
      promptTokens: 48,
      completionTokens: 5,
      totalTokens: 53,
      models: {
        test: {
          promptTokens: 18,
          completionTokens: 0,
          totalTokens: 18,
          requests: 2,
        },
        other: {
          promptTokens: 30,
          completionTokens: 5,
          totalTokens: 35,
          requests: 2,
        },
      },
    });
  } finally {
    fetch.mockRestore();
  }
});

test('preserves an existing breakdown instead of folding models into the fallback', () => {
  const usage: TokenUsage = {
    promptTokens: 18,
    completionTokens: 3,
    totalTokens: 21,
    models: {
      first: {
        promptTokens: 7,
        completionTokens: 1,
        totalTokens: 8,
        requests: 1,
      },
      second: {
        promptTokens: 11,
        completionTokens: 2,
        totalTokens: 13,
        requests: 1,
      },
    },
  };
  const report = jest.fn();
  observeLlmSpend(() => reportLlmSpend(usage, 'fallback'), report);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(usage);
});

test.each(['http', 'sse', 'success', 'partial-failure'])(
  'counts a usage-free provider attempt (%s)',
  async (scenario) => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        scenario === 'http'
          ? new Response('rate limited', { status: 429 })
          : attemptResponse(
              scenario === 'sse' ? undefined : 7,
              'rate_limit_error',
            ),
      )
      .mockResolvedValueOnce(
        attemptResponse(
          scenario === 'http' || scenario === 'sse' ? 11 : undefined,
          scenario === 'partial-failure' ? 'api_error' : 'stop',
        ),
      );
    try {
      const llm = await makeHubLlm(
        {
          provider: 'anthropic',
          apiKey: `usage-free-${scenario}`,
          // Explicit: these attempts are about spend, not model metadata.
          maxTokens: 1024,
          model: 'test',
          whenThrottled: {
            name: 'test',
            decide: () => ({ retry: true, waitMs: 0 }),
          },
        },
        0,
      );
      let spent: TokenUsage | undefined;
      await observeLlmSpend(
        async () => {
          for await (const chunk of llm.streamChat([]))
            if (!chunk.ok) expect(scenario).toBe('partial-failure');
        },
        (usage) => {
          spent = addTokenUsage(spent, usage);
        },
      );
      const promptTokens = scenario === 'http' || scenario === 'sse' ? 11 : 7;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(spent).toEqual({
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        models: {
          test: {
            promptTokens,
            completionTokens: 0,
            totalTokens: promptTokens,
            requests: 2,
          },
        },
      });
    } finally {
      fetch.mockRestore();
    }
  },
);

const codes = [
  'overloaded_error',
  'api_error',
  'rate_limit_error',
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
];

test('an override model throttle does not gate the default model in one session', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '60' },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"model-A response"}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
  const decide = jest.fn(({ retryAfterSeconds }: ThrottleContext) => ({
    retry: false,
    waitMs: (retryAfterSeconds ?? 0) * 1000,
    reason: 'report-only',
  }));
  const provider = new HubAnthropicProvider({
    model: 'model-A',
    credential: staticApiKey('model-isolation-test'),
    maxTokens: 1024,
    quotaScope: 'model-isolation-session',
    whenThrottled: { name: 'test', decide },
  });
  const spent: TokenUsage[] = [];
  const consume = (model?: string) =>
    observeLlmSpend(
      async () => {
        const chunks = [];
        for await (const chunk of provider.streamChat([], undefined, { model }))
          chunks.push(chunk);
        return chunks;
      },
      (usage) => spent.push(usage),
    );
  try {
    expect(provider).toBeInstanceOf(AnthropicProvider);
    await expect(consume('model-B')).rejects.toMatchObject({ throttled: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(consume()).resolves.toContainEqual(
      expect.objectContaining({ content: 'model-A response' }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual([
      expect.stringContaining('"model":"model-B"'),
      expect.stringContaining('"model":"model-A"'),
    ]);
    await expect(consume('model-B')).rejects.toMatchObject({ throttled: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls.map(([context]) => context.source)).toEqual([
      'response',
      'gate',
    ]);
    expect(spent).toEqual(
      ['model-B', 'model-A'].map((model) => ({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        models: {
          [model]: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            requests: 1,
          },
        },
      })),
    );
  } finally {
    fetch.mockRestore();
  }
});

test.each(['alternating', 'http', 'sse'])(
  'shares one throttle budget on the real %s HTTP/SSE path',
  async (sequence) => {
    const limit = 3;
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        const http =
          sequence === 'http' ||
          (sequence === 'alternating' && fetch.mock.calls.length % 2 === 1);
        return http
          ? new Response('rate limited', { status: 429 })
          : new Response(
              'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"private"}}\n\n',
              { headers: { 'Content-Type': 'text/event-stream' } },
            );
      });
    const decide = jest.fn(({ attempt }: ThrottleContext) => ({
      retry: attempt < limit,
      waitMs: 0,
    }));
    const provider = new HubAnthropicProvider({
      model: 'gpt-4o-mini',
      credential: staticApiKey('test'),
      maxTokens: 1024,
      whenThrottled: { name: 'test', decide },
    });
    try {
      const consume = async () => {
        for await (const chunk of provider.streamChat([])) {
          throw new Error(`Unexpected chunk: ${JSON.stringify(chunk)}`);
        }
      };
      await expect(consume()).rejects.toMatchObject({
        throttled: true,
        attempts: limit,
      });
      expect(fetch).toHaveBeenCalledTimes(limit);
      expect(decide.mock.calls.map(([context]) => context.attempt)).toEqual([
        1, 2, 3,
      ]);
    } finally {
      fetch.mockRestore();
    }
  },
);
test.each(codes)('reports only Anthropic error type %s', (code) => {
  for (const error of [
    Object.assign(new Error('secret provider text'), { code }),
    new Error(`Anthropic stream error: ${code}: secret provider text`),
  ]) {
    expect(llmFailure(new Error('wrapper', { cause: error }))).toBe(
      `LLM unavailable (${code})`,
    );
  }
});
test('unknown stream codes do not expose provider text', () => {
  expect(llmFailure(new Error('Anthropic stream error: custom: secret'))).toBe(
    'LLM unavailable (no response from model)',
  );
});

test.each([false, true])(
  'SSE throttle policy (exhausted=%s)',
  async (exhausted) => {
    let calls = 0;
    const source = jest
      .spyOn(AnthropicProvider.prototype, 'streamChat')
      .mockImplementation(async function* () {
        calls++;
        yield {
          content: '',
          usage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
        };
        if (exhausted || calls === 1)
          throw Object.assign(
            new Error('Anthropic stream error: rate_limit_error: private'),
            { code: 'rate_limit_error' },
          );
        yield { content: 'recovered' };
      });
    const decide = jest.fn(({ attempt }: ThrottleContext) => ({
      waitMs: 0,
      retry: attempt < 3,
    }));
    const provider = new HubAnthropicProvider({
      model: 'gpt-4o-mini',
      credential: staticApiKey('test'),
      whenThrottled: { name: 'test', decide },
    });
    const llm = reliableLlm(new LlmAdapter(new LlmProviderBridge(provider)));
    try {
      const chunks = [];
      for await (const chunk of llm.streamChat([])) chunks.push(chunk);
      expect(calls).toBe(exhausted ? 3 : 2);
      expect(chunks.slice(0, exhausted ? -1 : undefined)).toEqual(
        exhausted
          ? []
          : [
              {
                ok: true,
                value: {
                  content: '',
                  usage: {
                    promptTokens: 2,
                    completionTokens: 0,
                    totalTokens: 2,
                  },
                },
              },
              { ok: true, value: { content: 'recovered' } },
              { ok: true, value: { content: '', finishReason: 'stop' } },
            ],
      );
      const last = chunks[chunks.length - 1];
      if (exhausted) {
        expect(last.ok).toBe(false);
        if (last.ok) throw new Error('Expected failure');
        expect(findThrottled(last.error)).toMatchObject({ attempts: 3 });
        expect(last.error.message).toBe('LLM unavailable (rate_limit_error)');
        expect(JSON.stringify(last.error)).not.toContain('private');
      } else {
        expect(last.ok).toBe(true);
        expect(chunks).toContainEqual(
          expect.objectContaining({
            ok: true,
            value: expect.objectContaining({ content: 'recovered' }),
          }),
        );
      }
      expect(decide).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, source: 'response' }),
      );
    } finally {
      source.mockRestore();
    }
  },
);

test.each(['overloaded_error', 'api_error'])(
  'retries %s through the existing transient policy',
  async (code) => {
    let calls = 0;
    const inner: ILlm = {
      async chat() {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error('private provider text'), { code });
        return {
          ok: true,
          value: { content: 'recovered', finishReason: 'stop' },
        };
      },
      async *streamChat(messages, tools, options) {
        yield await this.chat(messages, tools, options);
      },
    };
    const llm = new RetryLlm(reliableLlm(inner), {
      maxAttempts: 1,
      backoffMs: 0,
    });
    expect(await llm.chat([])).toMatchObject({
      ok: true,
      value: { content: 'recovered' },
    });
    expect(calls).toBe(2);
  },
);

test.each(['rate_limit_error', 'overloaded_error', 'api_error'])(
  'holds failed usage before %s and records both attempts',
  async (code) => {
    let calls = 0;
    const usage = { promptTokens: 2, completionTokens: 0, totalTokens: 2 };
    const source = jest
      .spyOn(AnthropicProvider.prototype, 'streamChat')
      .mockImplementation(async function* () {
        calls++;
        yield { content: '', usage };
        if (calls === 1) throw Object.assign(new Error('private'), { code });
        yield { content: 'recovered' };
      });
    const provider = new HubAnthropicProvider({
      model: 'gpt-4o-mini',
      credential: staticApiKey('test'),
      whenThrottled: {
        name: 'test',
        decide: () => ({ retry: true, waitMs: 0 }),
      },
    });
    const llm = new RetryLlm(
      reliableLlm(new LlmAdapter(new LlmProviderBridge(provider))),
      {
        maxAttempts: 1,
        backoffMs: 0,
      },
    );
    const spent = jest.fn();
    try {
      const chunks = await observeLlmSpend(async () => {
        const result = [];
        for await (const chunk of llm.streamChat([])) result.push(chunk);
        return result;
      }, spent);
      expect(calls).toBe(2);
      expect(chunks).toEqual([
        { ok: true, value: { content: '', usage } },
        { ok: true, value: { content: 'recovered' } },
        { ok: true, value: { content: '', finishReason: 'stop' } },
      ]);
      expect(spent).toHaveBeenCalledTimes(2);
      expect(spent.mock.calls.map(([value]) => value.promptTokens)).toEqual([
        2, 2,
      ]);
      expect(spent.mock.calls[0][0].models['gpt-4o-mini']).toEqual({
        ...usage,
        requests: 1,
      });
    } finally {
      source.mockRestore();
    }
  },
);

test.each(['rate_limit_error', 'overloaded_error', 'api_error'])(
  'never retries %s after text or tool content',
  async (code) => {
    for (const first of [
      { content: 'partial' },
      { content: '', toolCalls: [{ index: 0, arguments: '{"x":' }] },
      { content: '', finishReason: 'stop' },
    ]) {
      const source = jest
        .spyOn(AnthropicProvider.prototype, 'streamChat')
        .mockImplementation(async function* () {
          yield first;
          throw Object.assign(new Error('private'), { code });
        });
      const decide = jest.fn(({ attempt }: ThrottleContext) => ({
        retry: attempt < 3,
        waitMs: 0,
      }));
      const provider = new HubAnthropicProvider({
        model: 'gpt-4o-mini',
        credential: staticApiKey('test'),
        whenThrottled: { name: 'test', decide },
      });
      try {
        const chunks = [];
        let failure: Error | undefined;
        try {
          for await (const chunk of provider.streamChat([])) chunks.push(chunk);
        } catch (error) {
          if (error instanceof Error) failure = error;
          else throw error;
        }
        expect(chunks).toEqual([first]);
        expect(source).toHaveBeenCalledTimes(1);
        expect(llmFailure(failure)).toBe(`LLM unavailable (${code})`);
        if (code === 'rate_limit_error')
          expect(findThrottled(failure)).toMatchObject({ attempts: 1 });
        expect(decide).not.toHaveBeenCalled();
      } finally {
        source.mockRestore();
      }
    }
  },
);

test.each(['overloaded_error', 'api_error'])(
  'bounds repeated pre-content %s by the transient policy',
  async (code) => {
    const source = jest
      .spyOn(AnthropicProvider.prototype, 'streamChat')
      .mockImplementation(async function* () {
        yield {
          content: '',
          usage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
        };
        throw Object.assign(new Error('private'), { code });
      });
    const provider = new HubAnthropicProvider({
      model: 'gpt-4o-mini',
      credential: staticApiKey('test'),
    });
    const llm = new RetryLlm(
      reliableLlm(new LlmAdapter(new LlmProviderBridge(provider))),
      {
        maxAttempts: 3,
        backoffMs: 0,
      },
    );
    try {
      const chunks = [];
      for await (const chunk of llm.streamChat([])) chunks.push(chunk);
      expect(source).toHaveBeenCalledTimes(4);
      expect(chunks).toHaveLength(1);
      const [last] = chunks;
      if (last.ok) throw new Error('Expected failure');
      expect(last.error.message).toBe(`LLM unavailable (${code})`);
    } finally {
      source.mockRestore();
    }
  },
);

test.each([429, 500, 502, 503])(
  'never retries HTTP %s after tool arguments',
  async (status) => {
    const source = jest
      .spyOn(AnthropicProvider.prototype, 'streamChat')
      .mockImplementation(async function* () {
        yield { content: '', toolCalls: [{ index: 0, arguments: '{"x":' }] };
        throw Object.assign(new Error('private'), { status });
      });
    const provider = new HubAnthropicProvider({
      model: 'gpt-4o-mini',
      credential: staticApiKey('test'),
    });
    const llm = new RetryLlm(
      reliableLlm(new LlmAdapter(new LlmProviderBridge(provider))),
      {
        maxAttempts: 3,
        backoffMs: 0,
      },
    );
    try {
      const chunks = [];
      for await (const chunk of llm.streamChat([])) chunks.push(chunk);
      expect(source).toHaveBeenCalledTimes(1);
      expect(chunks).toHaveLength(1);
      const [last] = chunks;
      if (last.ok) throw new Error('Expected failure');
      expect(last.error.message).toBe(`LLM unavailable (HTTP ${status})`);
    } finally {
      source.mockRestore();
    }
  },
);
