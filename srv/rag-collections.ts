/**
 * RAG Collection Registry — manages dynamic RAG collections at runtime.
 *
 * Provides CRUD for collections and documents with:
 * - Built-in "facts" collection (long-term knowledge, always present)
 * - Dynamic user/admin collections (SAP notes, product docs, etc.)
 * - Namespace isolation (global vs per-user)
 *
 * The registry lives in this process: nothing is written to disk, and a
 * collection's data lives in its RAG backend. With a persistent backend
 * configured, user and session collections are also recorded in that
 * provider's catalog (lib/collection-persistence); presets never are. Those
 * are read back from the catalog at startup (see `ready`), and every method
 * touching one waits for that restore.
 *
 * Collections are wired into SmartAgent as additional RAG stores.
 */

import { randomUUID } from 'node:crypto';
import {
  type CallOptions,
  type CircuitBreaker,
  FallbackRag,
  filterActive,
  InMemoryRag,
  type IQueryEmbedding,
  type IRag,
  type IRagBackendWriter,
  type IRagEditor,
  type IRetrievalEmbedder,
  RagError,
  type Result,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  isPhysicalId,
  normalizeLogicalId,
  userCollectionId,
} from './collection-ids';
import {
  addPersistentDocument,
  COLLECTION_INCOMPATIBLE,
  COLLECTION_UNAVAILABLE,
  COLLECTIONS_UNAVAILABLE,
  type CollectionPersistence,
  type CollectionStatus,
  CollectionStatusError,
  canonicalCollectionMeta,
  deletePersistentDocument,
  type RestoreOutcome,
  type RestoreStatus,
  unwrap,
  updatePersistentDocument,
} from './lib/collection-persistence';
import { sessionConfig } from './lib/session-config';
import { storageSnapshots } from './lib/usage/storage-snapshot';
import {
  collectionUnknown,
  type StorageValues,
  storageEnabled,
} from './lib/usage/storage-values';

/** One session of one user, as a key (a tuple: no separator to collide on). */
function sessionKey(userId: string, sessionId: string): string {
  return JSON.stringify([userId, sessionId]);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * TTL for session-scoped RAG collections (ms): the session's one TTL
 * (`LLM_AGENT_SESSION_TTL_MS`). `RAG_SESSION_TTL_MS` still overrides it for
 * collections only; it is deprecated.
 */
export function sessionCollectionTtlMs(): number {
  return Number(process.env.RAG_SESSION_TTL_MS) || sessionConfig().ttlMs;
}

/**
 * Collection removals whose store the RAG backend did not delete or clear, since start.
 * The collections themselves were removed from the registry regardless.
 */
let removalFailures = 0;

export function collectionRemovalFailureCount(): number {
  return removalFailures;
}

/** Test seam. */
export function resetCollectionRemovalFailuresForTest(): void {
  removalFailures = 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported RAG backend types. Extensible — register custom factories. */
export type RagBackendType =
  | 'in-memory'
  | 'vector'
  | 'qdrant'
  | 'hana'
  | string;

/**
 * Creates the RAG store for one collection.
 *
 * `store` names that collection's own store, and is new every time a
 * collection is created: one re-created under the same id gets a different
 * name. The IRag returned must hold this collection's records and nothing else
 * — its query, getById and writer().clearAll() act on this store alone. A
 * backend over a shared server (Qdrant, HANA, Postgres) keeps a separate
 * physical collection or table under this name, adapted to its naming rules —
 * and deletes it through RagBackend.deleteStore. Removing a collection deletes
 * or clears its store, so a factory handing out one shared store would have
 * every removal wipe every collection.
 *
 * Also receives the shared embedder + breaker so backends can reuse them.
 */
export type RagBackendFactory = (ctx: {
  /** This collection's own store; unique per collection created. */
  store: string;
  embedder: IRetrievalEmbedder | null;
  breaker: CircuitBreaker | null;
}) => IRag;

/**
 * A RAG backend: how a collection's own store is created and, where stores are
 * physical resources, how one is deleted.
 */
export interface RagBackend {
  create: RagBackendFactory;
  /**
   * Delete a store itself, its data included: the Qdrant collection, the table.
   *
   * Required of a backend whose stores are physical resources. Every collection
   * created gets a new store, so emptying one and leaving it behind would pile
   * up an empty resource per collection. Without it, removal empties the store
   * with writer().clearAll() — enough for a store living in this process, which
   * goes with the collection. Same shape as llm-agent's
   * IRagProvider.deleteCollection.
   */
  deleteStore?(store: string): Promise<Result<void, RagError>>;
}

/** A store name for a collection being created: its id, and what makes this one new. */
function storeNameFor(collectionId: string): string {
  return `${collectionId}--${randomUUID().slice(0, 8)}`;
}

export interface CollectionMeta {
  id: string;
  logicalId: string;
  displayName: string;
  description: string;
  scope: 'user' | 'session';
  /** Marks a preset collection — enabled defaults to false until the user opts in. */
  preset?: boolean;
  /** RAG backend type for this collection (default: registry's defaultBackend) */
  backend?: RagBackendType;
  owner?: string; // userId for user-scoped collections
  /** Session id for session-scoped collections. */
  sessionId?: string;
  /** Expiry timestamp (ms since epoch) for session-scoped collections. */
  expiresAt?: number;
  createdAt: string;
  /** Number of records (== chunks for chunked uploads). */
  documentCount: number;
  /** Number of logical source documents — chunks of the same file count once. */
  sourceCount: number;
  /**
   * Set only on a persistent collection restored degraded; see
   * CollectionStatus. Absent: the collection works in full.
   */
  status?: CollectionStatus;
  /** Why, when `status` is set (names both fingerprints, or the cause). */
  statusError?: string;
}

export interface RagDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface StoredCollection {
  usageTextBytes?: number;
  meta: CollectionMeta;
  /** The store name its backend was created with; see RagBackendFactory. */
  store: string;
  /** The backend that created the store, asked to delete it on removal. */
  backend?: RagBackend;
  /** Held in the persistence provider's catalog; see CollectionPersistence. */
  persistent?: boolean;
  /** Set while a persistent deletion is out: writes are refused meanwhile. */
  deleting?: boolean;
  documents: Map<string, RagDocument>;
  rag: RecencyBoostedRag;
}

/**
 * Count logical source documents in a collection. Chunked uploads are grouped
 * by `(metadata.source, metadata.uploadId)` — every chunk of the SAME upload
 * counts once, but two separate uploads of the same filename count twice (they
 * carry distinct uploadIds; the export path keys on the same pair). Legacy
 * chunks that have `source` but no `uploadId` fall back to grouping by `source`
 * alone. Records without `metadata.source` (manually-added records) count
 * individually.
 */
function countSources(stored: StoredCollection): number {
  const groups = new Set<string>();
  let unmappedCount = 0;
  for (const doc of stored.documents.values()) {
    const meta = doc.metadata as
      | { source?: unknown; uploadId?: unknown }
      | undefined;
    const src = meta?.source;
    if (typeof src === 'string') {
      const uploadId = typeof meta?.uploadId === 'string' ? meta.uploadId : '';
      // NUL separator can't appear in a filename or uploadId, so it cannot
      // collide two distinct (source, uploadId) pairs into one key.
      groups.add(`${src}\u0000${uploadId}`);
    } else {
      unmappedCount++;
    }
  }
  return groups.size + unmappedCount;
}

// ---------------------------------------------------------------------------
// isTransient + tryWithRetry — retry helpers for embedder/RAG-write errors
// ---------------------------------------------------------------------------

/**
 * HTTP/status-context regex used by isTransient — matches "status 503",
 * "HTTP 502", "status code 429", "429 Too Many Requests",
 * "503 Service Unavailable", etc.
 * Deliberately does NOT match bare 3-digit numbers like "max length 500"
 * because that triggered false positives against UPSERT_ERROR-wrapped
 * validation errors.
 */
const TRANSIENT_HTTP_RE =
  /\b(?:status(?: code)?|http)\s*:?\s*(?:429|5\d\d)\b|\b429\s+too many requests\b|\b5\d\d\s+(?:bad gateway|service unavailable|gateway timeout|internal server error)\b/i;

const TRANSIENT_NETWORK_RE =
  /(rate[\s-]?limit|timeout|ECONNRESET|ETIMEDOUT|network)/i;

/**
 * Classify an embedder/RAG-write error as transient (worth retrying) or
 * permanent. Conservative: anything unrecognized is treated as permanent
 * so we don't burn retry budget on validation errors.
 *
 * Check order (first match wins):
 *  1. err.status / err.statusCode (429 or 5xx) → transient
 *  2. err.code === ETIMEDOUT or ECONNRESET → transient
 *  3. err.message matches an HTTP/status-context signal or a network
 *     keyword (rate-limit, timeout, ECONNRESET, ETIMEDOUT, network)
 *  4. everything else → permanent
 *
 * Today's RagError carries (message, code) only — no structured HTTP
 * fields — so for RagError instances step 3 is what gets used. Steps 1
 * and 2 are forward-compat for plain Error shapes from HTTP clients.
 */
export function isTransient(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as { message?: string })?.message ?? '';
  const code = (err as { code?: string })?.code ?? '';
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { status?: number; statusCode?: number })?.statusCode ??
    0;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;
  if (TRANSIENT_HTTP_RE.test(msg)) return true;
  if (TRANSIENT_NETWORK_RE.test(msg)) return true;
  return false;
}

