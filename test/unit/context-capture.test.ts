import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { parseContextCapture } from '../../srv/agent-config';
import {
  captureLlm,
  runWithContextCapture,
} from '../../srv/lib/context-capture';

const secret = 'sk-secret-message-arguments-result';
const messages: Message[] = [
  { role: 'system', content: secret },
  { role: 'user', content: secret },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call1',
        type: 'function',
        function: { name: 'RuntimeListFeeds', arguments: secret },
      },
    ],
  },
  ...[1, 2, 3, 4].map(
    (n): Message => ({
      role: 'tool',
      tool_call_id: 'call1',
      content: secret.repeat(n),
    }),
  ),
];
const tools = [
  { name: 'RuntimeListFeeds', description: secret, inputSchema: {} },
];
const usage = { promptTokens: 123, completionTokens: 45, totalTokens: 168 };
const llm: ILlm = {
  model: 'model-id',
  chat: jest.fn(async () => ({
    ok: true as const,
    value: { content: secret, finishReason: 'stop' as const, usage },
  })),
  async *streamChat() {
    yield { ok: true as const, value: { content: secret } };
    yield { ok: true as const, value: { content: '', usage } };
  },
};

let info: jest.SpyInstance;
const saved = process.env.LLM_AGENT_CONTEXT_CAPTURE;
beforeEach(() => {
  process.env.LLM_AGENT_CONTEXT_CAPTURE = 'stats';
  info = jest
    .spyOn(cds.log('context-capture'), 'info')
    .mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  if (saved === undefined) delete process.env.LLM_AGENT_CONTEXT_CAPTURE;
  else process.env.LLM_AGENT_CONTEXT_CAPTURE = saved;
});

test('stats include only identifiers and numbers, preserving the call', async () => {
  const result = await runWithContextCapture(
    { component: 'executor', taskId: 'task1', sessionKey: 'session1' },
    () => captureLlm(llm, 'chat').chat(messages, tools),
  );
  expect(result.ok).toBe(true);
  expect(llm.chat).toHaveBeenLastCalledWith(messages, tools);
  expect(info).toHaveBeenCalledTimes(1);
  const stats = JSON.parse(info.mock.calls[0][0]);
  expect(stats).toMatchObject({
    component: 'executor',
    taskId: 'task1',
    sessionKey: 'session1',
    model: 'model-id',
    messageCount: 7,
    roles: {
      system: { messages: 1, characters: secret.length },
      user: { messages: 1, characters: secret.length },
      tool: { messages: 4, characters: secret.length * 10 },
    },
    toolResultCount: 4,
    toolDefinitionCount: 1,
    toolDefinitionCharacters: JSON.stringify(tools[0]).length,
    inputTokens: 123,
    outputTokens: 45,
  });
  expect(stats.roles.assistant.characters).toBe(
    JSON.stringify(messages[2].tool_calls?.[0]).length,
  );
  expect(stats.largestToolResults).toEqual(
    [4, 3, 2].map((n) => ({
      tool: 'RuntimeListFeeds',
      characters: secret.length * n,
    })),
  );
  expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
});

test('streaming logs once after completion with reported usage', async () => {
  for await (const _chunk of captureLlm(llm).streamChat(messages, tools)) {
    expect(info).not.toHaveBeenCalled();
  }
  expect(info).toHaveBeenCalledTimes(1);
  expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({
    component: 'other',
    inputTokens: 123,
    outputTokens: 45,
  });
  expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
});

test('failed calls log once without leaking the error or estimating usage', async () => {
  const failing = {
    ...llm,
    chat: async () => {
      throw new Error(secret);
    },
  };
  await expect(captureLlm(failing).chat(messages)).rejects.toThrow(secret);
  expect(info).toHaveBeenCalledTimes(1);
  expect(JSON.parse(info.mock.calls[0][0])).not.toHaveProperty('inputTokens');
  expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
});

test('off by default and explicit off do not log', async () => {
  delete process.env.LLM_AGENT_CONTEXT_CAPTURE;
  await captureLlm(llm).chat(messages);
  process.env.LLM_AGENT_CONTEXT_CAPTURE = 'off';
  await captureLlm(llm).chat(messages);
  expect(info).not.toHaveBeenCalled();
});

