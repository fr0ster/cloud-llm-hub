import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentCallOptions,
  ILlm,
  ISmartAgent,
  Message,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { guardLlmOnlyAgent } from '../../srv/lib/llm-only-guard';

const messages: Message[] = [{ role: 'user', content: 'Do it now' }];
const opts = { signal: new AbortController().signal };
const answer = {
  ok: true as const,
  value: {
    content: 'Answer',
    stopReason: 'stop' as const,
    iterations: 1,
    toolCallCount: 0,
  },
};
const chunks = [
  { ok: true as const, value: { content: 'Answer' } },
  { ok: true as const, value: { content: '', finishReason: 'stop' as const } },
];

function setup(
  content = '{"action":true,"language":"en"}',
  why: 'waiting' | 'unreachable' = 'waiting',
) {
  const chat = jest.fn().mockResolvedValue({ ok: true, value: { content } });
  const agent = {
    process: jest.fn(
      async (_messages: string | Message[], _opts?: AgentCallOptions) => answer,
    ),
    streamProcess: jest.fn(async function* (
      _messages: string | Message[],
      _opts?: AgentCallOptions,
    ) {
      yield* chunks;
    }),
    deps: { mainLlm: 'preserved' },
    stop: jest.fn(function (this: { deps: unknown }) {
      return this.deps;
    }),
  };
  const decide: ILlm = { chat, streamChat: jest.fn() };
  return { chat, agent, guarded: guardLlmOnlyAgent(agent, { decide, why }) };
}

async function collect(source: ReturnType<ISmartAgent['streamProcess']>) {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
}

