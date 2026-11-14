import { AnthropicProvider } from '@mcp-abap-adt/anthropic-llm';
import {
  findThrottled,
  type ILlm,
  staticApiKey,
  type ThrottleContext,
} from '@mcp-abap-adt/llm-agent';
import {
  LlmAdapter,
  LlmProviderBridge,
  RetryLlm,
} from '@mcp-abap-adt/llm-agent-libs';
import { HubAnthropicProvider } from '../../srv/lib/llm-factory';
import {
  llmFailure,
  observeLlmSpend,
  reliableLlm,
} from '../../srv/lib/llm-failure';

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
    quotaScope: 'model-isolation-session',
    whenThrottled: { name: 'test', decide },
  });
  const consume = async (model?: string) => {
    const chunks = [];
    for await (const chunk of provider.streamChat([], undefined, { model }))
      chunks.push(chunk);
    return chunks;
  };
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
