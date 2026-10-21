jest.mock('../../srv/agent-manager', () => ({ isProvidersReady: () => false }));

import type { RunRecord } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import * as stores from '../../srv/lib/run-record-store';
import { clearSessionConfig } from '../../srv/lib/session-config';
import { runWithSessionId } from '../../srv/request-session';
import { startPglite } from './helpers/pglite';

jest.setTimeout(120_000);
const record: RunRecord = {
  runId: 'r',
  request: 'secret',
  plan: { steps: [], createdAt: 1 },
  steps: [],
  outcome: 'answered',
  finishedAt: 2,
};
const scoped = <T>(user: string, session: string, fn: () => T) =>
  runWithSessionId(session, fn, [], user);
let pgl: Awaited<ReturnType<typeof startPglite>>;
let client: Awaited<ReturnType<typeof createPgClient>>;
let provider: PgVectorRagProvider;
let providerStore: stores.ProviderRunRecordStore;
let history: typeof import('../../srv/session-store');
const oldTtl = process.env.LLM_AGENT_SESSION_TTL_MS;
beforeAll(async () => {
  pgl = await startPglite({ dimension: 8 });
  client = await createPgClient({
    connectionString: pgl.url,
    credential: pgl.credential,
    collectionName: 'hub-collections',
  });
  provider = new PgVectorRagProvider({
    name: 'hub-collections',
    embedder: symmetricEmbedder({
      embed: async () => {
        throw new Error('never embedded');
      },
    }),
    connection: {
      collectionName: 'hub-collections',
      dimension: 8,
      schema: pgl.schema,
      layout: 'shared',
    },
    layout: 'shared',
    clientFactory: () => client,
  });
  // Longer run TTL proves the history timer actually deletes the row.
  providerStore = new stores.ProviderRunRecordStore(provider, {
    dimension: 8,
    ttlMs: 3_600_000,
  });
  process.env.LLM_AGENT_SESSION_TTL_MS = '1000';
  clearSessionConfig();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  history = require('../../srv/session-store');
});
afterAll(async () => {
  jest.useRealTimers();
  if (oldTtl === undefined) delete process.env.LLM_AGENT_SESSION_TTL_MS;
  else process.env.LLM_AGENT_SESSION_TTL_MS = oldTtl;
  clearSessionConfig();
  jest.restoreAllMocks();
  await client?.end();
  await pgl?.stop();
});
it.each(['memory', 'provider'])(
  'timer-driven plain-session expiry deletes the %s run record',
  async (kind) => {
    const store =
      kind === 'memory'
        ? new stores.MemoryRunRecordStore(10, 3_600_000)
        : providerStore;
    jest.spyOn(stores, 'getRunRecordStore').mockReturnValue(store);
    const deleted = jest.spyOn(store, 'delete');
    await scoped('alice', kind, () => store.save(kind, record));
    await scoped('bob', kind, () => store.save(kind, record));
    history.appendToSession(kind, 'alice', { role: 'user', content: 'hi' });
    expect(await scoped('alice', kind, () => store.load(kind))).toBeDefined();
    await jest.advanceTimersByTimeAsync(300_001);
    // Drain the asynchronous provider delete, then inspect without TTL expiry.
    await Promise.all(deleted.mock.results.map((r) => r.value));
    expect(deleted).toHaveBeenCalledWith('alice', kind);
    expect(await scoped('alice', kind, () => store.load(kind))).toBeUndefined();
    expect(await scoped('bob', kind, () => store.load(kind))).toBeDefined();
    deleted.mockRestore();
  },
);
it('provider TTL backstop deletes an expired record and preserves other users and sessions', async () => {
  const ttlStore = new stores.ProviderRunRecordStore(provider, {
    dimension: 8,
    ttlMs: 100,
  });
  await scoped('alice', 'ttl', () => ttlStore.save('ttl', record));
  await scoped('bob', 'ttl', () => ttlStore.save('ttl', record));
  jest.advanceTimersByTime(101);
  const deleted = jest.spyOn(ttlStore, 'delete');
  expect(
    await scoped('alice', 'ttl', () => ttlStore.load('ttl')),
  ).toBeUndefined();
  expect(deleted).toHaveBeenCalledWith('alice', 'ttl');
  await scoped('bob', 'ttl', () => ttlStore.save('ttl', record));
  await scoped('alice', 'other', () => ttlStore.save('other', record));
  expect(await scoped('bob', 'ttl', () => ttlStore.load('ttl'))).toEqual(
    record,
  );
  expect(await scoped('alice', 'other', () => ttlStore.load('other'))).toEqual(
    record,
  );
  expect(await ttlStore.load('ttl')).toBeUndefined();
});