const RETRY_BACKOFFS_MS = [200, 500, 1500] as const;

/** How long a call waits for a restore in flight by default; see whenReady. */
export const READY_WAIT_MS = 30_000;

/** Max total ms a single bulk call may spend sleeping in retry backoff. */
export const RETRY_BUDGET_MS = 30_000;

export interface TryWithRetryOptions {
  /** Override the sleep function (tests inject a fake to avoid real waits). */
  sleep?: (ms: number) => Promise<void>;
  /** Predicate: may the helper sleep `delay` ms now? Defaults to () => true. */
  canSleep?: (delay: number) => boolean;
  /** Notification: account for a sleep that's about to happen. Defaults to noop. */
  onSleep?: (delay: number) => void;
}

/**
 * Run `fn`. On transient failure, retry with [200ms, 500ms, 1500ms] backoff
 * (max 3 retries, total worst-case ~2.2s of delay per failing call).
 * Returns `{ ok: true, value }` or `{ ok: false, error }`.
 *
 * `canSleep` / `onSleep` let a caller (e.g. addDocumentsBulk) impose a
 * shared retry-sleep budget across multiple invocations. When omitted the
 * helper is budget-naive.
 */
export async function tryWithRetry<T>(
  fn: () => Promise<T>,
  opts: TryWithRetryOptions = {},
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const canSleep = opts.canSleep ?? (() => true);
  const onSleep = opts.onSleep ?? (() => undefined);
  let lastErr: Error | undefined;
  for (let i = 0; i <= RETRY_BACKOFFS_MS.length; i += 1) {
    if (i > 0) {
      const delay = RETRY_BACKOFFS_MS[i - 1];
      onSleep(delay);
      await sleep(delay);
    }
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const isLast = i === RETRY_BACKOFFS_MS.length;
      const nextDelay = isLast ? 0 : RETRY_BACKOFFS_MS[i];
      if (!isTransient(lastErr) || isLast || !canSleep(nextDelay)) {
        return { ok: false, error: lastErr };
      }
    }
  }
  return {
    ok: false,
    error: lastErr ?? new Error('tryWithRetry: unreachable'),
  };
}

// ---------------------------------------------------------------------------
// RecencyBoostedRag — wraps IRag and boosts score of newer documents
// ---------------------------------------------------------------------------
// Formula: finalScore = baseScore * (1 + recencyBoost * recencyFactor)
// recencyFactor = 1.0 for just-created docs, decays to 0 over halfLifeMs.
// This ensures semantically relevant AND recent documents rank higher.
// ---------------------------------------------------------------------------

class RecencyBoostedRag implements IRag, IRagEditor {
  private inner: IRag;
  private recencyBoost: number;
  private halfLifeMs: number;

  constructor(
    inner: IRag,
    opts?: { recencyBoost?: number; halfLifeMs?: number },
  ) {
    this.inner = inner;
    this.recencyBoost = opts?.recencyBoost ?? 0.15; // up to 15% boost
    this.halfLifeMs = opts?.halfLifeMs ?? 7 * 24 * 3600_000; // 7 days
  }

  async upsert(
    text: string,
    metadata: Record<string, unknown>,
    options?: CallOptions,
  ) {
    // Stamp creation time in metadata for recency scoring
    if (!metadata._createdAtMs) {
      metadata._createdAtMs = Date.now();
    }
    const writer = this.inner.writer?.();
    if (!writer) throw new Error('Inner RAG is not editable');
    const { id: rawId, ...rest } = metadata;
    const id = typeof rawId === 'string' ? rawId : '';
    if (!id) throw new Error('metadata.id is required for upsert');
    const res = await writer.upsertRaw(id, text, rest, options);
    if (!res.ok) return res;
    return { ok: true as const, value: { id } };
  }

  async deleteById(id: string, options?: CallOptions) {
    const writer = this.inner.writer?.();
    if (!writer) throw new Error('Inner RAG is not editable');
    return writer.deleteByIdRaw(id, options);
  }

  async getById(id: string, options?: CallOptions) {
    return this.inner.getById(id, options);
  }

