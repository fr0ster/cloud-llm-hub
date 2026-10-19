/**
 * The persistent side of the collection registry: user and session collections
 * kept in a vector database through llm-agent's `IRagProvider` catalog.
 *
 * The registry keeps its in-memory mirror; this adapter is the only place that
 * talks to the provider for a collection's lifecycle (create, delete, record
 * update). The hub never issues SQL or REST for collections itself.
 */
import { createHash } from 'node:crypto';
import {
  type CallOptions,
  DuplicateCollectionError,
  type IQueryEmbedding,
  type IRag,
  type IRagBackendWriter,
  type IRagCatalogUpdater,
  type IRagEditor,
  type IRagFilteredDeleter,
  type IRagProvider,
  type IRagScanner,
  isRagCatalogUpdater,
  isRagFilteredDeleter,
  isRagScanner,
  OrphanStoreError,
  type RagCollectionOwner,
  type RagCollectionRecord,
  RagError,
  type RagJsonValue,
  type RagMetadata,
  type RagResult,
  type RagScanFilter,
  type RagScanPage,
  type RagScanRecord,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { CollectionMeta, RagDocument } from '../rag-collections';

/** Marks every catalog record this hub writes; restore opens only those. */
export const WRITTEN_BY = 'cloud-llm-hub';

/**
 * Deterministic store name: identifier-safe, 42 characters. With a store
 * prefix (Qdrant only: LLM_AGENT_QDRANT_PREFIX) it is `<prefix>_c_<sha40>`, so
 * two deployments sharing one Qdrant never map a collection to one store.
 * HANA and Postgres keep `c_<sha40>`: their catalog and tables are per
 * container / schema already.
 */
export function storeNameFor(collectionId: string, prefix?: string): string {
  const name = `c_${createHash('sha256').update(collectionId).digest('hex').slice(0, 40)}`;
  return prefix ? `${prefix}_${name}` : name;
}

/** The longest store prefix: `<prefix>_c_<sha40>` stays well within Qdrant's 255. */
const MAX_STORE_PREFIX = 200;
/** What a Qdrant collection name may hold (the tool corpus uses the same prefix). */
const STORE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The store prefix for a persistent kind: the Qdrant prefix on `qdrant`,
 * none elsewhere. A prefix that cannot start a Qdrant collection name is a
 * configuration error, thrown at startup.
 */
export function storePrefixFor(
  kind: string,
  qdrantPrefix: string | undefined,
): string | undefined {
  if (kind !== 'qdrant' || !qdrantPrefix) return undefined;
  if (
    qdrantPrefix.length > MAX_STORE_PREFIX ||
    !STORE_PREFIX.test(qdrantPrefix)
  )
    throw new Error(
      `LLM_AGENT_QDRANT_PREFIX "${qdrantPrefix}" cannot prefix a Qdrant collection name (letters, digits, "_", "-", "."; at most ${MAX_STORE_PREFIX} characters)`,
    );
  return qdrantPrefix;
}

/**
 * The catalog owner. The library's session owner carries only `sessionId`; the
 * user of a session collection goes in `attributes.hubOwner` (spec §6).
 */
export function catalogOwner(meta: CollectionMeta): RagCollectionOwner {
  if (meta.scope === 'session') {
    if (!meta.sessionId)
      throw new Error(`session collection "${meta.id}" has no sessionId`);
    return { scope: 'session', sessionId: meta.sessionId };
  }
  if (!meta.owner) throw new Error(`user collection "${meta.id}" has no owner`);
  return { scope: 'user', userId: meta.owner };
}

/** Record attributes: JSON only, no undefined values. */
export function encodeAttributes(
  meta: CollectionMeta,
  enabled: boolean,
  embedderFp: string,
): Record<string, unknown> {
  return {
    writtenBy: WRITTEN_BY,
    collectionId: meta.id,
    logicalId: meta.logicalId,
    displayName: meta.displayName,
    description: meta.description,
    enabled,
    source: meta.scope,
    embedder: embedderFp,
    createdAt: meta.createdAt,
    ...(meta.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
    hubOwner: {
      userId: meta.owner ?? '',
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    },
  };
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

/**
 * A record back into the registry's terms, or `{ foreign: true }` for anything
 * this hub did not write (another tool's record, a global one, a store name
 * that is not this collection's, a catalog owner that is not `hubOwner`'s).
 */
export function decodeRecord(
  rec: RagCollectionRecord,
  storePrefix?: string,
):
  | { meta: CollectionMeta; enabled: boolean; embedderFp?: string }
  | { foreign: true } {
  const a = rec.attributes;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { foreign: true };
  const attrs = a as Record<string, unknown>;
  const collectionId = str(attrs.collectionId);
  const logicalId = str(attrs.logicalId);
  const hubOwner = attrs.hubOwner as Record<string, unknown> | undefined;
  const userId = str(hubOwner?.userId);
  const ownerAgrees =
    rec.scope === 'user'
      ? rec.userId === userId
      : rec.scope === 'session' && rec.sessionId === str(hubOwner?.sessionId);
  if (
    attrs.writtenBy !== WRITTEN_BY ||
    rec.scope === 'global' ||
    !ownerAgrees ||
    !collectionId ||
    !logicalId ||
    !userId ||
    rec.storeName !== storeNameFor(collectionId, storePrefix)
  ) {
    return { foreign: true };
  }
  const sessionId = rec.scope === 'session' ? rec.sessionId : undefined;
  const expiresAt =
    typeof attrs.expiresAt === 'number' ? attrs.expiresAt : undefined;
  const meta: CollectionMeta = {
    id: collectionId,
    logicalId,
    displayName: str(attrs.displayName) ?? logicalId,
    description: str(attrs.description) ?? '',
    scope: rec.scope,
    owner: userId,
    ...(sessionId ? { sessionId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    createdAt: str(attrs.createdAt) ?? new Date(0).toISOString(),
    documentCount: 0,
    sourceCount: 0,
  };
  const embedderFp = str(attrs.embedder);
  return {
    meta,
    enabled: attrs.enabled !== false,
    ...(embedderFp ? { embedderFp } : {}),
  };
}

/**
 * Why a restored collection cannot be used in full:
 * - `incompatible`: its record names another embedder fingerprint. It can be
 *   listed, read and exported; search and document writes are refused (409).
 * - `unavailable`: its store could not be opened or scanned at startup. Only
 *   its record is known; document reads, search and writes are refused (503).
 * Both can be renamed, disabled and deleted.
 */
export type CollectionStatus = 'incompatible' | 'unavailable';

/** A collection read back from the catalog at startup. */
export interface RestoredCollection {
  meta: CollectionMeta;
  enabled: boolean;
  /** Absent when the store could not be opened (`unavailable`). */
  rag?: IRag;
  /** Rebuilt from a scan of the store; empty when `unavailable`. */
  documents: RagDocument[];
  status?: CollectionStatus;
  /** Why, when `status` is set: names both fingerprints, or the cause. */
  error?: string;
}

/** What one restore read back. */
export interface RestoreOutcome {
  collections: RestoredCollection[];
  /** Store names of records this hub did not write: logged, never opened. */
  foreign: string[];
  /** Catalog rows the provider could not read as records. */
  rejected: readonly { storeName?: string; reason: string }[];
}

/**
 * Where the registry's restore stands. `off`: nothing persists. `pending`: not
 * tried yet. `failed`: the last attempt failed with `error`; a retry is due.
 */
export interface RestoreStatus {
  state: 'off' | 'pending' | 'restoring' | 'ready' | 'failed';
  error?: string;
}

export interface CollectionPersistence {
  create(
    meta: CollectionMeta,
    enabled: boolean,
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;
  remove(meta: CollectionMeta): Promise<Result<void, RagError>>;
  /** Rewrites the record's attributes (rename, description, enabled). */
  update(
    meta: CollectionMeta,
    enabled: boolean,
  ): Promise<Result<void, RagError>>;
  /**
   * `update`, serialized per collection: `snapshot` is taken only after the
   * collection's previous record write has settled, and `apply` (the memory
   * change) runs on success before the next write takes its snapshot. Every
   * write therefore carries the changes of the ones before it — no lost update.
   */
  updateRecord(
    collectionId: string,
    snapshot: () => { meta: CollectionMeta; enabled: boolean },
    apply: () => void,
  ): Promise<Result<void, RagError>>;
  /**
   * Session collections whose record says they expired by `now`, read from the
   * catalog. A backend delete that failed leaves its record behind; this is how
   * a later pass (the sweep, and Task 7's restore) finds it again.
   */
  expiredSessions(now: number): Promise<Result<CollectionMeta[], RagError>>;
  /**
   * Read the catalog back: `describeCollections`, then `openCollection` and a
   * full `scan` of each record this hub wrote. A failure to read the catalog
   * fails the whole restore; a failure to open or scan one store restores that
   * collection alone as `unavailable`.
   */
  restore(): Promise<Result<RestoreOutcome, RagError>>;
  /** The store name of a collection id (see storeNameFor). */
  storeName(collectionId: string): string;
}

/**
 * A persistent collection operation the backend refused. The registry throws
 * it with memory untouched; routes map it to 409 (duplicate, orphan) or 502.
 */
export class CollectionBackendError extends Error {
  constructor(
    readonly operation: string,
    readonly cause: RagError,
  ) {
    super(`${operation} failed in the collection backend: ${cause.message}`);
    this.name = 'CollectionBackendError';
  }

  /**
   * 409 for a name that is taken (or an orphan store under it) or a collection
   * being deleted, else 502.
   */
  get httpStatus(): number {
    if (
      this.cause.code === COLLECTIONS_UNAVAILABLE ||
      this.cause.code === COLLECTION_UNAVAILABLE
    )
      return 503;
    return this.cause instanceof DuplicateCollectionError ||
      this.cause instanceof OrphanStoreError ||
      this.cause.code === COLLECTION_DELETING ||
      this.cause.code === COLLECTION_INCOMPATIBLE
      ? 409
      : 502;
  }
}

/**
 * A persistent collection the registry cannot serve right now: collections not
 * restored yet (503), one restored as `unavailable` (503) or `incompatible`
 * (409). Its message is the cause alone, e.g. "collections unavailable: …".
 */
export class CollectionStatusError extends CollectionBackendError {
  constructor(operation: string, cause: RagError) {
    super(operation, cause);
    this.name = 'CollectionStatusError';
    this.message = cause.message;
  }
}

/** Error code: a write reached a collection whose deletion is out. */
export const COLLECTION_DELETING = 'COLLECTION_DELETING';
/** Error code: the persistent collections have not been restored (yet). */
export const COLLECTIONS_UNAVAILABLE = 'COLLECTIONS_UNAVAILABLE';
/** Error code: a collection whose store could not be opened at startup. */
export const COLLECTION_UNAVAILABLE = 'COLLECTION_UNAVAILABLE';
/** Error code: a collection written with another embedder fingerprint. */
export const COLLECTION_INCOMPATIBLE = 'COLLECTION_INCOMPATIBLE';

/** The value of an ok Result, or a CollectionBackendError naming `operation`. */
export function unwrap<T>(r: Result<T, RagError>, operation: string): T {
  if (!r.ok) throw new CollectionBackendError(operation, toRagError(r.error));
  return r.value;
}

/**
 * Run one backend write of a persistent collection: its value on success,
 * otherwise a CollectionBackendError — also for a write that throws.
 */
export async function backendWrite<T>(
  operation: string,
  run: () => Promise<Result<T, RagError>>,
): Promise<T> {
  return unwrap(await guarded(run), operation);
}

/**
 * A copy of a JSON-like value with the keys of every plain object sorted and
 * undefined values dropped. A persistent document's metadata is held in this
 * form: a backend (PG jsonb) need not keep key order, and what the API returns
 * must not change across a restart.
 */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = canonicalJson(v);
  }
  return out;
}

/** A persistent document's metadata in its canonical form; see canonicalJson. */
export function canonicalMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return canonicalJson(metadata ?? {}) as Record<string, unknown>;
}

/**
 * Reserved metadata keys of a persistent document: the payload fields the
 * write path adds beside a document's own metadata — the point id (`id`),
 * `namespace`, documentPayload's fields and RecencyBoostedRag's
 * `_createdAtMs`. The hub's values always win in the backend, a document's
 * own value under one of them is not kept (not in memory, not after a
 * restore), and restore strips them, so a document reads back as it was added.
 */
export const PAYLOAD_BOOKKEEPING = [
  'id',
  'namespace',
  'collectionId',
  'docId',
  'createdAt',
  '_createdAtMs',
] as const;

/** A scanned record back into a registry document; see PAYLOAD_BOOKKEEPING. */
export function restoredDocument(
  collectionId: string,
  rec: RagScanRecord,
): RagDocument {
  const m = (rec.metadata ?? {}) as Record<string, unknown>;
  const prefix = `doc:${collectionId}:`;
  const docId =
    typeof m.docId === 'string'
      ? m.docId
      : rec.id.startsWith(prefix)
        ? rec.id.slice(prefix.length)
        : rec.id;
  return {
    id: docId,
    text: rec.text,
    metadata: ownMetadata(m),
    createdAt:
      typeof m.createdAt === 'string' ? m.createdAt : new Date(0).toISOString(),
  };
}

/**
 * A collection's metadata with its fields in one fixed order, so the API's
 * JSON for a persistent collection is the same before and after a restart.
 */
export function canonicalCollectionMeta(m: CollectionMeta): CollectionMeta {
  return {
    id: m.id,
    logicalId: m.logicalId,
    displayName: m.displayName,
    description: m.description,
    scope: m.scope,
    ...(m.preset !== undefined ? { preset: m.preset } : {}),
    ...(m.backend !== undefined ? { backend: m.backend } : {}),
    ...(m.owner !== undefined ? { owner: m.owner } : {}),
    ...(m.sessionId !== undefined ? { sessionId: m.sessionId } : {}),
    ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
    createdAt: m.createdAt,
    documentCount: m.documentCount,
    sourceCount: m.sourceCount,
    ...(m.status !== undefined ? { status: m.status } : {}),
    ...(m.statusError !== undefined ? { statusError: m.statusError } : {}),
  };
}

/** Payload fields every persistent document carries, beside its own metadata. */
export function documentPayload(
  collectionId: string,
  docId: string,
  createdAt: string,
): Record<string, string> {
  return { collectionId, docId, createdAt };
}

// ---------------------------------------------------------------------------
// Backend-first document mutations of a persistent collection
// ---------------------------------------------------------------------------

/** The part of a registry entry the document mutations below touch. */
export interface PersistentEntry {
  meta: CollectionMeta;
  documents: Map<string, RagDocument>;
  rag: IRagEditor;
  /** Set while the collection's deletion is out. */
  deleting?: boolean;
}

function refuseWhileDeleting(entry: PersistentEntry, operation: string): void {
  if (entry.deleting)
    throw new CollectionBackendError(
      operation,
      new RagError(
        `collection "${entry.meta.id}" is being deleted`,
        COLLECTION_DELETING,
      ),
    );
}

/**
 * The backend payload of a persistent document. The point id stays
 * `doc:<collectionId>:<docId>`.
 *
 * Reserved keys (PAYLOAD_BOOKKEEPING: id, namespace, collectionId, docId,
 * createdAt, _createdAtMs) are the hub's: they are written after the
 * document's own metadata, so they always win, and a document's own value
 * under one of them is dropped (see ownMetadata). Every other metadata key is
 * kept as given.
 */
function payload(
  entry: PersistentEntry,
  docId: string,
  metadata: Record<string, unknown>,
  createdAt: string,
  namespace?: string,
): Record<string, unknown> {
  const collectionId = entry.meta.id;
  return {
    ...ownMetadata(metadata),
    id: `doc:${collectionId}:${docId}`,
    namespace: namespace ?? entry.meta.owner,
    ...documentPayload(collectionId, docId, createdAt),
  };
}

/**
 * A persistent document's own metadata: what it was given, without the
 * reserved keys (PAYLOAD_BOOKKEEPING), in canonical form. Memory holds this,
 * and restore reads back the same.
 */
export function ownMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const own: Record<string, unknown> = { ...(metadata ?? {}) };
  for (const k of PAYLOAD_BOOKKEEPING) delete own[k];
  return canonicalMetadata(own);
}

/**
 * Write the document to the backend, and only on success to memory. There is
 * no "keep it unindexed" path here: memory holding a record the backend lacks
 * would be undone by a restart.
 */
export async function addPersistentDocument(
  entry: PersistentEntry,
  doc: Omit<RagDocument, 'createdAt'>,
  namespace?: string,
): Promise<RagDocument> {
  refuseWhileDeleting(entry, 'add document');
  const createdAt = new Date().toISOString();
  const p = payload(entry, doc.id, doc.metadata, createdAt, namespace);
  await backendWrite('add document', () => entry.rag.upsert(doc.text, p));
  const persisted: RagDocument = {
    id: doc.id,
    text: doc.text,
    metadata: ownMetadata(doc.metadata),
    createdAt,
  };
  entry.documents.set(doc.id, persisted);
  entry.meta.documentCount = entry.documents.size;
  return persisted;
}

/** Re-upsert with the new text/metadata; memory changes only on success. */
export async function updatePersistentDocument(
  entry: PersistentEntry,
  existing: RagDocument,
  update: { text?: string; metadata?: Record<string, unknown> },
  namespace?: string,
): Promise<RagDocument> {
  refuseWhileDeleting(entry, 'update document');
  const text = update.text || existing.text;
  const metadata = update.metadata
    ? { ...existing.metadata, ...update.metadata }
    : existing.metadata;
  const p = payload(
    entry,
    existing.id,
    metadata,
    existing.createdAt,
    namespace,
  );
  await backendWrite('update document', () => entry.rag.upsert(text, p));
  existing.text = text;
  existing.metadata = ownMetadata(metadata);
  return existing;
}

/** Delete from the backend; memory forgets the document only on success. */
export async function deletePersistentDocument(
  entry: PersistentEntry,
  docId: string,
): Promise<boolean> {
  if (!entry.documents.has(docId)) return false;
  refuseWhileDeleting(entry, 'delete document');
  await backendWrite('delete document', () =>
    entry.rag.deleteById(`doc:${entry.meta.id}:${docId}`),
  );
  entry.documents.delete(docId);
  entry.meta.documentCount = entry.documents.size;
  return true;
}

function toRagError(err: unknown): RagError {
  if (err instanceof RagError) return err;
  return new RagError(
    err instanceof Error ? err.message : String(err),
    'RAG_BACKEND_ERROR',
  );
}

async function guarded<T>(
  run: () => Promise<Result<T, RagError>>,
): Promise<Result<T, RagError>> {
  try {
    return await run();
  } catch (err) {
    return { ok: false, error: toRagError(err) };
  }
}

export function createCollectionPersistence(
  provider: IRagProvider & Partial<IRagCatalogUpdater>,
  embedderFp: string,
  opts: { storePrefix?: string } = {},
): CollectionPersistence {
  const prefix = opts.storePrefix;
  const storeName = (collectionId: string) =>
    storeNameFor(collectionId, prefix);
  /** The tail of each collection's record-write chain. */
  const recordWrites = new Map<string, Promise<unknown>>();
  /**
   * The fingerprint a restored record names, where it is not the current one
   * (an incompatible collection). A record rewrite keeps it: renaming or
   * disabling must not make old vectors look compatible.
   */
  const recordFps = new Map<string, string>();
  const update = (meta: CollectionMeta, enabled: boolean) =>
    guarded(async (): Promise<Result<void, RagError>> => {
      if (!isRagCatalogUpdater(provider))
        return {
          ok: false,
          error: new RagError(
            `provider "${provider.name}" cannot update a catalog record`,
            'RAG_UNSUPPORTED',
          ),
        };
      return provider.updateCollection(storeName(meta.id), {
        attributes: encodeAttributes(
          meta,
          enabled,
          recordFps.get(meta.id) ?? embedderFp,
        ),
      });
    });
  return {
    storeName,
    create: (meta, enabled) =>
      guarded(() =>
        provider.createCollection(storeName(meta.id), {
          ...catalogOwner(meta),
          collectionName: meta.id,
          attributes: encodeAttributes(
            meta,
            enabled,
            embedderFp,
          ) as RagJsonValue,
        }),
      ),
    remove: (meta) =>
      guarded(async () => {
        if (!provider.deleteCollection)
          return {
            ok: false,
            error: new RagError(
              `provider "${provider.name}" cannot delete a collection`,
              'RAG_UNSUPPORTED',
            ),
          };
        const r = await provider.deleteCollection(storeName(meta.id));
        if (r.ok) recordFps.delete(meta.id);
        return r;
      }),
    update,
    updateRecord: (collectionId, snapshot, apply) => {
      const prev = recordWrites.get(collectionId) ?? Promise.resolve();
      const run = prev.then(async () => {
        const { meta, enabled } = snapshot();
        const r = await update(meta, enabled);
        if (r.ok) apply();
        return r;
      });
      const tail = run.catch(() => undefined);
      recordWrites.set(collectionId, tail);
      void tail.then(() => {
        if (recordWrites.get(collectionId) === tail)
          recordWrites.delete(collectionId);
      });
      return run;
    },
    expiredSessions: (now) =>
      guarded(async (): Promise<Result<CollectionMeta[], RagError>> => {
        if (!provider.describeCollections)
          return {
            ok: false,
            error: new RagError(
              `provider "${provider.name}" cannot describe its collections`,
              'RAG_UNSUPPORTED',
            ),
          };
        const d = await provider.describeCollections();
        if (!d.ok) return d;
        const expired: CollectionMeta[] = [];
        for (const rec of d.value.records) {
          const decoded = decodeRecord(rec, prefix);
          if (
            'meta' in decoded &&
            decoded.meta.scope === 'session' &&
            (decoded.meta.expiresAt ?? 0) <= now
          )
            expired.push(decoded.meta);
        }
        return { ok: true, value: expired };
      }),
    restore: () =>
      guarded(async (): Promise<Result<RestoreOutcome, RagError>> => {
        if (!provider.describeCollections || !provider.openCollection)
          return {
            ok: false,
            error: new RagError(
              `provider "${provider.name}" cannot describe and open its collections`,
              'RAG_UNSUPPORTED',
            ),
          };
        const d = await provider.describeCollections();
        if (!d.ok) return d;
        const collections: RestoredCollection[] = [];
        const foreign: string[] = [];
        for (const rec of d.value.records) {
          // The session history's own record: the hub's, but not a collection.
          if (isHistoryRecord(rec, prefix)) continue;
          const decoded = decodeRecord(rec, prefix);
          if (!('meta' in decoded)) {
            foreign.push(rec.storeName);
            continue;
          }
          if (decoded.embedderFp !== embedderFp)
            recordFps.set(decoded.meta.id, decoded.embedderFp ?? '');
          collections.push(
            await restoreOne(provider, rec, decoded, embedderFp),
          );
        }
        return {
          ok: true,
          value: { collections, foreign, rejected: d.value.rejected },
        };
      }),
  };
}

/** Open and scan one record of this hub; a failure makes it `unavailable`. */
async function restoreOne(
  provider: IRagProvider,
  rec: RagCollectionRecord,
  decoded: { meta: CollectionMeta; enabled: boolean; embedderFp?: string },
  embedderFp: string,
): Promise<RestoredCollection> {
  const { meta, enabled } = decoded;
  const unavailable = (cause: unknown): RestoredCollection => ({
    meta,
    enabled,
    documents: [],
    status: 'unavailable',
    error: `collection "${meta.id}" is unavailable: ${toRagError(cause).message}`,
  });
  let rag: IRag;
  try {
    const opened = await provider.openCollection?.(rec);
    if (!opened) return unavailable('the provider cannot open a collection');
    if (!opened.ok) return unavailable(opened.error);
    rag = opened.value.rag;
  } catch (err) {
    return unavailable(err);
  }
  if (!isRagScanner(rag)) return unavailable('its store cannot be scanned');
  const documents = new Map<string, RagDocument>();
  try {
    let cursor: string | undefined;
    do {
      const page = await rag.scan(cursor === undefined ? {} : { cursor });
      if (!page.ok) return unavailable(page.error);
      for (const r of page.value.records) {
        const doc = restoredDocument(meta.id, r);
        documents.set(doc.id, doc);
      }
      if (page.value.cursor !== undefined && page.value.cursor === cursor)
        return unavailable('its scan did not advance');
      cursor = page.value.cursor;
    } while (cursor !== undefined);
  } catch (err) {
    return unavailable(err);
  }
  const restored: RestoredCollection = {
    meta,
    enabled,
    rag,
    documents: [...documents.values()],
  };
  if (decoded.embedderFp !== embedderFp) {
    restored.status = 'incompatible';
    restored.error = `collection "${meta.id}" is incompatible: it was indexed with embedder "${decoded.embedderFp ?? 'unknown'}", the current embedder is "${embedderFp}"`;
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Restore with retry, and what /health reports
// ---------------------------------------------------------------------------

/** First retry delay after a failed restore. */
export const RESTORE_RETRY_INITIAL_MS = 30_000;
/** The retry delay doubles up to this. */
export const RESTORE_RETRY_MAX_MS = 5 * 60_000;

export interface RetryRestoreOptions {
  /** Run `run` after `ms`. Defaults to an unref'd setTimeout; tests inject. */
  schedule?: (run: () => void, ms: number) => void;
  log?: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
  };
  initialMs?: number;
  maxMs?: number;
}

/**
 * Run `attempt` until it succeeds: at once, then after 30 s, doubling up to
 * 5 min between attempts. Each attempt and its outcome is logged. The promise
 * resolves once an attempt has succeeded; it never rejects.
 */
export function retryRestore(
  attempt: () => Promise<void>,
  opts: RetryRestoreOptions = {},
): Promise<void> {
  const schedule =
    opts.schedule ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref();
    });
  const log = opts.log;
  const initial = opts.initialMs ?? RESTORE_RETRY_INITIAL_MS;
  const max = opts.maxMs ?? RESTORE_RETRY_MAX_MS;
  return new Promise<void>((resolve) => {
    let n = 0;
    const run = () => {
      n++;
      const at = n;
      log?.info(`Collection restore attempt ${at}`);
      guardedAttempt(attempt).then(
        () => {
          log?.info(`Collection restore attempt ${at} succeeded`);
          resolve();
        },
        (err: unknown) => {
          const delay = Math.min(initial * 2 ** (at - 1), max);
          log?.warn(
            `Collection restore attempt ${at} failed; next attempt in ${delay / 1000} s`,
            { error: err instanceof Error ? err.message : String(err) },
          );
          schedule(run, delay);
        },
      );
    };
    run();
  });
}

/** `attempt()`, with a synchronous throw turned into a rejection. */
function guardedAttempt(attempt: () => Promise<void>): Promise<void> {
  try {
    return attempt();
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * The /health answer for a restore status: 200 `{ status: 'UP' }` when nothing
 * persists or the restore has succeeded; 503 with the state and its cause
 * while it has not.
 */
export function restoreHealth(status: RestoreStatus): {
  status: number;
  body: Record<string, unknown>;
} {
  if (status.state === 'off' || status.state === 'ready')
    return { status: 200, body: { status: 'UP' } };
  return {
    status: 503,
    body: {
      status: 'DOWN',
      collections: {
        state: status.state,
        ...(status.error ? { error: status.error } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The session history store (spec §6: one catalog record of its own)
// ---------------------------------------------------------------------------

/** The store name of the session history, beside the `c_…` collections. */
export const HISTORY_STORE = 'h_history';

/** The history store name under a store prefix (Qdrant): `<prefix>_h_history`. */
export function historyStoreName(prefix?: string): string {
  return prefix ? `${prefix}_${HISTORY_STORE}` : HISTORY_STORE;
}

/** The record the history store is cataloged under: global, hub-written. */
function historyRecordOptions(adoptExisting: boolean) {
  return {
    scope: 'global' as const,
    collectionName: HISTORY_STORE,
    attributes: { writtenBy: WRITTEN_BY, source: 'history' },
    ...(adoptExisting ? { adoptExisting: true } : {}),
  };
}

/**
 * Whether a catalog record is this hub's session history store. Restore and
 * the expiry sweep pass over it: it is the hub's, but not a collection.
 */
export function isHistoryRecord(
  rec: RagCollectionRecord,
  storePrefix?: string,
): boolean {
  const a = rec.attributes;
  return (
    rec.storeName === historyStoreName(storePrefix) &&
    rec.scope === 'global' &&
    !!a &&
    typeof a === 'object' &&
    !Array.isArray(a) &&
    (a as Record<string, unknown>).writtenBy === WRITTEN_BY
  );
}

/**
 * The history store, through the provider, with its catalog record ensured:
 * created when absent, adopted when its rows exist without a record (spec §6),
 * opened when the record is already there. A record under `h_history` that
 * this hub did not write is refused and left alone.
 */
export async function ensureHistoryStore(
  provider: IRagProvider,
  storePrefix?: string,
): Promise<Result<IRag, RagError>> {
  const store = historyStoreName(storePrefix);
  return guarded(async (): Promise<Result<IRag, RagError>> => {
    // A plain create first; adopt only a store that exists without a record
    // (OrphanStoreError, from every provider). One attempt per real failure,
    // and Qdrant's adopt — which needs the collection to exist — is never
    // asked to create one.
    let created = await provider.createCollection(
      store,
      historyRecordOptions(false),
    );
    if (!created.ok && created.error instanceof OrphanStoreError)
      created = await provider.createCollection(
        store,
        historyRecordOptions(true),
      );
    if (created.ok) return { ok: true, value: created.value.rag };
    if (!(created.error instanceof DuplicateCollectionError)) return created;
    if (!provider.describeCollections || !provider.openCollection)
      return {
        ok: false,
        error: new RagError(
          `provider "${provider.name}" cannot open the existing history store`,
          'RAG_UNSUPPORTED',
        ),
      };
    const d = await provider.describeCollections();
    if (!d.ok) return d;
    const rec = d.value.records.find((r) => r.storeName === store);
    if (!rec || !isHistoryRecord(rec, storePrefix))
      return {
        ok: false,
        error: new RagError(
          `catalog record "${store}" was not written by ${WRITTEN_BY}; left alone`,
          'RAG_FOREIGN_RECORD',
        ),
      };
    const opened = await provider.openCollection(rec);
    if (!opened.ok) return opened;
    return { ok: true, value: opened.value.rag };
  });
}

/** How long a failed open of the history store is served before a retry. */
export const HISTORY_OPEN_COOL_DOWN_MS = 30_000;

export interface HistoryLog {
  warn(message: string, data?: unknown): void;
}

/**
 * The history store as one IRag that is usable at once: the store is opened
 * through the provider on first use (ensureHistoryStore), and an open that
 * fails is retried after a cool-down, never memoised for good. Scan and filtered
 * delete pass through to the opened store.
 */
export class PersistentHistoryStore
  implements IRag, IRagScanner, IRagFilteredDeleter
{
  private opening?: Promise<Result<IRag, RagError>>;
  /** The last failed open and when it failed; served during the cool-down. */
  private failed?: { at: number; result: Result<IRag, RagError> };
  private readonly now: () => number;
  private readonly coolDownMs: number;
  private readonly storePrefix?: string;

  constructor(
    private readonly provider: IRagProvider,
    private readonly log?: HistoryLog,
    opts: {
      now?: () => number;
      coolDownMs?: number;
      storePrefix?: string;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.coolDownMs = opts.coolDownMs ?? HISTORY_OPEN_COOL_DOWN_MS;
    this.storePrefix = opts.storePrefix;
  }

  /**
   * The opened store. A failed open is kept for the cool-down: calls inside
   * it get that failure at once (no connect; history is skipped for the turn)
   * and log nothing, so an outage costs one attempt and one warning per
   * window, not per request. The first call after the window tries again.
   */
  private store(): Promise<Result<IRag, RagError>> {
    if (this.failed && this.now() - this.failed.at < this.coolDownMs)
      return Promise.resolve(this.failed.result);
    if (!this.opening) {
      const run = ensureHistoryStore(this.provider, this.storePrefix).then(
        (r) => {
          if (r.ok) {
            this.failed = undefined;
          } else {
            this.failed = { at: this.now(), result: r };
            this.log?.warn('Session history store could not be opened', {
              error: r.error.message,
              retryInMs: this.coolDownMs,
            });
            if (this.opening === run) this.opening = undefined;
          }
          return r;
        },
      );
      this.opening = run;
    }
    return this.opening;
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const s = await this.store();
    return s.ok ? s.value.query(embedding, k, options) : s;
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    const s = await this.store();
    return s.ok ? s.value.getById(id, options) : s;
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    const s = await this.store();
    return s.ok ? s.value.healthCheck(options) : s;
  }

  private async innerWriter(): Promise<Result<IRagBackendWriter, RagError>> {
    const s = await this.store();
    if (!s.ok) return s;
    const w = s.value.writer?.();
    return w
      ? { ok: true, value: w }
      : {
          ok: false,
          error: new RagError(
            'the history store has no writer',
            'RAG_UNSUPPORTED',
          ),
        };
  }

  writer(): IRagBackendWriter {
    return {
      upsertRaw: async (
        id: string,
        text: string,
        metadata: RagMetadata,
        options?: CallOptions,
      ) => {
        const w = await this.innerWriter();
        return w.ok ? w.value.upsertRaw(id, text, metadata, options) : w;
      },
      deleteByIdRaw: async (id: string, options?: CallOptions) => {
        const w = await this.innerWriter();
        return w.ok ? w.value.deleteByIdRaw(id, options) : w;
      },
    };
  }

  async scan(
    opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string },
    options?: CallOptions,
  ): Promise<Result<RagScanPage, RagError>> {
    const s = await this.store();
    if (!s.ok) return s;
    if (!isRagScanner(s.value))
      return {
        ok: false,
        error: new RagError('the history store cannot scan', 'RAG_UNSUPPORTED'),
      };
    return s.value.scan(opts, options);
  }

  async deleteWhere(
    filter: RagScanFilter,
    options?: CallOptions,
  ): Promise<Result<{ deleted: number }, RagError>> {
    const s = await this.store();
    if (!s.ok) return s;
    if (!isRagFilteredDeleter(s.value))
      return {
        ok: false,
        error: new RagError(
          'the history store cannot delete by filter',
          'RAG_UNSUPPORTED',
        ),
      };
    return s.value.deleteWhere(filter, options);
  }
}
