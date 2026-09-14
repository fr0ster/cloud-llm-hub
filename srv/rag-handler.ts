/**
 * RAG Management REST API — /v1/rag/*
 *
 * Endpoints for managing RAG collections and documents at runtime.
 * Authorization: MCP_Admin for global collections, MCP_Connector for user-scoped.
 */

import crypto from 'node:crypto';

import cds from '@sap/cds';
import type { Request, Response, Router } from 'express';
import {
  normalizeLogicalId,
  resolveRouteId,
  sessionCollectionId,
  userCollectionId,
} from './collection-ids';
import { leaseSession } from './lib/gatekeeper';
import {
  isRefusal,
  type Lease,
  type LeaseRefusal,
} from './lib/session-retention';
import {
  doorRefusalSentence,
  sessionClosedText,
} from './lib/throttle-surfacing';
import { ensurePresets } from './presets';
import type { CollectionRegistry } from './rag-collections';
import { SESSION_TTL_MS } from './rag-collections';
import {
  buildRagToolSchemas,
  dispatchRagTool,
  getRagToolNames,
} from './rag-tool-dispatcher';
import { runWithSessionId } from './request-session';
import {
  carriesSessionHeader,
  sessionIdOf,
  type WithSession,
} from './session-id';

const log = cds.log('rag-handler');

function getUserId(): string {
  return cds.context?.user?.id ?? 'anonymous';
}

function isAdmin(): boolean {
  return cds.context?.user?.is('MCP_Admin') ?? false;
}

function json(res: Response, status: number, data: unknown): void {
  res.status(status).json(data);
}

