/**
 * RAG Collection Registry — manages dynamic RAG collections at runtime.
 *
 * Provides CRUD for collections and documents with:
 * - Built-in "facts" collection (long-term knowledge, always present)
 * - Dynamic user/admin collections (SAP notes, product docs, etc.)
 * - Namespace isolation (global vs per-user)
 *
 * The registry lives in this process only: nothing is written to disk, and a
 * collection's data lives in its RAG backend.
 *
 * Collections are wired into SmartAgent as additional RAG stores.
 */

import { randomUUID } from 'node:crypto';
import {
  type CallOptions,
  type CircuitBreaker,
  FallbackRag,
  filterActive,
  type IEmbedder,
  InMemoryRag,
  type IQueryEmbedding,
  type IRag,
  type IRagBackendWriter,
  type IRagEditor,
  type RagError,
  type Result,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for session-scoped RAG collections (ms). Override via RAG_SESSION_TTL_MS env var. */
export const SESSION_TTL_MS =
  Number(process.env.RAG_SESSION_TTL_MS) || 24 * 60 * 60 * 1000;

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
  embedder: IEmbedder | null;
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
}

export interface RagDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface StoredCollection {
  meta: CollectionMeta;
  /** The store name its backend was created with; see RagBackendFactory. */
  store: string;
  /** The backend that created the store, asked to delete it on removal. */
  backend?: RagBackend;
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
  private collections = new Map<string, StoredCollection>();
  private backends = new Map<string, RagBackend>(
    Object.entries(builtInBackends),
  );
  private defaultBackend: RagBackendType;
  private embedder: IEmbedder | null;
  private breaker: CircuitBreaker | null;
  private log = cds.log('rag-collections');
  private enabledByUser: Map<string, Map<string, boolean>> = new Map();

