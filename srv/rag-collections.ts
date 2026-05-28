/**
 * RAG Collection Registry — manages dynamic RAG collections at runtime.
 *
 * Provides CRUD for collections and documents with:
 * - Built-in "facts" collection (long-term knowledge, always present)
 * - Dynamic user/admin collections (SAP notes, product docs, etc.)
 * - JSON persistence to disk (survives restarts with re-vectorization)
 * - Namespace isolation (global vs per-user)
 *
 * Collections are wired into SmartAgent as additional RAG stores.
 */

import fs from 'node:fs';
import path from 'node:path';
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
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for session-scoped RAG collections (ms). Override via RAG_SESSION_TTL_MS env var. */
export const SESSION_TTL_MS =
  Number(process.env.RAG_SESSION_TTL_MS) || 24 * 60 * 60 * 1000;

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
 * Factory function that creates an IRag instance for a given backend type.
 * Receives shared embedder + breaker so backends can reuse them.
 */
export type RagBackendFactory = (ctx: {
  embedder: IEmbedder | null;
  breaker: CircuitBreaker | null;
}) => IRag;

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
  documentCount: number;
}

export interface RagDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface StoredCollection {
  meta: CollectionMeta;
  documents: Map<string, RagDocument>;
  rag: RecencyBoostedRag;
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

/** Built-in backend factories */
const builtInBackends: Record<string, RagBackendFactory> = {
  'in-memory': () => new InMemoryRag(),

  vector: ({ embedder, breaker }) => {
    if (!embedder) return new InMemoryRag();
    const vectorRag = new VectorRag(embedder, {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
    });
    return breaker
      ? new FallbackRag(vectorRag, new InMemoryRag(), breaker)
      : vectorRag;
  },

  // Qdrant and HANA are placeholders — require external config at registration time.
  // Register via CollectionRegistry.registerBackend('qdrant', factory).
};

export class CollectionRegistry {
  private collections = new Map<string, StoredCollection>();
  private backends = new Map<string, RagBackendFactory>(
    Object.entries(builtInBackends),
  );
  private defaultBackend: RagBackendType;
  private storagePath: string | null;
  private embedder: IEmbedder | null;
  private breaker: CircuitBreaker | null;
  private log = cds.log('rag-collections');
  private enabledByUser: Map<string, Map<string, boolean>> = new Map();

  constructor(opts?: {
    storagePath?: string;
    embedder?: IEmbedder | null;
    breaker?: CircuitBreaker | null;
    /** Default backend for new collections (default: "vector" if embedder provided, else "in-memory") */
    defaultBackend?: RagBackendType;
  }) {
    this.storagePath = opts?.storagePath ?? null;
    this.embedder = opts?.embedder ?? null;
    this.breaker = opts?.breaker ?? null;
    this.defaultBackend =
      opts?.defaultBackend ?? (opts?.embedder ? 'vector' : 'in-memory');
  }

  /** Register a custom RAG backend (e.g. qdrant, hana). */
  registerBackend(type: RagBackendType, factory: RagBackendFactory): void {
    this.backends.set(type, factory);
    this.log.info('RAG backend registered', { type });
  }

  /** List available backend types. */
  listBackends(): string[] {
    return Array.from(this.backends.keys());
  }

