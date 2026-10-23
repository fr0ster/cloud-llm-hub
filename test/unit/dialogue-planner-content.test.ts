import type { StreamChunk } from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  type PlannerAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  plannerWithEnvironment,
  plannerWithParagraphs,
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
