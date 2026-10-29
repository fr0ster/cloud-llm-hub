/**
 * The persistent record of each open long session, so that a hub restarted
 * after a crash can give a client presenting its key the hub session back.
 *
 * The record holds no secrets: owner, key, timestamps, TTL and destination.
 * Backends: SQLite (local runs, Docker with a volume) and the HANA / PG
 * provider the RAG backends use (CF, whose file system does not survive a
 * restart). `none` keeps no record.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type IRagBackendWriter,
  type IRagProvider,
  type IRagScanner,
  type IRetrievalEmbedder,
  isRagScanner,
  type RagScanFilter,
  type RagScanRecord,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { RagConfig } from '../agent-config';
import { ensureSessionRecordStore } from './collection-persistence';
import {
  createCollectionProvider,
  defaultCtors,
  PROVIDER_DEFAULT_DIMENSION,
  type RagCtors,
} from './rag-provider-factory';
import type { SessionConfig } from './session-config';

export {
  isSessionRecordStore,
  SESSION_RECORD_STORE_NAME,
} from './collection-persistence';

export interface SessionRecord {
  userId: string;
  key: string;
  createdAt: number;
  lastActivity: number;
  ttlMs: number;
  destination?: string;
  collectionOverrides?: Record<string, boolean>;
  closedAt?: number;
}

export interface SessionRecordStore {
  put(r: SessionRecord): Promise<void>;
  /** Writes only if lastActivity moved ≥ 60000 ms since the last write of that key. */
  touch(r: SessionRecord): Promise<void>;
  get(userId: string, key: string): Promise<SessionRecord | undefined>;
  delete(userId: string, key: string): Promise<void>;
  list(): Promise<SessionRecord[]>;
}

/** How far lastActivity must move before `touch` writes again. */
export const TOUCH_INTERVAL_MS = 60_000;

/** The record's own fields only: nothing else a caller passes is stored. */
function stored(r: SessionRecord): SessionRecord {
  return {
    userId: r.userId,
    key: r.key,
    createdAt: r.createdAt,
    lastActivity: r.lastActivity,
    ttlMs: r.ttlMs,
    ...(r.destination !== undefined ? { destination: r.destination } : {}),
    ...(r.collectionOverrides
      ? { collectionOverrides: { ...r.collectionOverrides } }
      : {}),
    ...(r.closedAt !== undefined ? { closedAt: r.closedAt } : {}),
  };
}

/** A stored record read back; undefined when it is not one. */
function decode(text: string): SessionRecord | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (
    typeof o.userId !== 'string' ||
    typeof o.key !== 'string' ||
    typeof o.createdAt !== 'number' ||
    typeof o.lastActivity !== 'number' ||
    typeof o.ttlMs !== 'number' ||
    (o.collectionOverrides !== undefined &&
      (!o.collectionOverrides ||
        typeof o.collectionOverrides !== 'object' ||
        Array.isArray(o.collectionOverrides) ||
        !Object.values(o.collectionOverrides).every(
          (value) => typeof value === 'boolean',
        ))) ||
    (o.destination !== undefined && typeof o.destination !== 'string') ||
    (o.closedAt !== undefined && typeof o.closedAt !== 'number')
  )
    return undefined;
  return stored(o as unknown as SessionRecord);
}

/** A key that is already another user's: its record is never replaced. */
export class SessionRecordOwnerError extends Error {
  constructor(key: string) {
    super(`session record "${key}" belongs to another user`);
    this.name = 'SessionRecordOwnerError';
  }
}

/**
 * What the backends share: writes of one key run one at a time (a promise
 * chain per key), a write never replaces another user's record, and the
 * `touch` throttle — per key, the lastActivity of the last record written; a
 * key never written by this process is written.
 */
abstract class SerialSessionRecordStore implements SessionRecordStore {
  private readonly collectionFlags = new Map<string, string>();
  private readonly destinations = new Map<string, string | undefined>();
  private readonly written = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();

  abstract get(userId: string, key: string): Promise<SessionRecord | undefined>;
  abstract list(): Promise<SessionRecord[]>;
  /** The user whose record holds `key`, of any owner; undefined when none. */
  protected abstract ownerOf(key: string): Promise<string | undefined>;
  protected abstract writeRecord(r: SessionRecord): Promise<void>;
  /** Removes the record of `userId` under `key`; whether there was one. */
  protected abstract deleteRecord(
    userId: string,
    key: string,
  ): Promise<boolean>;

  put(r: SessionRecord): Promise<void> {
    return this.serial(r.key, () => this.write(r));
  }

