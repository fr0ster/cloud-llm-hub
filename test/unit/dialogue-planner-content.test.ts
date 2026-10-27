import type { StreamChunk } from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  type PlannerAgent,
  PlannerToolsClient,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  plannerWithEnvironment,
  plannerWithParagraphs,
  plannerWithRetrievedContext,
} from '../../srv/lib/dialogue-planner-content';

test('wrappers preserve paragraph content when DialogueSession buffers content partials', async () => {
  const seen: StreamChunk[] = [];
  const planner: PlannerAgent = {
    async process(_input, options) {
      options.onPartial?.({ kind: 'content', delta: 'Before.' });
      options.onPartial?.({
        kind: 'mcp-call',
        source: { stepperId: 's', name: 'tool' },
        tool: 'list_tasks',
      });
      options.onPartial?.({ kind: 'content', delta: 'After.' });
      return { ok: true, value: { content: 'Before.After.' } };
    },
  };
  const session = await DialogueSession.open({
    id: 'buffered',
    planner: plannerWithEnvironment(
      plannerWithParagraphs(planner),
      () => 'Hub',
    ),
    board: { workers: new Map(), maxConcurrent: 1 },
  });
  try {
    const reply = await session.send('hello', {
      onPartial: (chunk) => seen.push(chunk),
    });
    expect(reply.text).toBe('Before.\n\nAfter.');
    expect(seen.map((chunk) => chunk.kind)).toEqual([
      'mcp-call',
      'content',
      'content',
    ]);
    expect(
      seen
        .filter((chunk) => chunk.kind === 'content')
        .map((chunk) => chunk.delta)
        .join(''),
    ).toBe(reply.text);
  } finally {
    await session.close();
  }
});

test('environment reaches user and event turns without changing persisted conversation', async () => {
  const process = jest.fn(async () => ({
    ok: true as const,
    value: { content: 'ok' },
  }));
  const planner = plannerWithEnvironment(
    { process },
    () => 'Destination: DEV\nLogin: USER',
  );
  for (const content of ['which system?', '[events]\ntask completed']) {
    const conversation = [{ role: 'user' as const, content }];
    await planner.process(conversation, {});
    expect(process.mock.calls.at(-1)).toEqual([
      [
        {
          role: 'user',
          content: '[environment]\nDestination: DEV\nLogin: USER',
        },
        ...conversation,
      ],
      {},
    ]);
    expect(conversation).toEqual([{ role: 'user', content }]);
  }
});

test.each([undefined, jest.fn()])(
  'planner assembles tool boundaries for event and streamed turns',
  async (onPartial) => {
    const planner: PlannerAgent = {
      process: async (_input, options) => {
        options.onPartial?.({ kind: 'content', delta: 'Before.' });
        options.onPartial?.({
          kind: 'mcp-call',
          source: { stepperId: 's', name: 'tool' },
          tool: 'list_tasks',
        });
        options.onPartial?.({ kind: 'content', delta: '' });
        options.onPartial?.({ kind: 'content', delta: 'After.' });
        return { ok: true, value: { content: 'Before.After.' } };
      },
    };
    const result = await plannerWithParagraphs(planner).process([], {
      onPartial,
    });
    expect(result).toEqual({
      ok: true,
      value: { content: 'Before.\n\nAfter.' },
    });
    if (onPartial)
      expect(
        onPartial.mock.calls
          .filter(([c]) => c.kind === 'content')
          .map(([c]) => c.delta)
          .join(''),
      ).toBe('Before.\n\nAfter.');
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('queued user context stays out of an active event and its corrections', async () => {
  const contexts = new WeakMap<object, string>();
  const trace = { traceId: 'queued' };
  const entered = deferred();
  const release = deferred();
  const calls: Array<{ input: string; trace: unknown }> = [];
  const session = await DialogueSession.open({
    id: 'queued-context',
    maxCorrections: 1,
    planner: plannerWithRetrievedContext(
      {
        async process(input, options) {
          if (input.at(-1)?.content?.endsWith('seed')) {
            await new PlannerToolsClient().callTool('delegate_task', {
              worker: 'executor',
              goal: 'event',
            });
            return { ok: true, value: { content: 'seeded' } };
          }
          calls.push({ input: JSON.stringify(input), trace: options.trace });
          if (calls.length === 1) {
            await new PlannerToolsClient().callTool('update_plan', {
              steps: [{ id: 'read', goal: 'Read' }],
              status: 'active',
            });
            entered.resolve();
            await release.promise;
          }
          return { ok: true, value: { content: 'answer' } };
        },
      },
      contexts,
    ),
    board: {
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            description: 'test',
            capabilities: { contextPolicy: 'optional' as const },
            async run() {
              return { output: 'done' };
            },
          },
        ],
      ]),
    },
  });
  try {
    await session.send('seed');
    await entered.promise;
    contexts.set(trace, 'knowledge');
    const sending = session
      .send('hello', { trace })
      .finally(() => contexts.delete(trace));
    release.resolve();
    await sending;
    expect(calls).toHaveLength(4);
    for (const call of calls.slice(0, 2)) {
      expect(call.trace).toBeUndefined();
      expect(call.input).not.toContain('[retrieved context]');
    }
    for (const call of calls.slice(2)) {
      expect(call.trace).toBe(trace);
      expect(call.input).toContain('[retrieved context]');
      expect(call.input).toContain('knowledge');
    }
    expect(contexts.has(trace)).toBe(false);
    expect(JSON.stringify(session.snapshot())).not.toContain('knowledge');
  } finally {
    release.resolve();
    await session.close();
  }
});

