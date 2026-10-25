import type { StreamChunk } from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  type PlannerAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  DialogueTurnContext,
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

test.each([false, true])(
  'turn context clears after send settles (reject=%s)',
  async (reject) => {
    const context = new DialogueTurnContext();
    const process = jest.fn<
      ReturnType<PlannerAgent['process']>,
      Parameters<PlannerAgent['process']>
    >(async () => ({ ok: true as const, value: { content: 'ok' } }));
    const planner = plannerWithEnvironment(
      plannerWithRetrievedContext({ process }, context),
      () => 'Hub',
    );
    const input = [{ role: 'user' as const, content: 'hello' }];
    const sending = context.run('knowledge', async () => {
      for (let turn = 0; turn < 2; turn++) {
        await planner.process(input, {});
        const messages = process.mock.calls.at(-1)?.[0];
        expect(messages).toEqual([
          { role: 'user', content: '[environment]\nHub' },
          {
            role: 'user',
            content: expect.stringContaining('[retrieved context]'),
          },
          ...input,
        ]);
      }
      if (reject) throw new Error('aborted');
    });
    if (reject) await expect(sending).rejects.toThrow('aborted');
    else await sending;
    expect(context.text).toBeUndefined();
    await planner.process(input, {});
    expect(process.mock.calls.at(-1)?.[0]).toEqual([
      { role: 'user', content: '[environment]\nHub' },
      ...input,
    ]);
    expect(input).toEqual([{ role: 'user', content: 'hello' }]);
  },
);

test('settling an older request cannot clear an overlapping request context', async () => {
  const context = new DialogueTurnContext();
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const first = context.run(
    'first',
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  const second = context.run(
    'second',
    () =>
      new Promise<void>((resolve) => {
        finishSecond = resolve;
      }),
  );
  finishFirst();
  await first;
  expect(context.text).toBe('second');
  finishSecond();
  await second;
  expect(context.text).toBeUndefined();
});