  constructor(opts?: {
    embedder?: IEmbedder | null;
    breaker?: CircuitBreaker | null;
    /** Default backend for new collections (default: "vector" if embedder provided, else "in-memory") */
    defaultBackend?: RagBackendType;
  }) {
    this.embedder = opts?.embedder ?? null;
    this.breaker = opts?.breaker ?? null;
    this.defaultBackend =
      opts?.defaultBackend ?? (opts?.embedder ? 'vector' : 'in-memory');
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

  listCollections(userId?: string): CollectionMeta[] {
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

  getCollection(id: string): CollectionMeta | null {
    const stored = this.collections.get(id);
    if (!stored) return null;
    return {
      ...stored.meta,
      documentCount: stored.documents.size,
      sourceCount: countSources(stored),
    };
  }

  createCollection(
    meta: Omit<CollectionMeta, 'createdAt' | 'documentCount' | 'sourceCount'>,
  ): CollectionMeta {
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
    const store = storeNameFor(meta.id);
    this.collections.set(meta.id, {
      meta: full,
      store,
      backend: this.backends.get(full.backend ?? this.defaultBackend),
      documents: new Map(),
      rag: this.createRagStore(full.backend, store),
    });
    this.log.info('Collection created', { id: meta.id, scope: meta.scope });
    return full;
  }

  updateCollection(
    id: string,
    update: Partial<Pick<CollectionMeta, 'displayName' | 'description'>>,
  ): CollectionMeta | null {
    const stored = this.collections.get(id);
    if (!stored) return null;
    if (update.displayName) stored.meta.displayName = update.displayName;
    if (update.description) stored.meta.description = update.description;
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
  private removeCollection(id: string): boolean {
    const stored = this.collections.get(id);
    if (!stored) return false;
    this.collections.delete(id);
    for (const m of this.enabledByUser.values()) m.delete(id);
    this.releaseStore(id, stored);
    return true;
  }

  /** Delete a removed collection's store, or empty it where the backend deletes none. */
  private releaseStore(id: string, stored: StoredCollection): void {
    const { store, backend, rag } = stored;
    let released: Promise<Result<void, RagError>> | undefined;
    try {
      if (backend?.deleteStore) {
        released = backend.deleteStore(store);
      } else {
        released = rag.writer?.()?.clearAll?.();
      }
    } catch (err) {
      this.reportRemovalFailure(id, store, err);
      return;
    }
    if (!released) {
      this.reportRemovalFailure(
        id,
        store,
        new Error('the RAG backend can neither delete nor clear a store'),
      );
      return;
    }
    released.then(
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

  deleteCollection(id: string): boolean {
    const deleted = this.removeCollection(id);
    if (deleted) this.log.info('Collection deleted', { id });
    return deleted;
  }

  getEnabled(userId: string, physicalId: string): boolean | undefined {
    return this.enabledByUser.get(userId)?.get(physicalId);
  }

  setEnabled(userId: string, physicalId: string, enabled: boolean): void {
    let m = this.enabledByUser.get(userId);
    if (!m) {
      m = new Map();
      this.enabledByUser.set(userId, m);
    }
    m.set(physicalId, enabled);
  }

  /**
   * Refresh the expiry timestamp of a session-scoped collection so it is not
   * swept while the session is still active.
   */
  refreshSessionExpiry(physicalId: string): void {
    const stored = this.collections.get(physicalId);
    if (stored && stored.meta.scope === 'session') {
      stored.meta.expiresAt = Date.now() + SESSION_TTL_MS;
    }
  }

  /**
   * Remove expired session collections.
   *
   * `maySweep` is asked about each collection's session in the same synchronous
   * pass that removes it, so nothing can take a lease on the session between
   * the answer and the removal.
   */
  sweepExpiredSessions(
    maySweep: (userId: string, sessionId: string) => boolean = () => true,
  ): void {
    const now = Date.now();
    for (const [id, stored] of [...this.collections]) {
      if (
        stored.meta.scope === 'session' &&
        (stored.meta.expiresAt ?? 0) <= now &&
        maySweep(stored.meta.owner ?? '', stored.meta.sessionId ?? '')
      ) {
        this.removeCollection(id);
      }
    }
  }

  /** Remove every collection of one session. Never throws; see removeCollection. */
  deleteSessionCollections(userId: string, sessionId: string): void {
    for (const [id, stored] of [...this.collections]) {
      if (
        stored.meta.scope === 'session' &&
        stored.meta.owner === userId &&
        stored.meta.sessionId === sessionId
      ) {
        this.removeCollection(id);
      }
    }
  }

  /** Whether this user's session still owns any session-scoped collection. */
  hasSessionCollections(userId: string, sessionId: string): boolean {
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

  listDocuments(
    collectionId: string,
    opts?: { offset?: number; limit?: number },
  ): { documents: RagDocument[]; total: number } | null {
    const stored = this.collections.get(collectionId);
    if (!stored) return null;
    const all = Array.from(stored.documents.values());
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return {
      documents: all.slice(offset, offset + limit),
      total: all.length,
    };
  }

  getDocument(collectionId: string, docId: string): RagDocument | null {
    return this.collections.get(collectionId)?.documents.get(docId) ?? null;
  }

  /**
   * Find the single active document with the given canonicalKey in a collection.
   * "Active" = metadata.tags does not contain "superseded" or "deprecated".
   * Returns null when no match; throws when more than one active match exists
   * (an invariant violation that callers should surface, not silently pick one).
   */
  findActiveByCanonicalKey(
    collectionId: string,
    canonicalKey: string,
  ): RagDocument | null {
    const stored = this.collections.get(collectionId);
    if (!stored) return null;
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
    },
  ): Promise<RagDocument> {
    const stored = this.collections.get(collectionId);
    if (!stored) throw new Error(`Collection "${collectionId}" not found`);

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
    stored.documents.set(doc.id, persisted);
    stored.meta.documentCount = stored.documents.size;

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
    const stored = this.collections.get(collectionId);
    if (!stored) return null;
    const existing = stored.documents.get(docId);
    if (!existing) return null;

    if (update.text) existing.text = update.text;
    if (update.metadata)
      existing.metadata = { ...existing.metadata, ...update.metadata };

    // Re-upsert into RAG (vector updated)
    await stored.rag.upsert(existing.text, {
      id: `doc:${collectionId}:${docId}`,
      namespace: namespace ?? stored.meta.owner,
      ...existing.metadata,
    });

    return existing;
  }

  async deleteDocument(collectionId: string, docId: string): Promise<boolean> {
    const stored = this.collections.get(collectionId);
    if (!stored) return false;
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
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /** Get IRag store for a collection (used by SmartAgent integration) */
  getRagStore(collectionId: string): IRag | null {
    return this.collections.get(collectionId)?.rag ?? null;
  }

  /** Get all RAG stores for given collection IDs (for injecting into SmartAgent) */
  getRagStores(collectionIds: string[]): Record<string, IRag> {
    const stores: Record<string, IRag> = {};
    for (const id of collectionIds) {
      const rag = this.getRagStore(id);
      if (rag) stores[id] = rag;
    }
    return stores;
  }
}
