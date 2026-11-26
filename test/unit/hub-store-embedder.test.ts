import {
  InMemoryRagProvider,
  type IRagProvider,
  type RagCaller,
} from '@mcp-abap-adt/llm-agent';
import {
  PersistentHistoryStore,
  unwrap,
} from '../../srv/lib/collection-persistence';
import { assertHubStoresEmbedder } from '../../srv/lib/hub-store-embedder';
import { restampHubStores } from '../../srv/lib/hub-store-restamp';
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
import {
  COMMITTED_BUNDLE_FINGERPRINT,
  fingerprintHash,
} from '../../srv/lib/tool-corpus';
import { legacyProvider } from './helpers/legacy-history-provider';

const current = fingerprintHash(COMMITTED_BUNDLE_FINGERPRINT);

function newProvider(): InMemoryRagProvider {
  return new InMemoryRagProvider({
    name: 'hub-stores',
    supportedScopes: ['global', 'session'],
  });
}

async function createStore(
  provider: IRagProvider,
  name: string,
  embedder?: string,
) {
  return unwrap(
    await provider.createCollection(`prefix_${name}`, {
      scope: 'global',
      collectionName: name,
      ...(embedder === undefined ? {} : { attributes: { embedder } }),
    }),
    'create',
  );
}

test('passes when both embedded hub stores carry the current hash', async () => {
  const provider = newProvider();
  await createStore(provider, 'h_history', current);
  await createStore(provider, 'h_planner_memory', current);
  expect(await assertHubStoresEmbedder(provider, current)).toEqual({
    ok: true,
    value: undefined,
  });
});

test('passes when neither embedded hub store has been created', async () => {
  const provider = newProvider();
  expect((await assertHubStoresEmbedder(provider, current)).ok).toBe(true);
  await createStore(provider, 'h_planner_memory', current);
  expect((await assertHubStoresEmbedder(provider, current)).ok).toBe(true);
});

test('fails with EMBEDDER_MIGRATION_REQUIRED when the stamp is missing', async () => {
  const provider = newProvider();
  await createStore(provider, 'h_history');
  const result = await assertHubStoresEmbedder(provider, current);
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'EMBEDDER_MIGRATION_REQUIRED',
      message: `hub store "prefix_h_history" was embedded with "none", the current embedder is "${current}"; run npm run migrate:embeddings`,
    },
  });
});

test('fails when the stamp differs', async () => {
  const provider = newProvider();
  await createStore(provider, 'h_planner_memory', '111111111111');
  expect(await assertHubStoresEmbedder(provider, current)).toMatchObject({
    ok: false,
    error: {
      code: 'EMBEDDER_MIGRATION_REQUIRED',
      message: `hub store "prefix_h_planner_memory" was embedded with "111111111111", the current embedder is "${current}"; run npm run migrate:embeddings`,
    },
  });
});

test.each(['h_sessions', 'h_runs', 'h_trust', 'h_dialogue'])(
  'ignores the zero-vector hub store %s',
  async (name) => {
    const provider = newProvider();
    await createStore(provider, name);
    expect((await assertHubStoresEmbedder(provider, current)).ok).toBe(true);
  },
);

test.each(['h_history', 'h_planner_memory'])(
  'stamps the %s catalog record on create and the record on write',
  async (storeName) => {
    const provider = newProvider();
    const store = new PersistentHistoryStore(provider, undefined, {
      ...(storeName === 'h_history' ? {} : { storeName }),
      storePrefix: 'prefix',
      embedderFp: current,
    });
    unwrap(
      await store.writer().upsertRaw('one', 'text', { embedder: 'stale' }),
      'write',
    );

    const { records } = unwrap(await provider.describeCollections(), 'catalog');
    expect(records).toEqual([
      expect.objectContaining({
        name: storeName,
        attributes: expect.objectContaining({ embedder: current }),
      }),
    ]);
    const page = unwrap(await store.scan(), 'scan');
    expect(page.records[0].metadata.embedder).toBe(current);
  },
);

test('history writes stamp embedder on record metadata', async () => {
  const provider = newProvider();
  const caller: RagCaller = { sessionId: 's1', userId: 'u1', isAdmin: false };
  initHubRagAccess(createHubRagAccess(null, 'in-memory'));
  unwrap(
    await getHubRagAccess().access.bindings.bind(
      caller.sessionId,
      caller.userId,
    ),
    'bind',
  );
  const { rag } = unwrap(
    await provider.createCollection(historyCollectionName(caller.sessionId), {
      scope: 'session',
      sessionId: caller.sessionId,
    }),
    'create',
  );
  const writer = rag.writer?.();
  if (!writer) throw new Error('Missing writer');
  jest.spyOn(rag, 'writer').mockReturnValue(writer);
  const write = jest.spyOn(writer, 'upsertRaw');
  const history = new SessionHistoryRouter(provider, { embedderFp: current });

  expect(
    await history.recordTurn({
      caller,
      userText: 'hello',
      assistantText: 'hi',
    }),
  ).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0][2].embedder).toBe(current);
});

test('stamps shared history rows rewritten into per-session history', async () => {
  const provider = newProvider();
  initHubRagAccess(createHubRagAccess(null, 'in-memory'));
  const legacy = legacyProvider(
    [
      {
        id: 'one',
        text: 'text',
        metadata: { userId: 'u1', sessionId: 's1', owner: '["u1","s1"]' },
      },
    ],
    provider,
  );
  expect(unwrap(await migrateSharedHistory(legacy, current), 'move')).toEqual({
    moved: 1,
  });
  const { records } = unwrap(await provider.describeCollections(), 'catalog');
  const { rag } = unwrap(await provider.openCollection(records[0]), 'open');
  const row = unwrap(
    await rag.getById('one', { ragFilter: { sessionId: 's1' } }),
    'read',
  );
  expect(row?.metadata.embedder).toBe(current);
});

test('stamps planner memory records re-embedded by the owner restamp', async () => {
  const provider = newProvider();
  const { rag } = await createStore(provider, 'h_planner_memory');
  const writer = rag.writer?.();
  if (!writer) throw new Error('Missing writer');
  unwrap(await writer.upsertRaw('one', 'text', { hubSessionId: 's1' }), 'seed');

  expect(unwrap(await restampHubStores(provider, current), 'restamp')).toEqual({
    rewritten: 1,
  });
  const row = unwrap(await rag.getById('one'), 'read');
  expect(row?.metadata.embedder).toBe(current);
  expect((await assertHubStoresEmbedder(provider, current)).ok).toBe(false);
});