test('configuration validates the capture mode', () => {
  expect(parseContextCapture({})).toBe('off');
  expect(parseContextCapture({ LLM_AGENT_CONTEXT_CAPTURE: 'stats' })).toBe(
    'stats',
  );
  expect(() =>
    parseContextCapture({ LLM_AGENT_CONTEXT_CAPTURE: 'full' }),
  ).toThrow('expected off or stats');
});

test('concurrent calls retain their own task scope and helpers remain other', async () => {
  const main = captureLlm(llm, 'chat');
  await Promise.all(
    ['executor', 'checker'].map((component) =>
      runWithContextCapture(
        { component: component as 'executor' | 'checker', taskId: component },
        async () => {
          await Promise.resolve();
          await main.chat(messages);
          await captureLlm(llm).chat(messages);
        },
      ),
    ),
  );
  const stats = info.mock.calls.map(([line]) => JSON.parse(line));
  expect(stats).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ component: 'executor', taskId: 'executor' }),
      expect.objectContaining({ component: 'checker', taskId: 'checker' }),
      expect.objectContaining({ component: 'other', taskId: 'executor' }),
      expect.objectContaining({ component: 'other', taskId: 'checker' }),
    ]),
  );
});

test('closing a stream early still logs once without invented tokens', async () => {
  for await (const _chunk of captureLlm(llm).streamChat(messages)) break;
  expect(info).toHaveBeenCalledTimes(1);
  expect(JSON.parse(info.mock.calls[0][0])).not.toHaveProperty('inputTokens');
});

test.each(['chat', 'streamChat'] as const)(
  '%s logs only tool names listed in this call and the configured model',
  async (method) => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'secret-call',
            type: 'function',
            function: { name: secret, arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'secret-call', content: 'result' },
    ];
    const captured = captureLlm(llm);
    if (method === 'chat') {
      await captured.chat(history, tools, { model: 'override-model' });
    } else {
      for await (const _chunk of captured.streamChat(history, tools, {
        model: 'override-model',
      })) {
        /* consume */
      }
    }
    expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({
      model: llm.model,
      largestToolResults: [{ tool: 'unlisted', characters: 6 }],
    });
  },
);

test('throwing logger preserves successful and failed chat results and original errors', async () => {
  info.mockImplementation(() => {
    throw new Error('logger failed');
  });
  const success = await llm.chat(messages, tools);
  await expect(captureLlm(llm).chat(messages, tools)).resolves.toEqual(success);
  const failure = { ok: false as const, error: new Error('original failure') };
  const failing: ILlm = { ...llm, chat: jest.fn().mockResolvedValue(failure) };
  await expect(captureLlm(failing).chat(messages)).resolves.toBe(failure);
  const original = new Error('original exception');
  failing.chat = jest.fn().mockRejectedValue(original);
  await expect(captureLlm(failing).chat(messages)).rejects.toBe(original);
});

test('throwing logger preserves stream completion and original stream errors', async () => {
  info.mockImplementation(() => {
    throw new Error('logger failed');
  });
  const chunks = [];
  for await (const chunk of captureLlm(llm).streamChat(messages, tools)) {
    chunks.push(chunk);
  }
  expect(chunks).toEqual([
    { ok: true, value: { content: secret } },
    { ok: true, value: { content: '', usage } },
  ]);
  const original = new Error('original stream exception');
  const failing: ILlm = {
    ...llm,
    async *streamChat() {
      yield { ok: true as const, value: { content: secret } };
      throw original;
    },
  };
  await expect(
    (async () => {
      for await (const _chunk of captureLlm(failing).streamChat(messages)) {
        /* consume */
      }
    })(),
  ).rejects.toBe(original);
});

test.each(['chat', 'streamChat'] as const)(
  '%s tolerates failures while building telemetry',
  async (method) => {
    const brokenTools = [
      {
        ...tools[0],
        toJSON() {
          throw new Error('stats failed');
        },
      },
    ];
    if (method === 'chat') {
      await expect(
        captureLlm(llm).chat(messages, brokenTools),
      ).resolves.toMatchObject({ ok: true });
    } else {
      const chunks = [];
      for await (const chunk of captureLlm(llm).streamChat(
        messages,
        brokenTools,
      )) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(2);
    }
    expect(info).not.toHaveBeenCalled();
  },
);