test('event drained immediately after a user send has no retrieved context', async () => {
  const contexts = new WeakMap<object, string>();
  const trace = { traceId: 'finished' };
  const eventDone = deferred();
  const workerDone = deferred();
  const calls: Array<{ input: string; trace: unknown; associated: boolean }> =
    [];
  const session = await DialogueSession.open({
    id: 'finished-context',
    maxCorrections: 0,
    planner: plannerWithRetrievedContext(
      {
        async process(input, options) {
          calls.push({
            input: JSON.stringify(input),
            trace: options.trace,
            associated: contexts.has(trace),
          });
          if (calls.length === 1) {
            await new PlannerToolsClient().callTool('delegate_task', {
              worker: 'executor',
              goal: 'event',
            });
            await workerDone.promise;
          }
          return { ok: true, value: { content: 'answer' } };
        },
      },
      contexts,
    ),
    onMessage() {
      eventDone.resolve();
    },
    board: {
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            description: 'test',
            capabilities: { contextPolicy: 'optional' as const },
            async run() {
              workerDone.resolve();
              return { output: 'done' };
            },
          },
        ],
      ]),
    },
  });
  try {
    contexts.set(trace, 'knowledge');
    await session
      .send('hello', { trace })
      .finally(() => contexts.delete(trace));
    await eventDone.promise;
    expect(calls).toHaveLength(2);
    expect(calls[0].input).toContain('[retrieved context]');
    expect(calls[1].trace).toBeUndefined();
    expect(calls[1].associated).toBe(true);
    expect(calls[1].input).not.toContain('[retrieved context]');
  } finally {
    await session.close();
  }
});

test('retrieval uses trace identity and preserves temporary input order', async () => {
  const contexts = new WeakMap<object, string>();
  const trace = { traceId: 'same-id' };
  contexts.set(trace, 'knowledge');
  const process = jest.fn<
    ReturnType<PlannerAgent['process']>,
    Parameters<PlannerAgent['process']>
  >(async () => ({ ok: true, value: { content: 'ok' } }));
  const planner = plannerWithEnvironment(
    plannerWithRetrievedContext({ process }, contexts),
    () => 'Hub',
  );
  const input = [{ role: 'user' as const, content: 'hello' }];
  await planner.process(input, { trace });
  expect(process.mock.calls.at(-1)?.[0]).toEqual([
    { role: 'user', content: '[environment]\nHub' },
    { role: 'user', content: expect.stringContaining('[retrieved context]') },
    ...input,
  ]);
  for (const options of [{}, { trace: { ...trace } }]) {
    await planner.process(input, options);
    expect(JSON.stringify(process.mock.calls.at(-1)?.[0])).not.toContain(
      '[retrieved context]',
    );
  }
  expect(input).toEqual([{ role: 'user', content: 'hello' }]);
});

test('all planner wrappers forward stopSignal to SmartAgent.process', async () => {
  const { SmartAgent } = await import('@mcp-abap-adt/llm-agent-libs');
  const process = jest
    .spyOn(SmartAgent.prototype, 'process')
    .mockResolvedValue({
      ok: true,
      value: {
        content: 'waiting',
        iterations: 1,
        toolCallCount: 0,
        stopReason: 'stop',
      },
    });
  try {
    const agent: InstanceType<typeof SmartAgent> = Object.create(
      SmartAgent.prototype,
    );
    const contexts = new WeakMap<object, string>();
    const trace = { traceId: 'wait' };
    contexts.set(trace, 'context');
    const planner = plannerWithEnvironment(
      plannerWithRetrievedContext(plannerWithParagraphs(agent), contexts),
      () => 'Hub',
    );
    const stopSignal = new AbortController().signal;
    await planner.process([], { stopSignal, trace });
    expect(process).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ stopSignal }),
    );
    expect(process.mock.calls[0][1]?.stopSignal).toBe(stopSignal);
  } finally {
    process.mockRestore();
  }
});
