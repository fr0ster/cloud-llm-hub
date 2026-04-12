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
import type { CircuitBreaker } from '@mcp-abap-adt/llm-agent';
import {
  FallbackRag,
  type IEmbedder,
  InMemoryRag,
  type IQueryEmbedding,
  type IRag,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

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
  displayName: string;
  description: string;
  scope: 'global' | 'user';
  /** RAG backend type for this collection (default: registry's defaultBackend) */
  backend?: RagBackendType;
  owner?: string; // userId for user-scoped collections
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
  rag: IRag;
}

// ---------------------------------------------------------------------------
// RecencyBoostedRag — wraps IRag and boosts score of newer documents
// ---------------------------------------------------------------------------
// Formula: finalScore = baseScore * (1 + recencyBoost * recencyFactor)
// recencyFactor = 1.0 for just-created docs, decays to 0 over halfLifeMs.
// This ensures semantically relevant AND recent documents rank higher.
// ---------------------------------------------------------------------------

class RecencyBoostedRag implements IRag {
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
    options?: { signal?: AbortSignal },
  ) {
    // Stamp creation time in metadata for recency scoring
    if (!metadata._createdAtMs) {
      metadata._createdAtMs = Date.now();
    }
    return this.inner.upsert(text, metadata, options);
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

    const now = Date.now();
    result.value = result.value
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
  private createRagStore(backend?: RagBackendType): IRag {
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
    for (const stored of this.collections.values()) {
      if (stored.meta.scope === 'global' || stored.meta.owner === userId) {
        result.push({ ...stored.meta, documentCount: stored.documents.size });
      }
    }
    return result;
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
    if (id === 'facts') {
      throw new Error('Cannot delete built-in "facts" collection');
    }
    const deleted = this.collections.delete(id);
    if (deleted) {
      this.persistMeta();
      this.deleteCollectionDir(id);
      this.log.info('Collection deleted', { id });
    }
    return deleted;
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

  async addDocument(
    collectionId: string,
    doc: Omit<RagDocument, 'createdAt'>,
    namespace?: string,
  ): Promise<RagDocument> {
    const stored = this.collections.get(collectionId);
    if (!stored) throw new Error(`Collection "${collectionId}" not found`);

    const full: RagDocument = {
      ...doc,
      createdAt: new Date().toISOString(),
    };

    // Upsert into RAG store
    await stored.rag.upsert(doc.text, {
      id: `doc:${collectionId}:${doc.id}`,
      namespace:
        namespace ??
        (stored.meta.scope === 'global' ? 'global' : stored.meta.owner),
      ...doc.metadata,
    });

    stored.documents.set(doc.id, full);
    stored.meta.documentCount = stored.documents.size;
    this.persistDocument(collectionId, full);
    return full;
  }

  async addDocumentsBulk(
    collectionId: string,
    docs: Omit<RagDocument, 'createdAt'>[],
    namespace?: string,
  ): Promise<{ added: number; errors: string[] }> {
    const errors: string[] = [];
    let added = 0;

    for (const doc of docs) {
      try {
        await this.addDocument(collectionId, doc, namespace);
        added++;
        // Throttle to avoid embedder rate limits
        if (added % 10 === 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        errors.push(`${doc.id}: ${(err as Error).message}`);
      }
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
      namespace:
        namespace ??
        (stored.meta.scope === 'global' ? 'global' : stored.meta.owner),
      ...existing.metadata,
    });

    this.persistDocument(collectionId, existing);
    return existing;
  }

  deleteDocument(collectionId: string, docId: string): boolean {
    const stored = this.collections.get(collectionId);
    if (!stored) return false;
    const deleted = stored.documents.delete(docId);
    if (deleted) {
      stored.meta.documentCount = stored.documents.size;
      this.deleteDocumentFile(collectionId, docId);
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
    if (!this.storagePath) return;

    const metaPath = path.join(this.storagePath, 'collections.json');
    if (!fs.existsSync(metaPath)) return;

    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const metas: CollectionMeta[] = JSON.parse(raw);

      this.log.info('Loading collections from disk', { count: metas.length });

      for (const meta of metas) {
        const rag = this.createRagStore(meta.backend);
        const documents = new Map<string, RagDocument>();

        // Load documents
        const docsDir = path.join(this.storagePath!, meta.id);
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
                  namespace: meta.scope === 'global' ? 'global' : meta.owner,
                  ...doc.metadata,
                })
                .catch((err) => {
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