  /** Create a RAG store for the given backend type, wrapped with recency boost. */
  private createRagStore(backend?: RagBackendType): RecencyBoostedRag {
    const type = backend ?? this.defaultBackend;
    const factory = this.backends.get(type);
    if (!factory) {
      this.log.warn('Unknown RAG backend, falling back to in-memory', {
        requested: type,
        available: this.listBackends(),
      });
      return new RecencyBoostedRag(new InMemoryRag());
    }
    const base = factory({
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
    for (const [id, stored] of this.collections) {
      if (id.startsWith('__orphan__')) continue;
      if (stored.meta.owner === userId) {
        result.push({ ...stored.meta, documentCount: stored.documents.size });
      }
    }
    return result;
  }

  migrateToUserNamespacing(): void {
    const {
      userCollectionId,
      normalizeLogicalId,
      sanitizeUserKey,
    } = require('./collection-ids');
    const crypto = require('node:crypto');
    const shortHash = (s: string) =>
      crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
    const takenLogical = new Map<string, Set<string>>(); // owner -> logicalIds occupied
    const addTaken = (owner: string, logical: string) => {
      const set = takenLogical.get(owner) ?? new Set<string>();
      set.add(logical);
      takenLogical.set(owner, set);
      return set;
    };
    // True only for an id of the exact migrated form `<logical>__u_<userKey(owner)>`
    // with a clean prefix. NOT for arbitrary `foo__bar`.
    const isRealOwner = (owner?: string): owner is string =>
      !!owner && owner !== 'anonymous';
    const migratedPrefix = (id: string, owner?: string): string | null => {
      if (!isRealOwner(owner)) return null; // 'anonymous' is not a real owner → never "already final"
      const suffix = `__u_${sanitizeUserKey(owner)}`;
      if (!id.endsWith(suffix)) return null;
      const prefix = id.slice(0, -suffix.length);
      return prefix && !prefix.includes('__') ? prefix : null;
    };

    // PASS 1 — record collections that are ALREADY migrated so PASS 2 can't collide with them.
    // Trust the id-derived prefix (the source of truth), correcting any stale/mismatched logicalId.
    for (const [id, stored] of this.collections) {
      const m = stored.meta;
      const prefix = migratedPrefix(id, m.owner);
      if (prefix) {
        m.logicalId = prefix;
        addTaken(m.owner as string, prefix);
      }
    }

    // PASS 2 — migrate everything not already in final form, in stable order.
    const entries = [...this.collections.entries()].sort((a, b) =>
      (a[1].meta.createdAt + a[0]).localeCompare(b[1].meta.createdAt + b[0]),
    );
    for (const [oldId, stored] of entries) {
      const meta = stored.meta;
      // Drop ONLY the built-in facts — the owner-less flat `facts`. A user-owned flat
      // `facts` is a normal private collection and must migrate, not be deleted.
      if (!meta.owner && oldId === 'facts') {
        this.collections.delete(oldId);
        continue;
      }
      if (migratedPrefix(oldId, meta.owner)) continue; // already final (recorded in PASS 1)
      if (oldId.startsWith('__orphan__')) continue; // already quarantined

      let newId: string;
      if (!isRealOwner(meta.owner)) {
        // no owner OR literal 'anonymous'
        newId = `__orphan__${shortHash(oldId)}`; // quarantine: hashed key, not served
        meta.logicalId = newId;
      } else {
        // Any non-final id (flat, or a stray `foo__bar`) → normalize with legacy fallback.
        const base = normalizeLogicalId(meta.logicalId || oldId, oldId, true);
        // Read the occupied set WITHOUT inserting first, then pick the first free candidate
        // from the FIXED base (base, base-2, base-3, …) — never suffix an already-suffixed value.
        const set = takenLogical.get(meta.owner) ?? new Set<string>();
        const taken = (cand: string) =>
          set.has(cand) ||
          (userCollectionId(cand, meta.owner) !== oldId &&
            this.collections.has(userCollectionId(cand, meta.owner)));
        let logical = base;
        if (taken(base)) {
          let n = 2;
          while (taken(`${base}-${n}`)) n++;
          logical = `${base}-${n}`;
        }
        set.add(logical);
        takenLogical.set(meta.owner, set);
        meta.logicalId = logical;
        newId = userCollectionId(logical, meta.owner);
      }
      if (newId !== oldId) {
        meta.id = newId;
        this.collections.delete(oldId);
        this.collections.set(newId, stored);
        for (const m of this.enabledByUser.values()) {
          if (m.has(oldId)) {
            m.set(newId, m.get(oldId) ?? false);
            m.delete(oldId);
          }
        }
      }
    }
    this.persistMeta();
    this.persistEnabled();
  }

  getCollection(id: string): CollectionMeta | null {
    const stored = this.collections.get(id);
    if (!stored) return null;
    return { ...stored.meta, documentCount: stored.documents.size };
  }

  createCollection(
    meta: Omit<CollectionMeta, 'createdAt' | 'documentCount'>,
  ): CollectionMeta {
    if (this.collections.has(meta.id)) {
      throw new Error(`Collection "${meta.id}" already exists`);
    }
    const full: CollectionMeta = {
      ...meta,
      backend: meta.backend ?? this.defaultBackend,
      createdAt: new Date().toISOString(),
      documentCount: 0,
    };
    this.collections.set(meta.id, {
      meta: full,
      documents: new Map(),
      rag: this.createRagStore(full.backend),
    });
    this.persistMeta();
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
    this.persistMeta();
    return { ...stored.meta, documentCount: stored.documents.size };
  }

  deleteCollection(id: string): boolean {
    const deleted = this.collections.delete(id);
    if (deleted) {
      this.persistMeta();
      this.deleteCollectionDir(id);
      this.log.info('Collection deleted', { id });
    }
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
    this.persistEnabled();
  }

  /**
   * Refresh the expiry timestamp of a session-scoped collection so it is not
   * swept while the session is still active. Persists the updated metadata so
   * the new deadline survives a restart.
   */
  refreshSessionExpiry(physicalId: string): void {
    const stored = this.collections.get(physicalId);
    if (stored && stored.meta.scope === 'session') {
      stored.meta.expiresAt = Date.now() + SESSION_TTL_MS;
      this.persistMeta();
    }
  }

  sweepExpiredSessions(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, stored] of this.collections) {
      if (
        stored.meta.scope === 'session' &&
        (stored.meta.expiresAt ?? 0) <= now
      ) {
        this.collections.delete(id);
        for (const m of this.enabledByUser.values()) m.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistMeta();
      this.persistEnabled();
    }
  }

  deleteSessionCollections(userId: string, sessionId: string): void {
    let changed = false;
    for (const [id, stored] of this.collections) {
      if (
        stored.meta.scope === 'session' &&
        stored.meta.owner === userId &&
        stored.meta.sessionId === sessionId
      ) {
        this.collections.delete(id);
        for (const m of this.enabledByUser.values()) m.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistMeta();
      this.persistEnabled();
    }
  }

  private persistEnabled(): void {
    if (!this.storagePath) return;
    const obj: Record<string, Record<string, boolean>> = {};
    for (const [u, m] of this.enabledByUser) obj[u] = Object.fromEntries(m);
    fs.writeFileSync(
      path.join(this.storagePath, 'enabled.json'),
      JSON.stringify(obj, null, 2),
    );
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
       * When true, persist the document locally even if the RAG upsert
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

    // Bulk/file path (persistOnFail=true): persist locally regardless of
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
    this.persistDocument(collectionId, persisted);

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
    },
  ): Promise<{ added: number; errors: string[] }> {
    const errors: string[] = [];
    let added = 0;
    const budgetMs = options?.budgetMs ?? RETRY_BUDGET_MS;
    const sleep = options?.sleep;
    let retrySleepSpentMs = 0;

    for (const doc of docs) {
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

    this.persistDocument(collectionId, existing);
    return existing;
  }

  async deleteDocument(collectionId: string, docId: string): Promise<boolean> {
    const stored = this.collections.get(collectionId);
    if (!stored) return false;
    const deleted = stored.documents.delete(docId);
    if (deleted) {
      stored.meta.documentCount = stored.documents.size;
      this.deleteDocumentFile(collectionId, docId);
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

  // -------------------------------------------------------------------------
  // JSON Persistence
  // -------------------------------------------------------------------------

  /** Load collections from disk and re-vectorize documents */
  async loadFromDisk(): Promise<void> {
    const storagePath = this.storagePath;
    if (!storagePath) return;

    const metaPath = path.join(storagePath, 'collections.json');
    if (!fs.existsSync(metaPath)) return;

    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const metas: CollectionMeta[] = JSON.parse(raw);

      this.log.info('Loading collections from disk', { count: metas.length });

      for (const meta of metas) {
        const rag = this.createRagStore(meta.backend);
        const documents = new Map<string, RagDocument>();

        // Load documents
        const docsDir = path.join(storagePath, meta.id);
        if (fs.existsSync(docsDir)) {
          const files = fs
            .readdirSync(docsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of files) {
            try {
              const doc: RagDocument = JSON.parse(
                fs.readFileSync(path.join(docsDir, file), 'utf-8'),
              );
              documents.set(doc.id, doc);

              // Re-vectorize (non-blocking, best-effort)
              rag
                .upsert(doc.text, {
                  id: `doc:${meta.id}:${doc.id}`,
                  namespace: meta.owner,
                  ...doc.metadata,
                })
                .catch((err: unknown) => {
                  this.log.warn('Re-vectorization failed', {
                    collection: meta.id,
                    doc: doc.id,
                    error: (err as Error).message,
                  });
                });
            } catch {
              this.log.warn('Failed to load document', {
                collection: meta.id,
                file,
              });
            }
          }
        }

        this.collections.set(meta.id, {
          meta: { ...meta, documentCount: documents.size },
          documents,
          rag,
        });
      }

      this.log.info('Collections loaded', {
        collections: metas.map((m) => m.id),
      });
    } catch (err) {
      this.log.warn('Failed to load collections from disk', {
        error: (err as Error).message,
      });
    }

    // Load per-user enabled state
    const enabledPath = path.join(storagePath, 'enabled.json');
    if (fs.existsSync(enabledPath)) {
      try {
        const raw = fs.readFileSync(enabledPath, 'utf-8');
        const obj: Record<string, Record<string, boolean>> = JSON.parse(raw);
        for (const [userId, perUser] of Object.entries(obj)) {
          const m = new Map<string, boolean>();
          for (const [physicalId, val] of Object.entries(perUser)) {
            m.set(physicalId, val);
          }
          this.enabledByUser.set(userId, m);
        }
      } catch (err) {
        this.log.warn('Failed to load enabled.json', {
          error: (err as Error).message,
        });
      }
    }

    this.migrateToUserNamespacing();
    this.sweepExpiredSessions();
  }

  private persistMeta(): void {
    if (!this.storagePath) return;
    try {
      fs.mkdirSync(this.storagePath, { recursive: true });
      const metas = Array.from(this.collections.values()).map((s) => s.meta);
      fs.writeFileSync(
        path.join(this.storagePath, 'collections.json'),
        JSON.stringify(metas, null, 2),
      );
    } catch (err) {
      this.log.warn('Failed to persist collection metadata', {
        error: (err as Error).message,
      });
    }
  }

  private persistDocument(collectionId: string, doc: RagDocument): void {
    if (!this.storagePath) return;
    try {
      const dir = path.join(this.storagePath, collectionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${doc.id}.json`),
        JSON.stringify(doc, null, 2),
      );
    } catch (err) {
      this.log.warn('Failed to persist document', {
        collection: collectionId,
        doc: doc.id,
        error: (err as Error).message,
      });
    }
  }

  private deleteDocumentFile(collectionId: string, docId: string): void {
    if (!this.storagePath) return;
    try {
      const filePath = path.join(
        this.storagePath,
        collectionId,
        `${docId}.json`,
      );
      fs.rmSync(filePath, { force: true });
    } catch {
      /* best-effort */
    }
  }

  private deleteCollectionDir(collectionId: string): void {
    if (!this.storagePath) return;
    try {
      const dir = path.join(this.storagePath, collectionId);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