  writer(): IRagBackendWriter | undefined {
    return this.inner.writer?.();
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: { signal?: AbortSignal; ragFilter?: { namespace?: string } },
  ) {
    // Fetch more results to allow re-ranking
    const result = await this.inner.query(
      embedding,
      Math.max(k * 2, 20),
      options,
    );
    if (!result.ok) return result;

    // Drop superseded/deprecated entries — they stay in the store as audit trail
    // but must not surface to the LLM, otherwise rag_correct / rag_deprecate
    // would not be transparent at retrieval time. filterActive only inspects
    // `tags`; cast the metadata getter return so we don't need to widen
    // RagResult.metadata to CorrectionMetadata.
    const active = filterActive(result.value, (r) => r.metadata as never);

    const now = Date.now();
    result.value = active
      .map((r) => {
        const createdAt = (r.metadata?._createdAtMs as number) || 0;
        if (!createdAt) return r;
        const ageMs = now - createdAt;
        // Exponential decay: factor = 2^(-age/halfLife)
        const recencyFactor = 2 ** (-ageMs / this.halfLifeMs);
        const boostedScore = r.score * (1 + this.recencyBoost * recencyFactor);
        return { ...r, score: Math.min(boostedScore, 1) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return result;
  }

  async healthCheck() {
    return this.inner.healthCheck();
  }
}

/**
 * A collection as the agent searches it. The agent's `ragFilter` scopes tools
 * (`exposition`) and destination data (`namespace`); collection documents
 * carry neither, so passed on it would drop every one of them. Which
 * collections a caller reaches is decided before this, when the names are
 * resolved against the caller's own collections.
 */
export class CollectionSearchRag implements IRag {
  constructor(private readonly inner: IRag) {}

  query(embedding: IQueryEmbedding, k: number, options?: CallOptions) {
    const { ragFilter: _agentFilter, ...rest } = options ?? {};
    return this.inner.query(embedding, k, rest);
  }

  healthCheck(options?: CallOptions) {
    return this.inner.healthCheck(options);
  }

  getById(id: string, options?: CallOptions) {
    return this.inner.getById(id, options);
  }

  writer(): IRagBackendWriter | undefined {
    return this.inner.writer?.();
  }
}

/**
 * The order a persistent collection lists its documents in: by createdAt,
 * then id. A backend scan returns them in its own order (by id), so insertion
 * order would not survive a restart; this one does.
 */
function persistentOrder(docs: Iterable<RagDocument>): RagDocument[] {
  return [...docs].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.createdAt < b.createdAt
        ? -1
        : 1,
  );
}

/**
 * The store of a collection restored `unavailable`: its open failed, so every
 * call fails with that cause. The registry refuses those collections' document
 * operations before reaching it; this only keeps the entry's shape.
 */
function unavailableRag(reason: string): IRag {
  const fail = async () => ({
    ok: false as const,
    error: new RagError(reason, COLLECTION_UNAVAILABLE),
  });
  return { query: fail, getById: fail, healthCheck: fail };
}

// ---------------------------------------------------------------------------
// CollectionRegistry
// ---------------------------------------------------------------------------

/** Built-in backends. Their stores live in this process, so none deletes one. */
const builtInBackends: Record<string, RagBackend> = {
  'in-memory': { create: () => new InMemoryRag() },

  vector: {
    create: ({ embedder, breaker }) => {
      if (!embedder) return new InMemoryRag();
      const vectorRag = new VectorRag(embedder, {
        vectorWeight: 0.7,
        keywordWeight: 0.3,
      });
      return breaker
        ? new FallbackRag(vectorRag, new InMemoryRag(), breaker)
        : vectorRag;
    },
  },

  // Qdrant and HANA are placeholders — require external config at registration time.
  // Register via CollectionRegistry.registerBackend('qdrant', factory).
};

export class CollectionRegistry {
  private refreshStorageCache(meta: CollectionMeta): void {
    if (!storageEnabled() || !meta.owner) return;
    if (meta.scope === 'user') {
      storageSnapshots().trackUser?.(
        meta.owner,
        [...this.collections.values()].some(
          (stored: { meta: CollectionMeta }): boolean =>
            stored.meta.scope === 'user' && stored.meta.owner === meta.owner,
        ),
      );
      return;
    }
    if (!meta.sessionId) return;
    storageSnapshots().update?.(
      { userId: meta.owner, sessionId: meta.sessionId },
      this.storageMeasures(meta.owner, meta.sessionId),
    );
  }

  storageTargets(
    userId: string,
    sessionId?: string,
  ): { backend: string; store: string }[] {
    const targets: { backend: string; store: string }[] = [];
    for (const stored of this.collections.values()) {
      const meta = stored.meta;
      if (
        meta.preset ||
        meta.owner !== userId ||
        meta.scope !== (sessionId === undefined ? 'user' : 'session') ||
        (sessionId !== undefined && meta.sessionId !== sessionId)
      )
        continue;
      if (!stored.persistent || meta.status) return [];
      targets.push({
        backend: meta.backend ?? this.defaultBackend,
        store: stored.store,
      });
    }
    return targets;
  }

  /** Reads only metadata and write-time counters; never invokes a content API. */
  storageMeasures(userId: string, sessionId?: string): StorageValues {
    const prefix =
      sessionId === undefined ? 'userCollection' : 'sessionCollection';
    if (this.persistence && this.restoreState !== 'ready')
      return collectionUnknown(prefix);
    let documents = 0;
    let textBytes = 0;
    let textKnown = true;
    let vectorsKnown = true;
    const vectorBytes = 0;
    for (const stored of this.collections.values()) {
      const meta = stored.meta;
      if (
        meta.preset ||
        meta.owner !== userId ||
        meta.scope !== (sessionId === undefined ? 'user' : 'session') ||
        (sessionId !== undefined && meta.sessionId !== sessionId)
      )
        continue;
      if (meta.status) return collectionUnknown(prefix);
      documents += stored.documents.size;
      if (stored.usageTextBytes === undefined) textKnown = false;
      else textBytes += stored.usageTextBytes;
      // IRag does not expose physical vector count or dimension. In-memory has no vectors.
      if (meta.backend !== 'in-memory') vectorsKnown = false;
    }
    return {
      [`${prefix}Documents`]: documents,
      ...(textKnown
        ? { [`${prefix}TextBytes`]: textBytes }
        : { [`${prefix}TextBytesUnknown`]: true }),
      ...(vectorsKnown
        ? { [`${prefix}VectorBytes`]: vectorBytes }
        : { [`${prefix}VectorBytesUnknown`]: true }),
    };
  }

  private collections = new Map<string, StoredCollection>();
  private backends = new Map<string, RagBackend>(
    Object.entries(builtInBackends),
  );
  private defaultBackend: RagBackendType;
  private embedder: IRetrievalEmbedder | null;
  private breaker: CircuitBreaker | null;
  private log = cds.log('rag-collections');
  private enabledByUser: Map<string, Map<string, boolean>> = new Map();
  private persistence?: CollectionPersistence;
  /** Ids whose record is being deleted with no memory entry (catalog sweep). */
  private releasing = new Set<string>();
  /** Where the restore of persistent collections stands; see `ready`. */
  private restoreState: RestoreStatus['state'];
  /** The cause of the last failed restore attempt. */
  private restoreError?: string;
  /** The restore attempt in flight, if any. */
  private restoreAttempt?: Promise<void>;
  /** How long a call waits for a restore in flight; see whenReady. */
  private readyTimeoutMs: number;
  /** Creates in flight, by collection id; see getOrCreateCollection. */
  private creating = new Map<string, Promise<CollectionMeta>>();
  /**
   * Sessions removed while the restore was not ready (sessionKey). Their
   * session collections are not in memory yet, so the removal is recorded
   * here and applied by install. Cleared once a restore has installed.
   */
  private removedSessions = new Set<string>();

  constructor(opts?: {
    embedder?: IRetrievalEmbedder | null;
    breaker?: CircuitBreaker | null;
    /** Default backend for new collections (default: "vector" if embedder provided, else "in-memory") */
    defaultBackend?: RagBackendType;
    /**
     * Keeps user and session collections in the provider's catalog;
     * `defaultBackend` then names its kind, the only one a request may ask for.
     * Presets stay in this process.
     */
    persistence?: CollectionPersistence;
    /**
     * The longest a call waits for a restore in flight before it is refused
     * with 503 "collections unavailable: restore still in progress" (default
     * 30 s). The restore itself goes on.
     */
    readyTimeoutMs?: number;
  }) {
    this.embedder = opts?.embedder ?? null;
    this.breaker = opts?.breaker ?? null;
    this.defaultBackend =
      opts?.defaultBackend ?? (opts?.embedder ? 'vector' : 'in-memory');
    this.persistence = opts?.persistence;
    this.restoreState = this.persistence ? 'pending' : 'off';
    this.readyTimeoutMs = opts?.readyTimeoutMs ?? READY_WAIT_MS;
  }

  // -------------------------------------------------------------------------
  // Restore of persistent collections (spec §2.3, §6)
  // -------------------------------------------------------------------------

  /**
   * Settles once the persistent collections are restored into memory: at once
   * when nothing persists; rejects with a 503 CollectionStatusError
   * ("collections unavailable: <cause>") when the restore attempt fails.
   *
   * Taking it starts the restore if nothing has (the server starts it through
   * `retryRestore`, which also retries). Every registry method that touches a
   * persistent collection awaits it itself: while it is pending a call waits,
   * once it has failed a call is refused with that error until a retry
   * succeeds. Presets stay readable meanwhile (their documents, listing them
   * through listCollectionsOrPresets, a chat naming only presets through
   * heldPresetFor); a write to a preset waits for the restore, since a
   * restored collection under the same id would replace it.
   */
  get ready(): Promise<void> {
    return this.whenReady();
  }

  /** Where the restore stands, for /health. */
  restoreStatus(): RestoreStatus {
    return {
      state: this.restoreState,
      ...(this.restoreError ? { error: this.restoreError } : {}),
    };
  }

  /**
   * One restore attempt; concurrent calls share it, and a restored registry
   * resolves at once. Rejects with the 503 CollectionStatusError on failure.
   */
  restore(): Promise<void> {
    const persistence = this.persistence;
    if (!persistence || this.restoreState === 'ready') return Promise.resolve();
    if (this.restoreAttempt) return this.restoreAttempt;
    this.restoreState = 'restoring';
    const attempt = this.runRestore(persistence).finally(() => {
      this.restoreAttempt = undefined;
    });
    this.restoreAttempt = attempt;
    return attempt;
  }

  private async runRestore(persistence: CollectionPersistence): Promise<void> {
    let result: Awaited<ReturnType<CollectionPersistence['restore']>>;
    try {
      result = await persistence.restore();
    } catch (err) {
      result = {
        ok: false,
        error: new RagError(
          err instanceof Error ? err.message : String(err),
          'RAG_BACKEND_ERROR',
        ),
      };
    }
    if (!result.ok) {
      this.restoreState = 'failed';
      this.restoreError = result.error.message;
      throw this.unavailable();
    }
    this.install(persistence, result.value);
    this.restoreState = 'ready';
    this.restoreError = undefined;
  }

  /**
   * Put what a restore read back into memory, in one synchronous step. A
   * session collection whose session was removed while the restore was not
   * ready (a tombstone, see deleteSessionCollections) is not installed: its
   * record is deleted through the provider instead.
   */
  private install(
    persistence: CollectionPersistence,
    outcome: RestoreOutcome,
  ): void {
    for (const store of outcome.foreign)
      this.log.info('Foreign collection record left alone', { store });
    for (const r of outcome.rejected)
      this.log.warn('Unreadable collection record left alone', r);
    let degraded = 0;
    let removed = 0;
    for (const c of outcome.collections) {
      if (
        c.meta.scope === 'session' &&
        this.removedSessions.has(
          sessionKey(c.meta.owner ?? '', c.meta.sessionId ?? ''),
        )
      ) {
        removed++;
        void this.releaseRecord(persistence, c.meta);
        continue;
      }
      const held = this.collections.get(c.meta.id);
      if (held?.persistent) {
        this.log.warn('Restored collection already in memory; kept', {
          id: c.meta.id,
        });
        continue;
      }
      // A preset seeded while the restore ran, under the id of a persistent
      // collection the user owns: the stored collection wins, as it would
      // have before the restart (ensurePresets creates no preset over an
      // existing collection).
      if (held)
        this.log.warn('Preset replaced by the restored collection', {
          id: c.meta.id,
        });
      const documents = new Map(
        persistentOrder(c.documents).map((d) => [d.id, d]),
      );
      const meta = canonicalCollectionMeta({
        ...c.meta,
        backend: this.defaultBackend,
        documentCount: documents.size,
        ...(c.status ? { status: c.status, statusError: c.error } : {}),
      });
      const stored: StoredCollection = {
        meta,
        store: persistence.storeName(meta.id),
        persistent: true,
        documents,
        rag: new RecencyBoostedRag(c.rag ?? unavailableRag(c.error ?? '')),
      };
      if (storageEnabled())
        stored.usageTextBytes = c.documents.reduce(
          (total: number, doc: RagDocument): number =>
            total + Buffer.byteLength(doc.text, 'utf8'),
          0,
        );
      stored.meta.sourceCount = countSources(stored);
      this.collections.set(meta.id, stored);
      if (storageEnabled()) this.refreshStorageCache(meta);
      this.putEnabled(meta.owner ?? '', meta.id, c.enabled);
      if (c.status) {
        degraded++;
        this.log.warn('Collection restored degraded', {
          id: meta.id,
          status: c.status,
          error: c.error,
        });
      }
    }
    this.removedSessions.clear();
    this.log.info('Persistent collections restored', {
      collections: outcome.collections.length - removed,
      removedSessions: removed,
      degraded,
      foreign: outcome.foreign.length,
      rejected: outcome.rejected.length,
    });
  }

  /** The error every persistent operation gets while nothing is restored. */
  private unavailable(): CollectionStatusError {
    return new CollectionStatusError(
      'restore collections',
      new RagError(
        `collections unavailable: ${this.restoreError ?? 'not restored yet'}`,
        COLLECTIONS_UNAVAILABLE,
      ),
    );
  }

  private async whenReady(): Promise<void> {
    if (!this.persistence || this.restoreState === 'ready') return;
    if (this.restoreState === 'failed' && !this.restoreAttempt)
      throw this.unavailable();
    // Bounded: a restore that hangs (a stalled query, a long scan) answers
    // 503 instead of holding every request. The attempt itself goes on.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CollectionStatusError(
              'restore collections',
              new RagError(
                'collections unavailable: restore still in progress',
                COLLECTIONS_UNAVAILABLE,
              ),
            ),
          ),
        this.readyTimeoutMs,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([this.restore(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Wait for the restore before touching `id` — or, with no id, any collection.
   * A no-op when nothing persists.
   *
   * A collection held only in this process (a preset) needs no restore to be
   * read. A write to it does, while the restore is not ready: the restore may
   * hold a persistent collection under the same id, and install replaces the
   * preset with it. Waiting makes the write land on what install leaves under
   * that id, or be refused (503) when the restore fails or outlasts the wait —
   * never a 200 for a change install then throws away.
   */
  private async settled(id?: string, write = false): Promise<void> {
    if (!this.persistence) return;
    if (id !== undefined) {
      const stored = this.collections.get(id);
      if (stored && !stored.persistent) {
        if (!write || this.restoreState === 'ready') return;
      }
    }
    await this.whenReady();
  }

  /**
   * Refuse an operation a degraded collection cannot serve: everything on
   * documents of an `unavailable` one (503), search and document writes on an
   * `incompatible` one (409, naming both fingerprints).
   */
  private refuseDegraded(
    stored: StoredCollection,
    operation: string,
    kind: 'read' | 'search' | 'write',
  ): void {
    const status = stored.meta.status;
    if (!status) return;
    if (status === 'incompatible' && kind === 'read') return;
    throw new CollectionStatusError(
      operation,
      new RagError(
        stored.meta.statusError ??
          `collection "${stored.meta.id}" is ${status}`,
        status === 'incompatible'
          ? COLLECTION_INCOMPATIBLE
          : COLLECTION_UNAVAILABLE,
      ),
    );
  }

  /** The persistent backend kind, when collections persist; otherwise undefined. */
  persistentBackend(): RagBackendType | undefined {
    return this.persistence ? this.defaultBackend : undefined;
  }

  /**
   * Register a custom RAG backend (e.g. qdrant, hana). A bare factory is a
   * backend whose stores need no deleting; see RagBackend.deleteStore.
   */
  registerBackend(
    type: RagBackendType,
    backend: RagBackendFactory | RagBackend,
  ): void {
    this.backends.set(
      type,
      typeof backend === 'function' ? { create: backend } : backend,
    );
    this.log.info('RAG backend registered', { type });
  }

  /** List available backend types. */
  listBackends(): string[] {
    if (this.persistence) return [this.defaultBackend];
    return Array.from(this.backends.keys());
  }

  /** Create a collection's own RAG store, wrapped with recency boost. */
  private createRagStore(
    backend?: RagBackendType,
    store: string = storeNameFor('collection'),
  ): RecencyBoostedRag {
    const type = backend ?? this.defaultBackend;
    const impl = this.backends.get(type);
    if (!impl) {
      this.log.warn('Unknown RAG backend, falling back to in-memory', {
        requested: type,
        available: this.listBackends(),
      });
      return new RecencyBoostedRag(new InMemoryRag());
    }
    const base = impl.create({
      store,
      embedder: this.embedder,
      breaker: this.breaker,
    });
    return new RecencyBoostedRag(base);
  }

  // -------------------------------------------------------------------------
  // Collection CRUD
  // -------------------------------------------------------------------------

  async listCollections(userId?: string): Promise<CollectionMeta[]> {
    await this.settled();
    const result: CollectionMeta[] = [];
    for (const stored of this.collections.values()) {
      if (stored.meta.owner === userId) {
        result.push({
          ...stored.meta,
          documentCount: stored.documents.size,
          sourceCount: countSources(stored),
        });
      }
    }
    return result;
  }

  /**
   * listCollections, or — while the restore of persistent collections has
   * failed or is still running past the wait — the presets this process holds
   * for `userId`, with the cause in `unavailable`: presets stay usable, and
   * the persistent collections are reported unavailable, never silently left
   * out. Without persistence it is listCollections.
   */
  async listCollectionsOrPresets(
    userId?: string,
  ): Promise<{ collections: CollectionMeta[]; unavailable?: string }> {
    try {
      return { collections: await this.listCollections(userId) };
    } catch (err) {
      if (
        !(err instanceof CollectionStatusError) ||
        err.cause.code !== COLLECTIONS_UNAVAILABLE
      )
        throw err;
      const collections: CollectionMeta[] = [];
      for (const stored of this.collections.values())
        if (
          !stored.persistent &&
          stored.meta.preset &&
          stored.meta.owner === userId
        )
          collections.push({
            ...stored.meta,
            documentCount: stored.documents.size,
            sourceCount: countSources(stored),
          });
      return { collections, unavailable: err.message };
    }
  }

  /**
   * The preset a chat entry (a logical name or a physical id) names for
   * `userId`, when this process holds it — or undefined. Lets a chat naming
   * only presets go on while the restore of persistent collections is not
   * ready; any other entry waits for the restore (or is refused with it).
   */
  heldPresetFor(entry: string, userId: string): string | undefined {
    if (!userId || userId === 'anonymous') return undefined;
    let id: string;
    try {
      id = isPhysicalId(entry)
        ? entry
        : userCollectionId(normalizeLogicalId(entry), userId);
    } catch {
      return undefined;
    }
    const stored = this.collections.get(id);
    return stored &&
      !stored.persistent &&
      stored.meta.preset &&
      stored.meta.owner === userId
      ? id
      : undefined;
  }

  async getCollection(id: string): Promise<CollectionMeta | null> {
    await this.settled(id);
    const stored = this.collections.get(id);
    if (!stored) return null;
    return {
      ...stored.meta,
      documentCount: stored.documents.size,
      sourceCount: countSources(stored),
    };
  }

  /**
   * The collection under `meta.id`, created from `meta` if there is none —
   * atomically: concurrent callers for one id share a single create and all
   * get the same collection; `created` is true for exactly one of them.
   *
   * Without persistence (and for a preset, which lives only in this process)
   * the check and the create happen in one synchronous step, as the callers'
   * check-then-create did before reads became async; a preset never waits for
   * the restore. A persistent one waits for the restore first, then the
   * check, the in-flight lookup and the start of the create are synchronous.
   */
  async getOrCreateCollection(
    meta: Omit<CollectionMeta, 'createdAt' | 'documentCount' | 'sourceCount'>,
  ): Promise<{ collection: CollectionMeta; created: boolean }> {
    if (this.persistence && !meta.preset) await this.whenReady();
    const existing = this.collections.get(meta.id);
    if (existing)
      return {
        collection: {
          ...existing.meta,
          documentCount: existing.documents.size,
          sourceCount: countSources(existing),
        },
        created: false,
      };
    const inFlight = this.creating.get(meta.id);
    if (inFlight) return { collection: await inFlight, created: false };
    const create = this.createCollection(meta);
    this.creating.set(meta.id, create);
    const forget = () => {
      if (this.creating.get(meta.id) === create) this.creating.delete(meta.id);
    };
    create.then(forget, forget);
    return { collection: await create, created: true };
  }

  /**
   * Create a collection. A persistent one (persistence on, not a preset) is in
   * the backend's catalog before it is in memory; the backend's refusal —
   * DuplicateCollectionError, OrphanStoreError included — reaches the caller
   * as a CollectionBackendError, and nothing is deleted in response.
   */
  async createCollection(
    meta: Omit<CollectionMeta, 'createdAt' | 'documentCount' | 'sourceCount'>,
  ): Promise<CollectionMeta> {
    // A persistent one may already be in the catalog: restore first.
    if (this.persistence && !meta.preset) await this.whenReady();
    if (this.collections.has(meta.id)) {
      throw new Error(`Collection "${meta.id}" already exists`);
    }
    const full: CollectionMeta = {
      ...meta,
      backend: meta.backend ?? this.defaultBackend,
      createdAt: new Date().toISOString(),
      documentCount: 0,
      sourceCount: 0,
    };
    if (this.persistence && !meta.preset) {
      return this.createPersistent(this.persistence, full, meta.backend);
    }
    // Presets stay in this process even when collections persist.
    if (this.persistence && !meta.backend)
      full.backend = this.embedder ? 'vector' : 'in-memory';
    const store = storeNameFor(meta.id);
    this.collections.set(meta.id, {
      meta: full,
      store,
      backend: this.backends.get(full.backend ?? this.defaultBackend),
      documents: new Map(),
      rag: this.createRagStore(full.backend, store),
    });
    if (storageEnabled()) {
      const stored = this.collections.get(meta.id);
      if (stored) stored.usageTextBytes = 0;
      this.refreshStorageCache(full);
    }
    this.log.info('Collection created', { id: meta.id, scope: meta.scope });
    return full;
  }

  private async createPersistent(
    persistence: CollectionPersistence,
    full: CollectionMeta,
    requested: RagBackendType | undefined,
  ): Promise<CollectionMeta> {
    if (requested !== undefined && requested !== this.defaultBackend) {
      throw new Error(
        `Backend "${requested}" is not available: collections are stored on "${this.defaultBackend}"`,
      );
    }
    const handles = unwrap(
      await persistence.create(full, true),
      'create collection',
    );
    // One field order, the one a restore produces: see canonicalCollectionMeta.
    const meta = canonicalCollectionMeta(full);
    this.collections.set(meta.id, {
      meta,
      store: persistence.storeName(meta.id),
      persistent: true,
      documents: new Map(),
      rag: new RecencyBoostedRag(handles.rag),
    });
    if (storageEnabled()) {
      const stored = this.collections.get(meta.id);
      if (stored) stored.usageTextBytes = 0;
      this.refreshStorageCache(meta);
    }
    this.log.info('Collection created', { id: meta.id, scope: meta.scope });
    return meta;
  }

  /** The enabled flag a persistent record holds: its owner's. */
  private enabledOf(stored: StoredCollection): boolean {
    return this.getEnabled(stored.meta.owner ?? '', stored.meta.id) ?? true;
  }

  async updateCollection(
    id: string,
    update: Partial<Pick<CollectionMeta, 'displayName' | 'description'>>,
  ): Promise<CollectionMeta | null> {
    if (this.persistence) await this.settled(id, true);
    const stored = this.collections.get(id);
    if (!stored) return null;
    const apply = (m: CollectionMeta) => {
      if (update.displayName) m.displayName = update.displayName;
      if (update.description) m.description = update.description;
    };
    if (stored.persistent && this.persistence) {
      // Serialized with the collection's other record writes; see updateRecord.
      unwrap(
        await this.persistence.updateRecord(
          id,
          () => {
            const meta = { ...stored.meta };
            apply(meta);
            return { meta, enabled: this.enabledOf(stored) };
          },
          () => apply(stored.meta),
        ),
        'update collection',
      );
    } else apply(stored.meta);
    return {
      ...stored.meta,
      documentCount: stored.documents.size,
      sourceCount: countSources(stored),
    };
  }

  /**
   * Remove one collection, whatever backend holds it.
   *
   * It leaves the registry at once — its entry and every user's enabled flag —
   * so nothing can reach it again. Its store goes with it: deleted by a backend
   * whose stores are physical resources (RagBackend.deleteStore), otherwise
   * emptied through the RAG contract (`writer().clearAll()`). The store is this
   * collection's alone (see RagBackendFactory): removing it touches no other
   * collection, and a collection re-created under the same id gets a new store
   * that a removal still running cannot reach.
   * That is not retried: a failure is reported and counted, and at
   * worst leaves data in the backend that nothing points at (issue #234).
   * Never throws.
   */
  private removeCollection(id: string): Promise<void> | false {
    const stored = this.collections.get(id);
    if (!stored) return false;
    this.forget(id);
    if (!stored.persistent) return this.releaseStore(id, stored);
    // The record outlives the memory entry until the backend delete settles;
    // the catalog sweep must not start a second delete meanwhile.
    this.releasing.add(id);
    return this.releaseStore(id, stored).then(() => {
      this.releasing.delete(id);
    });
  }

  /** Drop a collection from memory: its entry and every user's enabled flag. */
  private forget(id: string): void {
    const meta = storageEnabled() ? this.collections.get(id)?.meta : undefined;
    this.collections.delete(id);
    if (meta) this.refreshStorageCache(meta);
    for (const m of this.enabledByUser.values()) m.delete(id);
  }

  /**
   * Delete a removed collection's store, or empty it where the backend deletes
   * none. A persistent one is deleted through the provider (record and rows).
   * Resolves once that has settled; never rejects.
   */
  private releaseStore(id: string, stored: StoredCollection): Promise<void> {
    const { store, backend, rag } = stored;
    let released: Promise<Result<void, RagError>> | undefined;
    try {
      if (stored.persistent && this.persistence) {
        released = this.persistence.remove(stored.meta);
      } else if (backend?.deleteStore) {
        released = backend.deleteStore(store);
      } else {
        released = rag.writer?.()?.clearAll?.();
      }
    } catch (err) {
      this.reportRemovalFailure(id, store, err);
      return Promise.resolve();
    }
    if (!released) {
      this.reportRemovalFailure(
        id,
        store,
        new Error('the RAG backend can neither delete nor clear a store'),
      );
      return Promise.resolve();
    }
    return released.then(
      (r) => {
        if (!r.ok) this.reportRemovalFailure(id, store, r.error);
      },
      (err: unknown) => this.reportRemovalFailure(id, store, err),
    );
  }

  private reportRemovalFailure(
    id: string,
    store: string,
    error: unknown,
  ): void {
    removalFailures++;
    this.log.warn('Collection removed, but its store could not be released', {
      id,
      store,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Delete a collection. A persistent one is deleted in the backend first and
   * leaves memory only once that succeeded: a failure throws a
   * CollectionBackendError and the collection stays (writes to it are refused
   * while the deletion is out).
   */
  async deleteCollection(id: string): Promise<boolean> {
    if (this.persistence) await this.settled(id, true);
    const stored = this.collections.get(id);
    if (stored?.persistent && this.persistence) {
      stored.deleting = true;
      try {
        unwrap(await this.persistence.remove(stored.meta), 'delete collection');
      } finally {
        stored.deleting = false;
      }
      if (this.collections.get(id) === stored) this.forget(id);
      this.log.info('Collection deleted', { id });
      return true;
    }
    const deleted = this.removeCollection(id) !== false;
    if (deleted) this.log.info('Collection deleted', { id });
    return deleted;
  }

  getEnabled(userId: string, physicalId: string): boolean | undefined {
    const stored = this.collections.get(physicalId);
    return this.enabledByUser
      .get(stored?.persistent ? (stored.meta.owner ?? '') : userId)
      ?.get(physicalId);
  }

  /**
   * A persistent collection's flag is one per collection, in its record: it
   * is written there first, whoever sets it (owner or admin), and then becomes
   * the owner's flag (and the caller's). A backend failure throws and leaves
   * the flag as it was.
   */
  async setEnabled(
    userId: string,
    physicalId: string,
    enabled: boolean,
  ): Promise<void> {
    if (this.persistence) await this.settled(physicalId, true);
    const stored = this.collections.get(physicalId);
    if (stored?.persistent && this.persistence) {
      unwrap(
        await this.persistence.updateRecord(
          physicalId,
          () => ({ meta: { ...stored.meta }, enabled }),
          () => {
            this.putEnabled(stored.meta.owner ?? '', physicalId, enabled);
            this.putEnabled(userId, physicalId, enabled);
          },
        ),
        'set enabled',
      );
      return;
    }
    this.putEnabled(userId, physicalId, enabled);
  }

  private putEnabled(userId: string, physicalId: string, enabled: boolean) {
    let m = this.enabledByUser.get(userId);
    if (!m) {
      m = new Map();
      this.enabledByUser.set(userId, m);
    }
    m.set(physicalId, enabled);
  }

  /**
   * Refresh the expiry timestamp of a session-scoped collection so it is not
   * swept while the session is still active. A persistent collection's record
   * carries the expiry, so it is rewritten too (serialized with its other
   * record writes); memory takes the new expiry only once the record has it,
   * so a restart never resurrects an earlier expiry than memory shows. A failed
   * write is logged, not thrown: the tool call that triggered it goes on, and
   * the next call tries again. Never rejects.
   */
  async refreshSessionExpiry(physicalId: string): Promise<void> {
    if (this.persistence) {
      try {
        await this.settled(physicalId);
      } catch {
        return; // Not restored: no collection to refresh; the caller goes on.
      }
    }
    const stored = this.collections.get(physicalId);
    if (stored?.meta.scope !== 'session') return;
    const expiresAt = Date.now() + sessionCollectionTtlMs();
    if (!(stored.persistent && this.persistence)) {
      stored.meta.expiresAt = expiresAt;
      return;
    }
    // Every tool call refreshes: skip a write that would move the expiry by
    // under a minute.
    if ((stored.meta.expiresAt ?? 0) >= expiresAt - 60_000) return;
    try {
      unwrap(
        await this.persistence.updateRecord(
          physicalId,
          () => ({
            meta: { ...stored.meta, expiresAt },
            enabled: this.enabledOf(stored),
          }),
          () => {
            stored.meta.expiresAt = expiresAt;
          },
        ),
        'refresh session expiry',
      );
    } catch (err) {
      this.log.warn('Session expiry could not be persisted', {
        id: physicalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Remove expired session collections.
   *
   * `maySweep` is asked about each collection's session in the same synchronous
   * pass that removes it, so nothing can take a lease on the session between
   * the answer and the removal. The stores are then released (a persistent
   * one through the provider); the promise settles once they all have, and
   * never rejects — a failure is counted, as in removeCollection.
   *
   * Memory goes first, so a backend delete that fails leaves its record behind.
   * With persistence on, a second pass reads the catalog for expired session
   * records that memory does not hold and deletes those, asking `maySweep` in
   * the same step that starts each delete. That is how a failed delete is
   * retried by the next sweep. The restore needs no special case: it loads
   * expired records into memory like any other, and the memory pass above
   * collects them.
   *
   * With persistence on, both passes wait for the restore; while it has
   * failed the sweep does nothing (logged) and the next one tries again.
   * Without persistence the memory pass runs within this call, as it always
   * did.
   */
  sweepExpiredSessions(
    maySweep: (userId: string, sessionId: string) => boolean = () => true,
  ): Promise<void> {
    if (!this.persistence) return this.sweepMemory(Date.now(), maySweep);
    const persistence = this.persistence;
    return this.whenReady().then(
      () => {
        const now = Date.now();
        return this.sweepMemory(now, maySweep).then(() =>
          this.sweepExpiredRecords(persistence, now, maySweep),
        );
      },
      (err: unknown) => {
        this.log.warn('Session collection sweep skipped', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }

  /** The memory pass of sweepExpiredSessions. Never rejects. */
  private sweepMemory(
    now: number,
    maySweep: (userId: string, sessionId: string) => boolean,
  ): Promise<void> {
    const released: Promise<void>[] = [];
    for (const [id, stored] of [...this.collections]) {
      if (
        stored.meta.scope === 'session' &&
        (stored.meta.expiresAt ?? 0) <= now &&
        maySweep(stored.meta.owner ?? '', stored.meta.sessionId ?? '')
      ) {
        const r = this.removeCollection(id);
        if (r) released.push(r);
      }
    }
    return Promise.all(released).then(() => undefined);
  }

  /** The catalog pass of sweepExpiredSessions. Never rejects. */
  private async sweepExpiredRecords(
    persistence: CollectionPersistence,
    now: number,
    maySweep: (userId: string, sessionId: string) => boolean,
  ): Promise<void> {
    try {
      const found = await persistence.expiredSessions(now);
      if (!found.ok) {
        this.log.warn('Expired session records could not be listed', {
          error: found.error.message,
        });
        return;
      }
      const released: Promise<void>[] = [];
      for (const meta of found.value) {
        // In memory: the pass above (or its owner) handles it. Being released:
        // a delete is already out.
        if (this.collections.has(meta.id) || this.releasing.has(meta.id))
          continue;
        if (!maySweep(meta.owner ?? '', meta.sessionId ?? '')) continue;
        released.push(this.releaseRecord(persistence, meta));
      }
      await Promise.all(released);
    } catch (err) {
      this.log.warn('Expired session record sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Delete the backend record of a collection memory does not hold. */
  private releaseRecord(
    persistence: CollectionPersistence,
    meta: CollectionMeta,
  ): Promise<void> {
    this.releasing.add(meta.id);
    const store = persistence.storeName(meta.id);
    return persistence.remove(meta).then(
      (r) => {
        this.releasing.delete(meta.id);
        if (!r.ok) this.reportRemovalFailure(meta.id, store, r.error);
      },
      (err: unknown) => {
        this.releasing.delete(meta.id);
        this.reportRemovalFailure(meta.id, store, err);
      },
    );
  }

  /**
   * Remove every collection of one session, from memory at once. Never throws;
   * see removeCollection. The promise settles once the stores are released.
   *
   * While the restore of persistent collections is not ready, the session's
   * persistent collections are not in memory yet: the removal is recorded (a
   * tombstone) and install deletes them through the provider instead of
   * installing them. Synchronous either way, for retention's lease guarantee.
   */
  deleteSessionCollections(userId: string, sessionId: string): Promise<void> {
    if (this.persistence && this.restoreState !== 'ready')
      this.removedSessions.add(sessionKey(userId, sessionId));
    const released: Promise<void>[] = [];
    for (const [id, stored] of [...this.collections]) {
      if (
        stored.meta.scope === 'session' &&
        stored.meta.owner === userId &&
        stored.meta.sessionId === sessionId
      ) {
        const r = this.removeCollection(id);
        if (r) released.push(r);
      }
    }
    return Promise.all(released).then(() => undefined);
  }

  /**
   * Whether this user's session still owns any session-scoped collection. A
   * session removed while the restore was not ready owns none (see
   * deleteSessionCollections), whatever the restore will read back.
   */
  hasSessionCollections(userId: string, sessionId: string): boolean {
    if (this.removedSessions.has(sessionKey(userId, sessionId))) return false;
    for (const stored of this.collections.values()) {
      if (
        stored.meta.scope === 'session' &&
        stored.meta.owner === userId &&
        stored.meta.sessionId === sessionId
      ) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Document CRUD
  // -------------------------------------------------------------------------

  async listDocuments(
    collectionId: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<{ documents: RagDocument[]; total: number } | null> {
    await this.settled(collectionId);
    const stored = this.collections.get(collectionId);
    if (!stored) return null;
    this.refuseDegraded(stored, 'list documents', 'read');
    const all = stored.persistent
      ? persistentOrder(stored.documents.values())
      : Array.from(stored.documents.values());
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return {
      documents: all.slice(offset, offset + limit),
      total: all.length,
    };
  }

  async getDocument(
    collectionId: string,
    docId: string,
  ): Promise<RagDocument | null> {
    await this.settled(collectionId);
    const stored = this.collections.get(collectionId);
    if (!stored) return null;
    this.refuseDegraded(stored, 'get document', 'read');
    return stored.documents.get(docId) ?? null;
  }

  /**
   * Find the single active document with the given canonicalKey in a collection.
   * "Active" = metadata.tags does not contain "superseded" or "deprecated".
   * Returns null when no match; throws when more than one active match exists
   * (an invariant violation that callers should surface, not silently pick one).
   */
  async findActiveByCanonicalKey(
    collectionId: string,
    canonicalKey: string,
  ): Promise<RagDocument | null> {
    await this.settled(collectionId);
    const stored = this.collections.get(collectionId);
    if (!stored) return null;
    this.refuseDegraded(stored, 'find document', 'read');
    const matches: RagDocument[] = [];
    for (const doc of stored.documents.values()) {
      if (doc.metadata?.canonicalKey !== canonicalKey) continue;
      const tags = (doc.metadata?.tags as string[] | undefined) ?? [];
      if (tags.includes('superseded') || tags.includes('deprecated')) continue;
      matches.push(doc);
    }
    if (matches.length > 1) {
      throw new Error(
        `Collection "${collectionId}" has ${matches.length} active records with canonicalKey "${canonicalKey}" — expected exactly one`,
      );
    }
    return matches[0] ?? null;
  }

  async addDocument(
    collectionId: string,
    doc: Omit<RagDocument, 'createdAt'>,
    namespace?: string,
    options?: {
      /**
       * When true, keep the document in the registry even if the RAG upsert
       * fails (stamping `metadata.unindexed = true`). Used by bulk/file
       * upload paths so reassembly export can recover chunks that the
       * vector backend rejected. Default false — single-document API
       * callers keep the atomic "either fully written or fully failed"
       * contract so a 4xx response means nothing was created.
       */
      persistOnFail?: boolean;
      /**
       * Preset seeding (ensurePresets): writes to what is held now, without
       * waiting for the restore. Seeding is no change a caller is told about;
       * the next ensure seeds again whatever install leaves under the id.
       */
      seed?: boolean;
    },
  ): Promise<RagDocument> {
    if (this.persistence) await this.settled(collectionId, !options?.seed);
    const stored = this.collections.get(collectionId);
    if (!stored) throw new Error(`Collection "${collectionId}" not found`);
    this.refuseDegraded(stored, 'add document', 'write');
    // Backend first, memory only on success; see addPersistentDocument.
    if (stored.persistent) {
      if (!storageEnabled())
        return addPersistentDocument(stored, doc, namespace);
      const persisted = await addPersistentDocument(stored, doc, namespace);
      this.refreshStorageCache(stored.meta);
      return persisted;
    }

    // Upsert into RAG store. IRagEditor.upsert returns Result<T, RagError>;
    // a backend rejection comes back as { ok: false }, NOT a thrown error.
    const result = await stored.rag.upsert(doc.text, {
      id: `doc:${collectionId}:${doc.id}`,
      namespace: namespace ?? stored.meta.owner,
      ...doc.metadata,
    });

    if (!result.ok && !options?.persistOnFail) {
      // Single-document API contract: failure leaves nothing behind, so a
      // retry against the same endpoint won't accidentally create a
      // duplicate "ghost" record.
      throw result.error instanceof Error
        ? result.error
        : new Error(String(result.error));
    }

    // Bulk/file path (persistOnFail=true): keep it in the registry regardless of
    // Qdrant outcome so export/reassembly recovers the chunk even when the
    // vector backend rejected it. On failure stamp `unindexed: true` so
    // callers (search, future re-index job) can tell which entries are
    // missing from the vector index. On retry success this method is
    // invoked again with the same id and overwrites without the flag.
    const persisted: RagDocument = {
      ...doc,
      createdAt: new Date().toISOString(),
      metadata: result.ok
        ? doc.metadata
        : { ...(doc.metadata ?? {}), unindexed: true },
    };
    if (storageEnabled() && stored.usageTextBytes !== undefined) {
      stored.usageTextBytes +=
        Buffer.byteLength(persisted.text, 'utf8') -
        Buffer.byteLength(stored.documents.get(doc.id)?.text ?? '', 'utf8');
    }
    stored.documents.set(doc.id, persisted);
    stored.meta.documentCount = stored.documents.size;
    if (storageEnabled()) this.refreshStorageCache(stored.meta);

    if (!result.ok) {
      // Throw so addDocumentsBulk's tryWithRetry can retry transient failures.
      // The local copy is already safe — retries that eventually succeed
      // will clear the `unindexed` flag via the overwrite above.
      throw result.error instanceof Error
        ? result.error
        : new Error(String(result.error));
    }

    return persisted;
  }

  async addDocumentsBulk(
    collectionId: string,
    docs: Omit<RagDocument, 'createdAt'>[],
    namespace?: string,
    options?: {
      /** Override sleep — tests inject instant resolve to avoid real waits. */
      sleep?: (ms: number) => Promise<void>;
      /** Override the shared retry-sleep budget (ms). Defaults to RETRY_BUDGET_MS. */
      budgetMs?: number;
      /**
       * Stop between documents once aborted. The document already sent is not
       * taken back: its session is being removed, and the removal waits for
       * this call to return.
       */
      signal?: AbortSignal;
    },
  ): Promise<{ added: number; errors: string[] }> {
    // A collection that cannot take writes refuses the whole call, explicitly,
    // instead of one error per document.
    if (this.persistence) {
      await this.settled(collectionId, true);
      const stored = this.collections.get(collectionId);
      if (stored) this.refuseDegraded(stored, 'add documents', 'write');
    }
    const errors: string[] = [];
    let added = 0;
    const budgetMs = options?.budgetMs ?? RETRY_BUDGET_MS;
    const sleep = options?.sleep;
    let retrySleepSpentMs = 0;

    for (const doc of docs) {
      if (options?.signal?.aborted) break;
      const result = await tryWithRetry(
        () =>
          this.addDocument(collectionId, doc, namespace, {
            persistOnFail: true,
          }),
        {
          sleep,
          canSleep: (delay) => retrySleepSpentMs + delay <= budgetMs,
          onSleep: (delay) => {
            retrySleepSpentMs += delay;
          },
        },
      );
      if (result.ok) {
        added += 1;
        // Throttle to avoid embedder rate limits (load shaping, not retry)
        if (added % 10 === 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } else {
        errors.push(`${doc.id}: ${result.error.message}`);
      }
    }

    if (added < docs.length) {
      const log = cds.log('rag-collections');
      log.warn('Bulk add partial', {
        collection: collectionId,
        total: docs.length,
        added,
        failed: docs.length - added,
        firstErrors: errors.slice(0, 5),
      });
    }

    return { added, errors };
  }

  async updateDocument(
    collectionId: string,
    docId: string,
    update: { text?: string; metadata?: Record<string, unknown> },
    namespace?: string,
  ): Promise<RagDocument | null> {
    if (this.persistence) await this.settled(collectionId, true);
    const stored = this.collections.get(collectionId);
    if (!stored) return null;
    this.refuseDegraded(stored, 'update document', 'write');
    const existing = stored.documents.get(docId);
    if (!existing) return null;
    if (stored.persistent) {
      if (!storageEnabled())
        return updatePersistentDocument(stored, existing, update, namespace);
      const updated = await updatePersistentDocument(
        stored,
        existing,
        update,
        namespace,
      );
      this.refreshStorageCache(stored.meta);
      return updated;
    }

    if (update.text) {
      if (storageEnabled() && stored.usageTextBytes !== undefined)
        stored.usageTextBytes +=
          Buffer.byteLength(update.text, 'utf8') -
          Buffer.byteLength(existing.text, 'utf8');
      existing.text = update.text;
    }
    if (update.metadata)
      existing.metadata = { ...existing.metadata, ...update.metadata };

    // Re-upsert into RAG (vector updated)
    await stored.rag.upsert(existing.text, {
      id: `doc:${collectionId}:${docId}`,
      namespace: namespace ?? stored.meta.owner,
      ...existing.metadata,
    });

    if (storageEnabled()) this.refreshStorageCache(stored.meta);
    return existing;
  }

  async deleteDocument(collectionId: string, docId: string): Promise<boolean> {
    if (this.persistence) await this.settled(collectionId, true);
    const stored = this.collections.get(collectionId);
    if (!stored) return false;
    this.refuseDegraded(stored, 'delete document', 'write');
    if (stored.persistent) {
      if (!storageEnabled()) return deletePersistentDocument(stored, docId);
      const deleted = await deletePersistentDocument(stored, docId);
      this.refreshStorageCache(stored.meta);
      return deleted;
    }
    if (storageEnabled() && stored.usageTextBytes !== undefined)
      stored.usageTextBytes -= Buffer.byteLength(
        stored.documents.get(docId)?.text ?? '',
        'utf8',
      );
    const deleted = stored.documents.delete(docId);
    if (deleted) {
      stored.meta.documentCount = stored.documents.size;
      // Also drop the vector embedding from the RAG store, otherwise
      // retrieval keeps surfacing the deleted document.
      try {
        await stored.rag.deleteById(`doc:${collectionId}:${docId}`);
      } catch (err) {
        this.log.warn('Failed to delete vector for document', {
          collectionId,
          docId,
          error: (err as Error).message,
        });
      }
    }
    if (storageEnabled()) this.refreshStorageCache(stored.meta);
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Get IRag store for a collection, to search it. A degraded one is refused:
   * a CollectionStatusError, 409 for `incompatible`, 503 for `unavailable`.
   */
  async getRagStore(collectionId: string): Promise<IRag | null> {
    await this.settled(collectionId);
    const stored = this.collections.get(collectionId);
    if (!stored) return null;
    this.refuseDegraded(stored, 'search', 'search');
    return stored.rag;
  }

  /**
   * The refusal a search over these collections gets, if one is degraded: the
   * CollectionStatusError of the first (409 incompatible, 503 unavailable),
   * naming the collection and its cause; undefined when all can be searched.
   * The chat asks this before it starts, and refuses the turn on an answer.
   */
  async degradedOf(
    collectionIds: string[],
  ): Promise<CollectionStatusError | undefined> {
    for (const id of collectionIds) {
      await this.settled(id);
      const stored = this.collections.get(id);
      if (!stored) continue;
      try {
        this.refuseDegraded(stored, 'search', 'search');
      } catch (err) {
        if (err instanceof CollectionStatusError) return err;
        throw err;
      }
    }
    return undefined;
  }

  /**
   * Get all RAG stores for given collection IDs (for injecting into
   * SmartAgent). Ids with no collection are skipped; a degraded collection is
   * never dropped silently — it throws its CollectionStatusError (see
   * degradedOf, which callers ask first).
   */
  async getRagStores(collectionIds: string[]): Promise<Record<string, IRag>> {
    const stores: Record<string, IRag> = {};
    for (const id of collectionIds) {
      await this.settled(id);
      const stored = this.collections.get(id);
      if (!stored) continue;
      this.refuseDegraded(stored, 'search', 'search');
      stores[id] = stored.rag;
    }
    return stores;
  }
}