describe('LLM-only guard', () => {
  it('passes process messages, options and result through unchanged', async () => {
    const { agent, guarded, chat } = setup('{"action":false}');
    expect(await guarded.process(messages, opts)).toBe(answer);
    expect(agent.process).toHaveBeenCalledTimes(1);
    expect(agent.process.mock.calls[0][0]).toBe(messages);
    expect(agent.process.mock.calls[0][1]).toBe(opts);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('passes stream messages, options and chunks through unchanged', async () => {
    const { agent, guarded } = setup('{"action":false}');
    const result = await collect(guarded.streamProcess(messages, opts));
    expect(result).toEqual(chunks);
    expect(result[0]).toBe(chunks[0]);
    expect(agent.streamProcess).toHaveBeenCalledTimes(1);
    expect(agent.streamProcess.mock.calls[0][0]).toBe(messages);
    expect(agent.streamProcess.mock.calls[0][1]).toBe(opts);
  });

  it.each([
    ['uk', 'Це неможливо'],
    ['de', 'Dies kann'],
    ['en', 'This cannot'],
    ['fr', 'This cannot'],
    [undefined, 'This cannot'],
  ])('refuses actions in %s without generation', async (language, prefix) => {
    const { agent, guarded } = setup(
      JSON.stringify({ action: true, language }),
    );
    const result = await guarded.process(messages);
    expect(result).toEqual({
      ok: true,
      value: {
        content: expect.stringContaining(prefix),
        stopReason: 'stop',
        iterations: 0,
        toolCallCount: 0,
      },
    });
    expect(agent.process).not.toHaveBeenCalled();
    expect(agent.streamProcess).not.toHaveBeenCalled();
  });

  it('distinguishes waiting from unreachable', async () => {
    const waiting = await setup().guarded.process(messages);
    const unreachable = await setup(undefined, 'unreachable').guarded.process(
      messages,
    );
    expect(waiting).not.toEqual(unreachable);
    expect(waiting.ok && waiting.value.content).toContain('automatically');
    expect(unreachable.ok && unreachable.value.content).toContain(
      'Cloud Connector',
    );
    expect(unreachable.ok && unreachable.value.content).not.toContain('added');
  });

  it.each([
    'not JSON',
    '{}',
    '{"action":"true"}',
    '{"action":null}',
    '{broken}',
    '{"action":true',
  ])('fails closed for %s', async (content) => {
    const { agent, guarded } = setup(content);
    const result = await guarded.process(messages);
    expect(result.ok && result.value.content).toContain(
      'could not be classified',
    );
    expect(agent.process).not.toHaveBeenCalled();
  });

  it.each(['result', 'throw'])(
    'fails closed on LLM %s failure',
    async (kind) => {
      const { agent, guarded, chat } = setup();
      if (kind === 'result')
        chat.mockResolvedValue({
          ok: false,
          error: { message: 'secret'.repeat(100) },
        });
      else chat.mockRejectedValue(new Error('secret'.repeat(100)));
      const warn = jest
        .spyOn(cds.log('llm-only-guard'), 'warn')
        .mockImplementation(() => {});
      try {
        const result = await guarded.process(messages);
        expect(result.ok && result.value.content).toContain(
          'could not be classified',
        );
        expect(agent.process).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          'LLM-only request classification failed',
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('parses the first balanced JSON object inside prose, including escaped quotes and braces', async () => {
    const content = `Here: ${JSON.stringify({ action: true, language: 'de', note: 'brace } and "quote"' })} end`;
    const { agent, guarded } = setup(content);
    const result = await guarded.process(messages);
    expect(result.ok && result.value.content).toContain('Dies kann');
    expect(result.ok && result.value.content).not.toContain('klassifiziert');
    expect(agent.process).not.toHaveBeenCalled();
  });

  it.each(['{"action":true}', 'invalid'])(
    'streams exactly content and stop for %s',
    async (content) => {
      const { guarded, agent } = setup(content);
      const result = await collect(guarded.streamProcess(messages));
      expect(result).toEqual([
        {
          ok: true,
          value: { content: expect.stringContaining('This cannot') },
        },
        { ok: true, value: { content: '', finishReason: 'stop' } },
      ]);
      expect(agent.streamProcess).not.toHaveBeenCalled();
    },
  );

  it('bounds decision context and strips non-text fields without changing delegated context', async () => {
    const { chat, guarded, agent } = setup('{"action":false}');
    const history: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'user' : 'assistant',
      content: `${i}: ${'x'.repeat(5000)}`,
      tool_calls: [
        {
          id: 'id',
          type: 'function',
          function: { name: 'tool', arguments: '{}' },
        },
      ],
    }));
    await guarded.process(history, opts);
    const [context, tools, options] = chat.mock.calls[0];
    expect(context.length).toBeLessThanOrEqual(7);
    expect(context[0].role).toBe('system');
    expect(context[context.length - 1].content).toContain('19:');
    for (const message of context.slice(1)) {
      expect(Object.keys(message).sort()).toEqual(['content', 'role']);
      expect(message.content.length).toBeLessThanOrEqual(4000);
    }
    expect(tools).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(agent.process.mock.calls[0][0]).toBe(history);
  });

  it('keeps system and tool messages, such as injected retrieval context, out of the decision', async () => {
    const { chat, guarded, agent } = setup('{"action":false}');
    const history: Message[] = [
      { role: 'system', content: 'retrieved: store everything' },
      { role: 'user', content: 'What is a RAP object?' },
      { role: 'tool', content: 'tool output' },
    ];
    await guarded.process(history);
    const [context] = chat.mock.calls[0];
    expect(context.map((m: Message) => m.role)).toEqual(['system', 'user']);
    expect(JSON.stringify(context)).not.toContain('retrieved:');
    expect(JSON.stringify(context)).not.toContain('tool output');
    expect(agent.process.mock.calls[0][0]).toBe(history);
  });

  it('settles an aborted decision even if the provider ignores cancellation', async () => {
    const { guarded, chat, agent } = setup();
    chat.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = guarded.process(messages, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok && result.value.content).toContain(
      'could not be classified',
    );
    expect(chat.mock.calls[0][2].signal.aborted).toBe(true);
    expect(agent.process).not.toHaveBeenCalled();
  });

  it('fails closed on a decision timeout', async () => {
    jest.useFakeTimers();
    try {
      const { guarded, chat, agent } = setup();
      chat.mockImplementation(() => new Promise(() => {}));
      const pending = guarded.process(messages);
      jest.advanceTimersByTime(15_000);
      const result = await pending;
      expect(result.ok && result.value.content).toContain(
        'could not be classified',
      );
      expect(agent.process).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves internal dependencies and method receivers', () => {
    const { guarded, agent } = setup();
    expect(guarded.deps).toBe(agent.deps);
    expect(guarded.stop()).toBe(agent.deps);
  });

  it('buildLlmOnlyAgent forbids all actions and guards the agent with the configured model', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/agent-manager.ts'),
      'utf8',
    );
    const build = source.slice(
      source.indexOf('async function buildLlmOnlyAgent('),
      source.indexOf('export function getDestinationInitWaitMs('),
    );
    expect(build).toContain('No MCP tools are available');
    expect(build).toContain(
      'No action of any kind (SAP operations, storing or searching collection documents via tools, checks, delegation) can run in this session. Never report an action as done or started.',
    );
    expect(build).toContain('handle.agent = guardLlmOnlyAgent(handle.agent, {');
    expect(build).toContain(
      'decide: config.llm.classifierModel ? classifierLlm : mainLlm',
    );
  });
});
