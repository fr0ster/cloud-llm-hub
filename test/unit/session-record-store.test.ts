/**
 * The long-session record store: the shared contract on SQLite (a temp file),
 * the factory per configured store, and the provider store's refusal of a
 * writer that cannot take a precomputed vector.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IRagProvider } from '@mcp-abap-adt/llm-agent';
import type { RagConfig } from '../../srv/agent-config';
import type { RagCtors } from '../../srv/lib/rag-provider-factory';
import type { SessionConfig } from '../../srv/lib/session-config';
import {
  createSessionRecordStore,
  ProviderSessionRecordStore,
  SqliteSessionRecordStore,
} from '../../srv/lib/session-record-store';
import {
  record,
  sessionRecordStoreContract,
} from './helpers/session-record-store-contract';

let dir: string;
let n = 0;
/** Every SQLite store opened here, closed before the temp dir goes (Windows). */
const opened: SqliteSessionRecordStore[] = [];
function sqliteStore(file: string): SqliteSessionRecordStore {
  const s = new SqliteSessionRecordStore(file);
  opened.push(s);
  return s;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'clh-sessions-'));
});

afterAll(async () => {
  for (const s of opened) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteSessionRecordStore', () => {
  sessionRecordStoreContract(async () => {
    n += 1;
    return sqliteStore(path.join(dir, `s${n}.db`));
  });

  it('creates the directory of its file', async () => {
    const file = path.join(dir, 'nested', 'deeper', 'sessions.db');
    const store = sqliteStore(file);
    await store.put(record());
    expect(existsSync(file)).toBe(true);
  });

  it('a second store on the same file reads what the first wrote', async () => {
    const file = path.join(dir, 'restart.db');
    const r = record();
    await sqliteStore(file).put(r);
    expect(await sqliteStore(file).get(r.userId, r.key)).toEqual(r);
  });
});

const sessionCfg = (store: SessionConfig['store']): SessionConfig => ({
  ttlMs: 3_600_000,
  maxSessions: 50,
  maxPerUser: 5,
  queueLength: 2,
  store,
  storePath: path.join(dir, 'factory', 'sessions.db'),
  plainApi: false,
  plainMcp: false,
});

const ragCfg: RagConfig = {
  embedder: null,
  backends: {
    tools: 'in-memory',
    session: 'pg-vector',
    persistent: 'pg-vector',
  },
  pg: { url: 'postgres://127.0.0.1:1/x', user: 'u', password: 'p' },
};

describe('createSessionRecordStore', () => {
  it("returns undefined for 'none'", () => {
    expect(
      createSessionRecordStore(sessionCfg('none'), ragCfg),
    ).toBeUndefined();
  });

  it("returns a SqliteSessionRecordStore for 'sqlite'", () => {
    expect(
      createSessionRecordStore(sessionCfg('sqlite'), ragCfg),
    ).toBeInstanceOf(SqliteSessionRecordStore);
  });

  it("builds the PG provider for 'pg-vector', with an embedder that refuses", async () => {
    const built: {
      kind: string;
      cfg: { embedder: { embedDocument(t: string): Promise<unknown> } };
    }[] = [];
    const ctor = (kind: string) =>
      function (this: unknown, cfg: never) {
        built.push({ kind, cfg });
      };
    const store = createSessionRecordStore(
      sessionCfg('pg-vector'),
      ragCfg,
      {},
      {
        HanaVectorRagProvider: ctor('hana'),
        PgVectorRagProvider: ctor('pg'),
        QdrantRagProvider: ctor('qdrant'),
      } as unknown as RagCtors,
    );
    expect(store).toBeInstanceOf(ProviderSessionRecordStore);
    expect(built.map((b) => b.kind)).toEqual(['pg']);
    await expect(built[0].cfg.embedder.embedDocument('x')).rejects.toThrow(
      'session records are never embedded',
    );
  });
});

describe('ProviderSessionRecordStore', () => {
  it('refuses a writer without upsertPrecomputedRaw, never embedding instead', async () => {
    const upsertRaw = jest.fn();
    const rag = {
      query: jest.fn(),
      getById: jest.fn(),
      healthCheck: jest.fn(),
      scan: jest.fn(),
      writer: () => ({ upsertRaw, deleteByIdRaw: jest.fn() }),
    };
    const provider = {
      name: 'no-precomputed',
      createCollection: async () => ({
        ok: true as const,
        value: { rag, editor: {} },
      }),
    } as unknown as IRagProvider;
    const store = new ProviderSessionRecordStore(provider, { dimension: 4 });
    await expect(store.put(record())).rejects.toThrow(/upsertPrecomputedRaw/);
    expect(upsertRaw).not.toHaveBeenCalled();
  });
});

it('persists override changes within the activity throttle and across restart', async () => {
  const file = path.join(dir, 'toggles.db');
  const store = sqliteStore(file);
  const r = { ...record(), collectionOverrides: { planning: false } };
  await store.put(r);
  await store.touch({ ...r, collectionOverrides: { planning: true } });
  const restarted = sqliteStore(file);
  expect((await restarted.get(r.userId, r.key))?.collectionOverrides).toEqual({
    planning: true,
  });
  await store.delete(r.userId, r.key);
  expect(await restarted.get(r.userId, r.key)).toBeUndefined();
});
