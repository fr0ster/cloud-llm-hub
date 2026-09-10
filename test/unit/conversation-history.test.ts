import { withConversationHistory } from '../../srv/agent-manager';
import { getRequestHistory, runWithSessionId } from '../../srv/request-session';

// The DAG coordinator composes each worker's prompt as a single string
// (`Task: …`). The agent reads a string as a lone message and an array as a
// conversation, so the turns the channel assembled stopped at the planner and
// every request looked like a first one: create a domain, then ask for a data
// element "from that domain", and the executor asks which domain.
describe('withConversationHistory', () => {
  const fakeAgent = () => {
    const seen: unknown[] = [];
    return {
      seen,
      agent: {
        process: async (input: unknown) => {
          seen.push(input);
          return { ok: true as const, value: { content: '' } };
        },
        other: () => 'untouched',
      } as never,
    };
  };

  const prior = [
    { role: 'user' as const, content: 'create domain ZDEMO_TEST' },
    { role: 'assistant' as const, content: 'created ZDEMO_TEST' },
  ];

  it('turns the composed string into the conversation it belongs to', async () => {
    const f = fakeAgent();
    const wrapped = withConversationHistory(f.agent);

    await runWithSessionId(
      's-1',
      () => wrapped.process('Task: make a data element from that domain'),
      prior,
    );

    expect(f.seen[0]).toEqual([
      ...prior,
      { role: 'user', content: 'Task: make a data element from that domain' },
    ]);
  });

  it('leaves an array alone — it already carries its own history', async () => {
    const f = fakeAgent();
    const wrapped = withConversationHistory(f.agent);
    const messages = [{ role: 'user' as const, content: 'hello' }];

    await runWithSessionId('s-1', () => wrapped.process(messages), prior);

    expect(f.seen[0]).toBe(messages);
  });

  it('passes a string through when there is no history to add', async () => {
    const f = fakeAgent();
    const wrapped = withConversationHistory(f.agent);

    // A worker running outside any request — startup warm-up — sees no turns.
    await wrapped.process('Task: something');

    expect(f.seen[0]).toBe('Task: something');
  });

  it('leaves every other member of the agent untouched', () => {
    const f = fakeAgent();
    const wrapped = withConversationHistory(f.agent) as unknown as {
      other: () => string;
    };
    expect(wrapped.other()).toBe('untouched');
  });

  it('scopes the history to the request', async () => {
    expect(getRequestHistory()).toEqual([]);
    await runWithSessionId(
      's-1',
      async () => {
        expect(getRequestHistory()).toEqual(prior);
      },
      prior,
    );
    expect(getRequestHistory()).toEqual([]);
  });
});