  /**
   * The threshold is checked inside the key's chain, so overlapping touches
   * see each other's writes: timestamp-only updates write once per minute;
   * a destination change always writes.
   */
  touch(r: SessionRecord): Promise<void> {
    return this.serial(r.key, async () => {
      const last = this.written.get(r.key);
      if (
        last !== undefined &&
        this.destinations.get(r.key) === r.destination &&
        this.collectionFlags.get(r.key) ===
          JSON.stringify(r.collectionOverrides) &&
        r.lastActivity - last < TOUCH_INTERVAL_MS
      )
        return;
      await this.write(r);
    });
  }

  delete(userId: string, key: string): Promise<void> {
    return this.serial(key, async () => {
      if (await this.deleteRecord(userId, key)) {
        this.written.delete(key);
        this.destinations.delete(key);
        this.collectionFlags.delete(key);
      }
    });
  }

  private async write(r: SessionRecord): Promise<void> {
    const owner = await this.ownerOf(r.key);
    if (owner !== undefined && owner !== r.userId)
      throw new SessionRecordOwnerError(r.key);
    await this.writeRecord(r);
    this.written.set(r.key, r.lastActivity);
    this.destinations.set(r.key, r.destination);
    this.collectionFlags.set(r.key, JSON.stringify(r.collectionOverrides));
  }

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const result = prev.then(run);
    const tail = result.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }
}

/**
 * `node:sqlite` is loaded on first use, so a Node without it fails only when
 * this store is selected.
 */