function error(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

/**
 * Split text into chunks by paragraphs, respecting maxChars per chunk.
 * Paragraphs are split on double-newline boundaries. If a single paragraph
 * exceeds maxChars, it is split at sentence boundaries.
 */
function splitTextIntoChunks(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current && current.length + trimmed.length + 2 > maxChars) {
      chunks.push(current.trim());
      current = '';
    }

    if (trimmed.length > maxChars) {
      // Split oversized paragraph at sentence boundaries
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let buf = '';
      for (const s of sentences) {
        if (buf && buf.length + s.length + 1 > maxChars) {
          chunks.push(buf.trim());
          buf = '';
        }
        buf += (buf ? ' ' : '') + s;
      }
      if (buf) current = buf;
    } else {
      current += (current ? '\n\n' : '') + trimmed;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text.trim()];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Register all /v1/rag/* routes on the given Express router.
 */
export function registerRagRoutes(
  router: Router,
  registry: CollectionRegistry,
): void {
  // -------------------------------------------------------------------
  // Collections
  // -------------------------------------------------------------------

  // GET /v1/rag/backends — list available backend types
  router.get('/rag/backends', (_req: Request, res: Response) => {
    json(res, 200, { backends: registry.listBackends() });
  });

  // GET /v1/rag/collections
  router.get('/rag/collections', (req: Request, res: Response) => {
    const userId = getUserId();
    // Anonymous callers have no collections (no global scope; user scope requires identity).
    // listCollections() filters by owner === userId, so an 'anonymous' userId
    // would match every anonymous-owned legacy collection (cross-user leak).
    const effectiveUserId =
      userId && userId !== 'anonymous' ? userId : undefined;
    const sid = sessionIdOf(req);

    let collections = registry.listCollections(effectiveUserId);
    // Filter session-scoped collections to the current session only — prevents
    // stale/parallel sessions from showing in MANAGE and leaking physical ids.
    collections = collections.filter(
      (c) => c.scope !== 'session' || c.sessionId === sid,
    );

    const defaultEnabled = (c: { preset?: boolean }) => !c.preset;

    const mapped = collections.map((c) => ({
      id: c.id,
      logicalId: c.logicalId,
      scope: c.scope,
      displayName: c.displayName,
      description: c.description,
      backend: c.backend,
      owner: c.owner,
      createdAt: c.createdAt,
      documentCount: c.documentCount,
      sourceCount: c.sourceCount,
      preset: c.preset,
      enabled:
        effectiveUserId !== undefined
          ? (registry.getEnabled(effectiveUserId, c.id) ?? defaultEnabled(c))
          : defaultEnabled(c),
    }));

    json(res, 200, { collections: mapped });
  });

  // POST /v1/rag/presets/ensure — seed per-user preset collections if missing.
  router.post('/rag/presets/ensure', async (_req: Request, res: Response) => {
    try {
      const userId = getUserId();
      await ensurePresets(registry, userId);
      json(res, 200, {
        ok: true,
        collections: registry.listCollections(userId),
      });
    } catch (err) {
      error(res, 500, `ensurePresets failed: ${(err as Error).message}`);
    }
  });

  // POST /v1/rag/collections
  router.post('/rag/collections', (req: Request, res: Response) => {
    let lease: Lease | undefined;
    try {
      const { id, displayName, description, scope, backend } = req.body;

      if (!id || !displayName) {
        error(res, 400, 'id and displayName are required');
        return;
      }

      if (scope === 'global') {
        error(res, 400, 'global collections are no longer supported');
        return;
      }

      const userId = getUserId();
      if (!userId || userId === 'anonymous') {
        error(
          res,
          401,
          'Authenticated user required for user-scoped collections',
        );
        return;
      }

      // Normalize logical id — 400 on reserved __ in the name.
      let logicalId: string;
      try {
        logicalId = normalizeLogicalId(id);
      } catch (normErr) {
        error(res, 400, (normErr as Error).message);
        return;
      }

      let physical: string;
      let createMeta: Parameters<typeof registry.createCollection>[0];

      if (scope === 'session') {
        // Refused, not ignored. Ignoring it would create the collection under
        // the issued session, which this caller evidently is not tracking, and
        // it would find nothing where it looks next.
        if (carriesSessionHeader(req)) {
          error(
            res,
            400,
            'x-session-id is no longer read. A session collection belongs to the session this service issued: keep the clh_session cookie from a previous response and send it back.',
          );
          return;
        }
        const sid = sessionIdOf(req);
        if (!sid) {
          error(
            res,
            400,
            'session scope requires the clh_session cookie issued by this service',
          );
          return;
        }
        physical = sessionCollectionId(logicalId, userId, sid);
        const taken = leaseSession(userId, sid, 'rag', {
          presented: (req as Request & WithSession).sessionMinted === false,
        });
        if (isRefusal(taken)) {
          refuseLease(res, taken);
          return;
        }
        lease = taken;
        createMeta = {
          id: physical,
          logicalId,
          displayName,
          description: description || '',
          scope: 'session',
          backend,
          owner: userId,
          sessionId: sid,
          expiresAt: Date.now() + SESSION_TTL_MS,
        };
      } else {
        physical = userCollectionId(logicalId, userId);
        createMeta = {
          id: physical,
          logicalId,
          displayName,
          description: description || '',
          scope: 'user',
          backend,
          owner: userId,
        };
      }

      // Idempotent: if the physical collection already exists, return existing meta.
      const existing = registry.getCollection(physical);
      if (existing) {
        log.info('Collection already exists (idempotent)', {
          id: physical,
          user: userId,
        });
        json(res, 200, existing);
        return;
      }

      const meta = registry.createCollection(createMeta);
      log.info('Collection created via API', {
        id: physical,
        logicalId,
        scope: createMeta.scope,
        user: userId,
      });
      json(res, 201, meta);
    } catch (err) {
      error(res, 409, (err as Error).message);
    } finally {
      lease?.release();
    }
  });

  // Visibility/mutation guard.
  // Global: read open, write requires MCP_Admin.
  // User-scoped: only owner (or MCP_Admin) sees and mutates it.
  // Returns null if the caller is allowed; otherwise sends a response and
  // returns a sentinel so the caller can early-return.
  const canAccess = (
    meta: { scope?: string; owner?: string },
    mode: 'read' | 'write',
    res: Response,
  ): boolean => {
    const userId = getUserId();
    // 'anonymous' is the getUserId() fallback when no JWT user is in context.
    // We never grant ownership matches on that fallback — a stray unauthenticated
    // request must not align with another caller's 'anonymous'-owned collection.
    const hasIdentity = !!userId && userId !== 'anonymous';
    if (meta.scope === 'global') {
      if (mode === 'write' && !isAdmin()) {
        error(res, 403, 'MCP_Admin role required for global collections');
        return false;
      }
      return true;
    }
    if (hasIdentity && meta.owner && meta.owner === userId) return true;
    if (isAdmin()) return true;
    // 404 — do NOT leak existence to non-owners
    error(res, 404, 'Collection not found');
    return false;
  };

  function refuseLease(res: Response, refusal: LeaseRefusal): void {
    if (refusal.refused === 'closed') {
      res.status(410).json({
        error: { message: sessionClosedText(), code: 'session_closed' },
      });
      return;
    }
    res.status(503).json({
      error: {
        message: doorRefusalSentence('retention'),
        code: 'gatekeeper_retention',
      },
    });
  }

  /**
   * Hold a lease on the collection's session for as long as the handler runs.
   *
   * Only session-scoped collections: a user collection belongs to no session and
   * nothing here deletes it. The lease is released when the handler's work
   * settles — not on the response's `close`, which fires on a client disconnect
   * while the backend call is still out.
   */
  const leased =
    (
      handler: (
        req: Request,
        res: Response,
        lease?: Lease,
      ) => void | Promise<void>,
    ) =>
    async (req: Request, res: Response): Promise<void> => {
      const physId = (req as Request & { _physId?: string })._physId;
      const meta = physId ? registry.getCollection(physId) : null;
      if (meta?.scope !== 'session' || !meta.owner || !meta.sessionId) {
        await handler(req, res);
        return;
      }
      // The collection exists, so its session was live; presented, so a session
      // closing under this request is refused rather than written into.
      const lease = leaseSession(meta.owner, meta.sessionId, 'rag', {
        presented: true,
      });
      if (isRefusal(lease)) {
        refuseLease(res, lease);
        return;
      }
      try {
        await handler(req, res, lease);
      } finally {
        lease.release();
      }
    };

  // Gate all /rag/collections/:id* sub-paths (collection by id, documents,
  // upload, query). resolveRouteId performs ownership + session checks so
  // callers cannot access another user's collection even if they know the id.
  // forWrite=false (no auto-create via resolveByName) for GET / /query / /enabled.
  // forWrite=true (may create via resolveByName on logical ids) for everything else.
  // canAccess is a separate guard: for user-scoped collections only the owner passes;
  // for global collections read is open but write requires MCP_Admin.
  router.use('/rag/collections/:id', (req: Request, res: Response, next) => {
    // PATCH /enabled must use read-mode so it never creates a new collection.
    const isContentWrite =
      req.method !== 'GET' &&
      !req.path.endsWith('/query') &&
      !req.path.endsWith('/enabled');

    const physical = resolveRouteId(
      registry,
      req.params.id,
      getUserId(),
      sessionIdOf(req),
      isContentWrite,
    );

    if (!physical) {
      error(res, 404, 'Collection not found');
      return;
    }

    (req as Request & { _physId?: string })._physId = physical;

    const meta = registry.getCollection(physical);
    if (!meta) {
      error(res, 404, 'Collection not found');
      return;
    }
    const isQuery = req.path.endsWith('/query');
    const mode: 'read' | 'write' =
      req.method === 'GET' || isQuery ? 'read' : 'write';
    if (!canAccess(meta, mode, res)) return;
    next();
  });

  // GET /v1/rag/collections/:id
  router.get('/rag/collections/:id', (req: Request, res: Response) => {
    const physId = (req as Request & { _physId?: string })._physId;
    if (!physId) {
      error(res, 404, 'Collection not found');
      return;
    }
    const meta = registry.getCollection(physId);
    if (!meta) {
      error(res, 404, `Collection "${physId}" not found`);
      return;
    }
    json(res, 200, meta);
  });

  // PATCH /v1/rag/collections/:id/enabled
  router.patch(
    '/rag/collections/:id/enabled',
    (req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId || !registry.getCollection(physId)) {
        error(res, 404, 'Collection not found');
        return;
      }
      const { enabled } = req.body;
      registry.setEnabled(getUserId(), physId, !!enabled);
      json(res, 200, { id: physId, enabled: !!enabled });
    },
  );

  // PUT /v1/rag/collections/:id
  router.put('/rag/collections/:id', (req: Request, res: Response) => {
    const physId = (req as Request & { _physId?: string })._physId;
    if (!physId) {
      error(res, 404, 'Collection not found');
      return;
    }
    const meta = registry.getCollection(physId);
    if (!meta) {
      error(res, 404, `Collection "${physId}" not found`);
      return;
    }

    const updated = registry.updateCollection(physId, req.body);
    json(res, 200, updated);
  });

  // DELETE /v1/rag/collections/:id
  router.delete(
    '/rag/collections/:id',
    leased((req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) {
        error(res, 404, 'Collection not found');
        return;
      }
      const meta = registry.getCollection(physId);
      if (!meta) {
        error(res, 404, `Collection "${physId}" not found`);
        return;
      }

      try {
        registry.deleteCollection(physId);
        res.status(204).end();
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    }),
  );

  // -------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------

  // GET /v1/rag/collections/:id/documents
  router.get(
    '/rag/collections/:id/documents',
    (req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) {
        error(res, 404, 'Collection not found');
        return;
      }
      const offset = Number(req.query.offset) || 0;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const result = registry.listDocuments(physId, { offset, limit });
      if (!result) {
        error(res, 404, `Collection "${physId}" not found`);
        return;
      }
      json(res, 200, result);
    },
  );

  // POST /v1/rag/collections/:id/documents
  router.post(
    '/rag/collections/:id/documents',
    leased(async (req: Request, res: Response) => {
      try {
        const physId = (req as Request & { _physId?: string })._physId;
        if (!physId) {
          error(res, 404, 'Collection not found');
          return;
        }
        const { id, text, metadata } = req.body;
        if (!text) {
          error(res, 400, 'text is required');
          return;
        }
        const docId = id || crypto.randomUUID();
        const namespace = req.body.namespace ?? undefined;
        const doc = await registry.addDocument(
          physId,
          { id: docId, text, metadata: metadata || {} },
          namespace,
        );
        json(res, 201, doc);
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    }),
  );

  // POST /v1/rag/collections/:id/documents/bulk
  router.post(
    '/rag/collections/:id/documents/bulk',
    leased(async (req: Request, res: Response, lease?: Lease) => {
      try {
        const physId = (req as Request & { _physId?: string })._physId;
        if (!physId) {
          error(res, 404, 'Collection not found');
          return;
        }
        const { documents } = req.body;
        if (!Array.isArray(documents) || documents.length === 0) {
          error(res, 400, 'documents array is required');
          return;
        }
        if (documents.length > 100) {
          error(res, 400, 'Maximum 100 documents per bulk request');
          return;
        }

        const namespace = req.body.namespace ?? undefined;
        const docs = documents.map(
          (d: {
            id?: string;
            text: string;
            metadata?: Record<string, unknown>;
          }) => ({
            id: d.id || crypto.randomUUID(),
            text: d.text,
            metadata: d.metadata || {},
          }),
        );

        const result = await registry.addDocumentsBulk(
          physId,
          docs,
          namespace,
          {
            signal: lease?.signal,
          },
        );

        log.info('Bulk upload completed', {
          collection: physId,
          added: result.added,
          errors: result.errors.length,
          user: getUserId(),
        });

        json(res, 200, result);
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    }),
  );

  // GET /v1/rag/collections/:id/documents/:did
  router.get(
    '/rag/collections/:id/documents/:did',
    (req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) {
        error(res, 404, 'Collection not found');
        return;
      }
      const doc = registry.getDocument(physId, req.params.did);
      if (!doc) {
        error(res, 404, 'Document not found');
        return;
      }
      json(res, 200, doc);
    },
  );

  // PUT /v1/rag/collections/:id/documents/:did
  router.put(
    '/rag/collections/:id/documents/:did',
    leased(async (req: Request, res: Response) => {
      try {
        const physId = (req as Request & { _physId?: string })._physId;
        if (!physId) {
          error(res, 404, 'Collection not found');
          return;
        }
        const doc = await registry.updateDocument(
          physId,
          req.params.did,
          req.body,
        );
        if (!doc) {
          error(res, 404, 'Document not found');
          return;
        }
        json(res, 200, doc);
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    }),
  );

  // DELETE /v1/rag/collections/:id/documents/:did
  router.delete(
    '/rag/collections/:id/documents/:did',
    leased(async (req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) {
        error(res, 404, 'Collection not found');
        return;
      }
      const deleted = await registry.deleteDocument(physId, req.params.did);
      if (!deleted) {
        error(res, 404, 'Document not found');
        return;
      }
      res.status(204).end();
    }),
  );

  // -------------------------------------------------------------------
  // File Upload
  // -------------------------------------------------------------------

  // POST /v1/rag/collections/:id/upload
  // Accepts raw text file content, splits into chunks, creates documents.
  // Body: { filename: string, content: string, chunkSize?: number }
  router.post(
    '/rag/collections/:id/upload',
    leased(async (req: Request, res: Response, lease?: Lease) => {
      try {
        const collectionId = (req as Request & { _physId?: string })._physId;
        if (!collectionId) {
          error(res, 404, 'Collection not found');
          return;
        }
        const meta = registry.getCollection(collectionId);
        if (!meta) {
          error(res, 404, `Collection "${collectionId}" not found`);
          return;
        }

        // Ownership is enforced by canAccess — no global scope to check here.

        const { filename, content, chunkSize, description } = req.body;
        if (!content || typeof content !== 'string') {
          error(res, 400, 'content (string) is required');
          return;
        }

        const name = filename || 'uploaded-file.txt';
        const maxChunkChars = chunkSize || 2000;
        const chunks = splitTextIntoChunks(content, maxChunkChars);

        // Store chunks verbatim. Source/description are kept in metadata
        // for traceability; prepending them into the chunk text accumulates
        // noise across DL → re-UPLOAD cycles and the auto-generated
        // download filename (`<id>.txt`) carries no semantic value anyway.
        const uploadId = crypto.randomUUID();
        const uploadIdShort = uploadId.slice(0, 8);
        const docs = chunks.map((text, i) => ({
          id: `${slugify(name)}-${uploadIdShort}-chunk-${String(i + 1).padStart(3, '0')}`,
          text,
          metadata: {
            source: name,
            uploadId,
            description: description || undefined,
            chunkIndex: i,
            totalChunks: chunks.length,
          },
        }));

        const namespace = req.body.namespace ?? undefined;
        const result = await registry.addDocumentsBulk(
          collectionId,
          docs,
          namespace,
          {
            signal: lease?.signal,
          },
        );

        log.info('File uploaded', {
          collection: collectionId,
          filename: name,
          chunks: chunks.length,
          added: result.added,
          user: getUserId(),
        });

        json(res, 200, {
          filename: name,
          chunks: chunks.length,
          added: result.added,
          errors: result.errors,
        });
      } catch (err) {
        error(res, 500, (err as Error).message);
      }
    }),
  );

  // -------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------

  // POST /v1/rag/collections/:id/query
  router.post(
    '/rag/collections/:id/query',
    leased(async (req: Request, res: Response) => {
      try {
        const physId = (req as Request & { _physId?: string })._physId;
        if (!physId) {
          error(res, 404, 'Collection not found');
          return;
        }
        const store = registry.getRagStore(physId);
        if (!store) {
          error(res, 404, `Collection "${physId}" not found`);
          return;
        }

        const { text, k, namespace } = req.body;
        if (!text) {
          error(res, 400, 'text is required');
          return;
        }

        // Use TextOnlyEmbedding for in-memory, QueryEmbedding for vector
        const { TextOnlyEmbedding } = await import('@mcp-abap-adt/llm-agent');
        const embedding = new TextOnlyEmbedding(text);
        const result = await store.query(embedding, k || 10, {
          ragFilter: namespace ? { namespace } : undefined,
        });

        if (!result.ok) {
          error(res, 500, `Query failed: ${result.error}`);
          return;
        }

        json(res, 200, { results: result.value });
      } catch (err) {
        error(res, 500, (err as Error).message);
      }
    }),
  );

  // -------------------------------------------------------------------
  // External-tool dispatch (rag_add / rag_correct / rag_deprecate)
  // -------------------------------------------------------------------

  // GET /v1/rag/tools — OpenAI-format schemas for body.tools
  router.get('/rag/tools', (_req: Request, res: Response) => {
    json(res, 200, { tools: buildRagToolSchemas() });
  });

  // POST /v1/rag/tool/:name — dispatch a single tool call
  router.post('/rag/tool/:name', async (req: Request, res: Response) => {
    const name = req.params.name;
    if (!getRagToolNames().includes(name as never)) {
      error(res, 404, `Unknown RAG tool: ${name}`);
      return;
    }
    const sid = sessionIdOf(req);
    // rag_add may create a session collection, so a place is reserved for the
    // caller's session before it can.
    const lease = sid
      ? leaseSession(getUserId(), sid, 'rag', {
          presented: (req as Request & WithSession).sessionMinted === false,
        })
      : undefined;
    if (lease && isRefusal(lease)) {
      refuseLease(res, lease);
      return;
    }
    try {
      const result = await runWithSessionId(sid, () =>
        dispatchRagTool(registry, name, req.body ?? {}),
      );
      json(res, result.ok ? 200 : 400, result);
    } finally {
      lease?.release();
    }
  });

  log.info('RAG management routes registered', {
    prefix: '/v1/rag',
    endpoints: [
      'GET /v1/rag/backends',
      'GET /v1/rag/collections',
      'POST /v1/rag/collections',
      'POST /v1/rag/presets/ensure',
      'GET /v1/rag/collections/:id',
      'PATCH /v1/rag/collections/:id/enabled',
      'PUT /v1/rag/collections/:id',
      'DELETE /v1/rag/collections/:id',
      'GET /v1/rag/collections/:id/documents',
      'POST /v1/rag/collections/:id/documents',
      'POST /v1/rag/collections/:id/documents/bulk',
      'POST /v1/rag/collections/:id/upload',
      'GET /v1/rag/collections/:id/documents/:did',
      'PUT /v1/rag/collections/:id/documents/:did',
      'DELETE /v1/rag/collections/:id/documents/:did',
      'POST /v1/rag/collections/:id/query',
      'GET /v1/rag/tools',
      'POST /v1/rag/tool/:name',
    ],
  });
}
