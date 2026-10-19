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
  DuplicateCollectionError,
  type IRag,
  type IRagCatalogUpdater,
  type IRagEditor,
  type IRagProvider,
  isRagCatalogUpdater,
  OrphanStoreError,
  type RagCollectionOwner,
  type RagCollectionRecord,
  RagError,
  type RagJsonValue,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { CollectionMeta, RagDocument } from '../rag-collections';

/** Marks every catalog record this hub writes; restore opens only those. */
export const WRITTEN_BY = 'cloud-llm-hub';

/** Deterministic store name: identifier-safe, 42 characters. */
export function storeNameFor(collectionId: string): string {
  return `c_${createHash('sha256').update(collectionId).digest('hex').slice(0, 40)}`;
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
 * that is not this collection's).
 */
export function decodeRecord(
  rec: RagCollectionRecord,
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
  if (
    attrs.writtenBy !== WRITTEN_BY ||
    rec.scope === 'global' ||
    !collectionId ||
    !logicalId ||
    !userId ||
    rec.storeName !== storeNameFor(collectionId)
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

/** A collection read back from the catalog at startup (Task 7). */
export interface RestoredCollection {
  meta: CollectionMeta;
  enabled: boolean;
  embedderFp?: string;
  rag: IRag;
  editor: IRagEditor;
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
  /** Not implemented yet: restore at startup is Task 7. */
  restore(): Promise<Result<RestoredCollection[], RagError>>;
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

  /** 409 for a name that is taken (or an orphan store under it), else 502. */
  get httpStatus(): number {
    return this.cause instanceof DuplicateCollectionError ||
      this.cause instanceof OrphanStoreError
      ? 409
      : 502;
  }
}

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

function refuseWhileDeleting(entry: PersistentEntry): void {
  if (entry.deleting)
    throw new Error(`Collection "${entry.meta.id}" is being deleted`);
}

/** The point id stays `doc:<collectionId>:<docId>`. */
function payload(
  entry: PersistentEntry,
  docId: string,
  metadata: Record<string, unknown>,
  createdAt: string,
  namespace?: string,
): Record<string, unknown> {
  const collectionId = entry.meta.id;
  return {
    id: `doc:${collectionId}:${docId}`,
    namespace: namespace ?? entry.meta.owner,
    ...metadata,
    ...documentPayload(collectionId, docId, createdAt),
  };
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
  refuseWhileDeleting(entry);
  const createdAt = new Date().toISOString();
  const p = payload(entry, doc.id, doc.metadata, createdAt, namespace);
  await backendWrite('add document', () => entry.rag.upsert(doc.text, p));
  const persisted: RagDocument = { ...doc, createdAt };
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
  refuseWhileDeleting(entry);
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
  existing.metadata = metadata;
  return existing;
}

/** Delete from the backend; memory forgets the document only on success. */
export async function deletePersistentDocument(
  entry: PersistentEntry,
  docId: string,
): Promise<boolean> {
  if (!entry.documents.has(docId)) return false;
  refuseWhileDeleting(entry);
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
): CollectionPersistence {
  return {
    create: (meta, enabled) =>
      guarded(() =>
        provider.createCollection(storeNameFor(meta.id), {
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
        return provider.deleteCollection(storeNameFor(meta.id));
      }),
    update: (meta, enabled) =>
      guarded(async () => {
        if (!isRagCatalogUpdater(provider))
          return {
            ok: false,
            error: new RagError(
              `provider "${provider.name}" cannot update a catalog record`,
              'RAG_UNSUPPORTED',
            ),
          };
        return provider.updateCollection(storeNameFor(meta.id), {
          attributes: encodeAttributes(meta, enabled, embedderFp),
        });
      }),
    restore: async () => ({
      ok: false,
      error: new RagError(
        'restoring persistent collections is not implemented yet',
        'NOT_IMPLEMENTED',
      ),
    }),
  };
}