async function openSqlite(file: string): Promise<DatabaseSync> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch (err) {
    throw new Error(
      `LLM_AGENT_SESSION_STORE=sqlite needs node:sqlite, which Node ${process.version} does not provide: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(
    'CREATE TABLE IF NOT EXISTS sessions (user_id TEXT NOT NULL, key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (user_id, key))',
  );
  return db;
}

export class SqliteSessionRecordStore extends SerialSessionRecordStore {
  private opening?: Promise<DatabaseSync>;

  constructor(private readonly path: string) {
    super();
  }

  /** The database, opened on first use; a failed open is retried next call. */
  private db(): Promise<DatabaseSync> {
    if (!this.opening) {
      const run = openSqlite(this.path).catch((err) => {
        if (this.opening === run) this.opening = undefined;
        throw err;
      });
      this.opening = run;
    }
    return this.opening;
  }

  protected async ownerOf(key: string): Promise<string | undefined> {
    const db = await this.db();
    const row = db
      .prepare('SELECT user_id FROM sessions WHERE key = ? LIMIT 1')
      .get(key) as { user_id: string } | undefined;
    return row?.user_id;
  }

  protected async writeRecord(r: SessionRecord): Promise<void> {
    const db = await this.db();
    db.prepare(
      'INSERT INTO sessions (user_id, key, record) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET record = excluded.record',
    ).run(r.userId, r.key, JSON.stringify(stored(r)));
  }

  async get(userId: string, key: string): Promise<SessionRecord | undefined> {
    const db = await this.db();
    const row = db
      .prepare('SELECT record FROM sessions WHERE user_id = ? AND key = ?')
      .get(userId, key) as { record: string } | undefined;
    return row ? decode(row.record) : undefined;
  }

  protected async deleteRecord(userId: string, key: string): Promise<boolean> {
    const db = await this.db();
    const r = db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND key = ?')
      .run(userId, key);
    return Number(r.changes) > 0;
  }

  async list(): Promise<SessionRecord[]> {
    const db = await this.db();
    const rows = db.prepare('SELECT record FROM sessions').all() as {
      record: string;
    }[];
    return rows.flatMap((row) => decode(row.record) ?? []);
  }

  /** Close the database file (shutdown, tests). The next call opens it again. */
  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    if (opening) (await opening.catch(() => undefined))?.close();
  }
}

type PrecomputedWriter = IRagBackendWriter &
  Required<Pick<IRagBackendWriter, 'upsertPrecomputedRaw'>>;

interface OpenedRecordStore {
  scanner: IRagScanner;
  writer: PrecomputedWriter;
}

/** The record's row id in the provider store. */
function recordId(key: string): string {
  return `session:${key}`;
}

/**
 * The records in one cataloged store (`h_sessions`) of a HANA or PG provider.
 * A record is the JSON text of its row, written with a zero vector: it is
 * never searched, so it is never embedded.
 */
export class ProviderSessionRecordStore extends SerialSessionRecordStore {
  private opening?: Promise<OpenedRecordStore>;
  private readonly storePrefix?: string;
  private readonly zeroVector: number[];
  private readonly log?: { warn(m: string, d?: unknown): void };

  constructor(
    private readonly provider: IRagProvider,
    opts: {
      storePrefix?: string;
      dimension: number;
      log?: { warn(m: string, d?: unknown): void };
    },
  ) {
    super();
    this.storePrefix = opts.storePrefix;
    this.zeroVector = new Array<number>(opts.dimension).fill(0);
    this.log = opts.log;
  }

  /** The store, opened on first use; a failed open is retried next call. */
  private store(): Promise<OpenedRecordStore> {
    if (!this.opening) {
      const run = this.open().catch((err) => {
        if (this.opening === run) this.opening = undefined;
        throw err;
      });
      this.opening = run;
    }
    return this.opening;
  }

  private async open(): Promise<OpenedRecordStore> {
    const r = await ensureSessionRecordStore(this.provider, this.storePrefix);
    if (!r.ok) throw r.error;
    const rag = r.value;
    const name = this.provider.name;
    const writer = rag.writer?.();
    if (!writer)
      throw new Error(
        `the session record store of provider "${name}" has no writer`,
      );
    // Without a precomputed write the record would be embedded: refused.
    if (!writer.upsertPrecomputedRaw)
      throw new Error(
        `the session record store of provider "${name}" cannot write a precomputed vector (upsertPrecomputedRaw); session records are never embedded`,
      );
    if (!isRagScanner(rag))
      throw new Error(
        `the session record store of provider "${name}" cannot be scanned`,
      );
    return { scanner: rag, writer: writer as PrecomputedWriter };
  }

  /** Every row matching `filter`, across all scan pages. */
  private async scanAll(filter?: RagScanFilter): Promise<RagScanRecord[]> {
    const { scanner } = await this.store();
    const rows: RagScanRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await scanner.scan({
        ...(filter ? { filter } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (!page.ok) throw page.error;
      rows.push(...page.value.records);
      if (page.value.cursor !== undefined && page.value.cursor === cursor)
        throw new Error('the session record store scan did not advance');
      cursor = page.value.cursor;
    } while (cursor !== undefined);
    return rows;
  }

  private decodeRow(row: RagScanRecord): SessionRecord | undefined {
    const rec = decode(row.text);
    if (!rec || row.id !== recordId(rec.key)) {
      this.log?.warn('Skipped a malformed session record', { id: row.id });
      return undefined;
    }
    return rec;
  }

  /** The record row of `key`, of any owner. */
  private async recordOf(key: string): Promise<SessionRecord | undefined> {
    const rows = await this.scanAll({ sessionId: key });
    const row = rows.find((x) => x.id === recordId(key));
    return row && this.decodeRow(row);
  }

  protected async ownerOf(key: string): Promise<string | undefined> {
    return (await this.recordOf(key))?.userId;
  }

  protected async writeRecord(r: SessionRecord): Promise<void> {
    const { writer } = await this.store();
    const w = await writer.upsertPrecomputedRaw(
      recordId(r.key),
      JSON.stringify(stored(r)),
      this.zeroVector,
      { userId: r.userId, sessionId: r.key },
    );
    if (!w.ok) throw w.error;
  }

  async get(userId: string, key: string): Promise<SessionRecord | undefined> {
    const rows = await this.scanAll({ userId, sessionId: key });
    const row = rows.find((x) => x.id === recordId(key));
    const rec = row && this.decodeRow(row);
    return rec?.userId === userId ? rec : undefined;
  }

  /** Deletes only a record of `userId`: a key alone never reaches another user's. */
  protected async deleteRecord(userId: string, key: string): Promise<boolean> {
    if (!(await this.get(userId, key))) return false;
    const { writer } = await this.store();
    const d = await writer.deleteByIdRaw(recordId(key));
    if (!d.ok) throw d.error;
    return true;
  }

  async list(): Promise<SessionRecord[]> {
    return (await this.scanAll()).flatMap((row) => this.decodeRow(row) ?? []);
  }
}

/** The provider's embedder: a session record is never embedded. */
const neverEmbedded = async (): Promise<never> => {
  throw new Error('session records are never embedded');
};
const recordEmbedder: IRetrievalEmbedder = {
  embedDocument: neverEmbedded,
  embedQuery: neverEmbedded,
};

/**
 * The record store the configuration selects; undefined for `none`. HANA and
 * PG take the connection of the RAG backends (`rag`). `env` carries
 * VCAP_SERVICES; `ctors` is the test seam of the provider constructors.
 */
export function createSessionRecordStore(
  cfg: SessionConfig,
  rag: RagConfig,
  env: Record<string, string | undefined> = process.env,
  ctors: RagCtors = defaultCtors,
): SessionRecordStore | undefined {
  switch (cfg.store) {
    case 'none':
      return undefined;
    case 'sqlite':
      return new SqliteSessionRecordStore(cfg.storePath);
    case 'hana-vector':
    case 'pg-vector': {
      const provider = createCollectionProvider(
        rag,
        { retrieval: recordEmbedder },
        env,
        ctors,
        cfg.store,
      );
      if (!provider)
        throw new Error(`no provider for session store "${cfg.store}"`);
      // No store prefix: only Qdrant takes one, and it holds no records.
      const log = cds.log('session-store');
      return new ProviderSessionRecordStore(provider, {
        dimension: PROVIDER_DEFAULT_DIMENSION,
        log: { warn: (m, d) => log.warn(m, d) },
      });
    }
  }
}
