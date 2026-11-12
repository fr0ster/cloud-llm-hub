import { RagError } from '@mcp-abap-adt/llm-agent';
import { createHubRagAccess, initHubRagAccess } from '../../srv/lib/rag-access';
import { bindCaller, callOptionsFor } from '../../srv/lib/rag-caller';

beforeEach(() => initHubRagAccess(createHubRagAccess(null, 'in-memory')));

test('binds once and returns the caller', async () => {
  const access = createHubRagAccess(null, 'in-memory');
  initHubRagAccess(access);
  const bind = jest.spyOn(access.access.bindings, 'bind');
  const result = await bindCaller('s1', 'u1', true);
  expect(bind).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    ok: true,
    value: { sessionId: 's1', userId: 'u1', isAdmin: true },
  });
  if (!result.ok) throw result.error;
  expect(callOptionsFor(result.value).caller).toBe(result.value);
  expect(await bindCaller('s1', 'u1', true)).toEqual(result);
});

test('refuses rebinding to another user', async () => {
  await bindCaller('s1', 'u1', false);
  expect((await bindCaller('s1', 'u2', false)).ok).toBe(false);
});

test('refuses empty session and anonymous user', async () => {
  for (const [session, user] of [
    ['', 'u1'],
    ['s1', ''],
    ['s1', 'anonymous'],
  ])
    expect((await bindCaller(session, user, false)).ok).toBe(false);
});

test('a refused caller never reaches the agent', async () => {
  const agent = { process: jest.fn() };
  const result = await bindCaller('', 'u1', false);
  if (result.ok) agent.process('hello', callOptionsFor(result.value));
  expect(agent.process).not.toHaveBeenCalled();
});

test('maps store errors and exceptions to access denial', async () => {
  const access = createHubRagAccess(null, 'in-memory');
  initHubRagAccess({
    ...access,
    access: {
      ...access.access,
      bindings: {
        getUserId: access.access.bindings.getUserId.bind(
          access.access.bindings,
        ),
        bind: async () => ({
          ok: false,
          error: new RagError('store unavailable'),
        }),
      },
    },
  });
  expect((await bindCaller('s1', 'u1', false)).ok).toBe(false);
});

test('maps thrown store errors to access denial', async () => {
  const access = createHubRagAccess(null, 'in-memory');
  jest
    .spyOn(access.access.bindings, 'bind')
    .mockRejectedValue(new Error('Store failed'));
  initHubRagAccess(access);
  const result = await bindCaller('s1', 'u1', false);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected refusal');
  expect(result.error.code).toBe('RAG_ACCESS_DENIED');
});
