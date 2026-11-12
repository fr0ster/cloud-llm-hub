import type { RagCaller, RagCollectionRef } from '@mcp-abap-adt/llm-agent';
import {
  createHubRagAccess,
  getHubRagAccess,
  hubAccessDecision,
  initHubRagAccess,
} from '../../srv/lib/rag-access';
import { testAccess } from './helpers/test-rag-access';

const caller: RagCaller = { sessionId: 's1', userId: 'u1', isAdmin: false };
const user: RagCollectionRef = {
  name: 'documents',
  owner: { scope: 'user', userId: 'u1' },
};
const global: RagCollectionRef = {
  name: 'documents',
  owner: { scope: 'global' },
};

test('hubAccessDecision allows reads', async () => {
  const decision = hubAccessDecision();
  expect(await decision.canRead(caller, user)).toBe(true);
  expect(await decision.canRead(caller, global)).toBe(true);
});

test('global writes need MCP_Admin', async () => {
  const decision = hubAccessDecision();
  expect(await decision.canWrite(caller, global)).toBe(false);
  expect(await decision.canWrite({ ...caller, isAdmin: true }, global)).toBe(
    true,
  );
});

test('user and session writes are not admin-gated', async () => {
  const decision = hubAccessDecision();
  expect(await decision.canWrite(caller, user)).toBe(true);
  expect(
    await decision.canWrite(caller, {
      name: 'documents',
      owner: { scope: 'session', sessionId: 's1' },
    }),
  ).toBe(true);
});

test('in-memory kind gets durable-shaped stores', async () => {
  const { access } = createHubRagAccess(null, 'in-memory');
  expect((await access.bindings.bind('s1', 'u1')).ok).toBe(true);
  expect((await access.bindings.bind('s1', 'u2')).ok).toBe(false);
  expect(await access.bindings.getUserId('s1')).toEqual({
    ok: true,
    value: 'u1',
  });
});

test('hub access must be initialised before use', () => {
  expect(() => getHubRagAccess()).toThrow('Hub RagAccess is not initialised');
  const value = createHubRagAccess(null, 'in-memory');
  initHubRagAccess(value);
  expect(getHubRagAccess()).toBe(value);
  expect(value.access.roles).toBe(value.roleAdmin);
});

test('testAccess binds the supplied callers', async () => {
  const access = testAccess([caller]);
  expect(await access.bindings.getUserId(caller.sessionId)).toEqual({
    ok: true,
    value: caller.userId,
  });
  expect((await access.bindings.bind(caller.sessionId, 'u2')).ok).toBe(false);
});

test('hub access creates stores once on first use and resets on reinitialisation', () => {
  const value = createHubRagAccess(null, 'in-memory');
  const factory = jest.fn(() => value);
  initHubRagAccess(factory);
  expect(factory).not.toHaveBeenCalled();
  expect(getHubRagAccess()).toBe(value);
  expect(getHubRagAccess()).toBe(value);
  expect(factory).toHaveBeenCalledTimes(1);
  const replacement = createHubRagAccess(null, 'in-memory');
  initHubRagAccess(() => replacement);
  expect(getHubRagAccess()).toBe(replacement);
});

test.each(['pg-vector', 'qdrant', 'hana-vector'] as const)(
  '%s still rejects an invalid provider when access is used',
  (kind) => {
    initHubRagAccess(() => createHubRagAccess(null, kind));
    expect(() => getHubRagAccess()).toThrow(`${kind} requires a `);
  },
);
