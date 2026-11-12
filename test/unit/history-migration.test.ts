import {
  InMemoryRagProvider,
  type IRagProvider,
  type RagScanRecord,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  createHubRagAccess,
  getHubRagAccess,
  initHubRagAccess,
} from '../../srv/lib/rag-access';
import {
  historyCollectionName,
  migrateSharedHistory,
  SessionHistoryRouter,
} from '../../srv/lib/session-history-collection';

import { legacyProvider } from './helpers/legacy-history-provider';

test('migrated h_history turns are recalled in their session', async () => {
  initHubRagAccess(createHubRagAccess(null, 'in-memory'));
  const callers = ['s1', 's2'].map((sessionId) => ({
    userId: 'u1',
    sessionId,
    isAdmin: false,
  }));
  for (const caller of callers)
    await getHubRagAccess().access.bindings.bind(
      caller.sessionId,
      caller.userId,
    );
  const provider = legacyProvider(
    callers.map((caller) => ({
      id: caller.sessionId,
      text: `User: earlier\nAssistant: ${caller.sessionId}`,
      metadata: {
        owner: JSON.stringify([caller.userId, caller.sessionId]),
        userId: caller.userId,
        sessionId: caller.sessionId,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    })),
  );
  expect(await migrateSharedHistory(provider)).toEqual({
    ok: true,
    value: { moved: 2 },
  });
  expect(await migrateSharedHistory(provider)).toEqual({
    ok: true,
    value: { moved: 0 },
  });
  const router = new SessionHistoryRouter(provider);
  const result = await router.query(new TextOnlyEmbedding('earlier'), 10, {
    caller: callers[0],
    sessionId: 's1',
  });
  if (!result.ok) throw result.error;
  expect(result.value).toHaveLength(1);
  expect(result.value[0].text).toBe('User: earlier\nAssistant: s1');
  expect(result.value[0].metadata).toMatchObject({
    ownerScope: 'session',
    sessionId: 's1',
    authorUserId: 'u1',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  expect(result.value[0].metadata).not.toHaveProperty('userId');
  expect(result.value[0].metadata).not.toHaveProperty('owner');
  const catalog = await provider.describeCollections?.();
  expect(
    catalog?.ok && catalog.value.records.map((record) => record.name).sort(),
  ).toEqual(
    callers.map((caller) => historyCollectionName(caller.sessionId)).sort(),
  );
});

test('an unresolved legacy identity leaves the shared history intact', async () => {
  const provider = legacyProvider([
    { id: 'orphan', text: 'preserve me', metadata: { userId: 'u1' } },
  ]);
  const result = await migrateSharedHistory(provider);
  expect(result.ok).toBe(false);
  const catalog = await provider.describeCollections?.();
  expect(
    catalog?.ok && catalog.value.records.map((record) => record.name),
  ).toContain('h_history');
});

test('a legacy session with conflicting users is refused before copying any rows', async () => {
  const provider = legacyProvider(
    ['u1', 'u2'].map((userId) => ({
      id: userId,
      text: 'private',
      metadata: {
        userId,
        sessionId: 'shared-legacy-session',
        owner: JSON.stringify([userId, 'shared-legacy-session']),
      },
    })),
  );
  const result = await migrateSharedHistory(provider);
  expect(result.ok).toBe(false);
  const catalog = await provider.describeCollections?.();
  expect(
    catalog?.ok && catalog.value.records.map((record) => record.name),
  ).toEqual(['h_history']);
});

test('all invalid owner tuples are reported before any valid row is copied', async () => {
  const metadata = { userId: 'u1', sessionId: 's1', owner: '["u1","s1"]' };
  const provider = legacyProvider([
    { id: 'valid', text: 'private', metadata },
    ...[
      { ...metadata, owner: '["u1","s2"]' },
      { ...metadata, owner: '["u2","s1"]' },
      { ...metadata, owner: 'broken' },
      { userId: 'u1', sessionId: 's1' },
      { owner: metadata.owner, sessionId: 's1' },
      { owner: metadata.owner, userId: 'u1' },
    ].map((metadata, index) => ({
      id: `invalid-${index}`,
      text: 'private',
      metadata,
    })),
  ]);
  const result = await migrateSharedHistory(provider);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected rejection');
  for (let index = 0; index < 6; index++)
    expect(result.error.message).toContain(`invalid-${index}`);
  const catalog = await provider.describeCollections?.();
  expect(
    catalog?.ok && catalog.value.records.map((record) => record.name),
  ).toEqual(['h_history']);
});

test.each(['conflict', 'unbound', 'error'])(
  'migration preflights session bindings: %s',
  async (scenario) => {
    initHubRagAccess(createHubRagAccess(null, 'in-memory'));
    const bindings = getHubRagAccess().access.bindings;
    if (scenario === 'conflict') await bindings.bind('legacy-session', 'bob');
    const provider = legacyProvider(
      ['clean-session', 'legacy-session'].map((sessionId) => ({
        id: sessionId,
        text: 'private record contents',
        metadata: {
          userId: 'alice',
          sessionId,
          owner: JSON.stringify(['alice', sessionId]),
        },
      })),
    );
    const get =
      scenario === 'error'
        ? jest
            .spyOn(bindings, 'getUserId')
            .mockRejectedValue(new Error('private store error'))
        : undefined;
    const result = await migrateSharedHistory(provider);
    get?.mockRestore();
    const catalog = await provider.describeCollections?.();
    if (scenario === 'unbound') {
      expect(result).toEqual({ ok: true, value: { moved: 2 } });
      expect(await bindings.getUserId('legacy-session')).toEqual({
        ok: true,
        value: 'alice',
      });
    } else {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected refusal');
      expect(result.error.message).toContain('legacy-session');
      expect(result.error.message).not.toContain('private');
      expect(
        catalog?.ok && catalog.value.records.map((record) => record.name),
      ).toEqual(['h_history']);
    }
  },
);
