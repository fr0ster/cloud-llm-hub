/**
 * RAG Management REST API — /v1/rag/*
 *
 * Endpoints for managing RAG collections and documents at runtime.
 * Authorization: MCP_Admin for global collections, MCP_Connector for user-scoped.
 */

import crypto from 'node:crypto';
import cds from '@sap/cds';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { getAgentConfig } from './agent-config';
import {
  normalizeLogicalId,
  resolveRouteId,
  sessionCollectionId,
  userCollectionId,
} from './collection-ids';
import { validateAgentProfileRecord } from './lib/agent-profile-records';
import { collectionAccessError } from './lib/collection-access';
import { CollectionBackendError } from './lib/collection-persistence';
import {
  collectionDefault,
  collectionEnabled,
  updateSessionCollection,
} from './lib/collection-toggle';
import { withCollectionRestScope } from './lib/collection-write-scope';
import { leaseSession } from './lib/gatekeeper';
import {
  addRagRecord,
  createRagCollection,
  deleteRagCollection,
  deleteRagRecord,
  updateRagRecord,
} from './lib/rag-write-operations';
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
import { sessionCollectionTtlMs } from './rag-collections';
import {
  buildRagToolSchemas,
  dispatchRagTool,
  getRagToolNames,
} from './rag-tool-dispatcher';
import { runWithSessionId } from './request-session';
import {
  carriesSessionHeader,
  honouredSessionId,
  sessionIdOf,
  type WithSession,
} from './session-id';

const log = cds.log('rag-handler');
const agentCopyInput = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().optional(),
    scope: z.literal('user').optional(),
    copyFrom: z.string(),
  })
  .strict();
const agentRecordUpdateInput = z
  .object({
    id: z.string().optional(),
    text: z.string(),
    metadata: z.record(z.string(), z.json()),
  })
  .strict();
const agentRecordInput = z
  .object({
    id: z.string(),
    text: z.string(),
    metadata: z.record(z.string(), z.json()),
  })
  .strict();

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
 * A failed registry call: a persistent backend's refusal carries its own
 * status (409 duplicate/orphan/incompatible, 503 collections not restored or
 * a collection unavailable, 502 otherwise); anything else gets `fallback`.
 */
function failure(res: Response, err: unknown, fallback: number): void {
  error(
    res,
    err instanceof CollectionBackendError
      ? err.httpStatus
      : err instanceof Error && err.message === 'Agent record already exists'
        ? 409
        : fallback,
    (err as Error).message,
  );
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

  router.use('/rag', (_req: Request, _res: Response, next) =>
    withCollectionRestScope(getUserId(), isAdmin(), next),
  );

  // GET /v1/rag/backends — list available backend types
  router.get('/rag/backends', (_req: Request, res: Response) => {
    json(res, 200, { backends: registry.listBackends() });
  });

  // GET /v1/rag/collections
  router.get('/rag/collections', async (req: Request, res: Response) => {
    const userId = getUserId();
    // Anonymous callers have no collections (no global scope; user scope requires identity).
    // listCollections() filters by owner === userId, so an 'anonymous' userId
    // would match every anonymous-owned legacy collection (cross-user leak).
    const effectiveUserId =
      userId && userId !== 'anonymous' ? userId : undefined;
    const sid = honouredSessionId(req);

    let collections: Awaited<ReturnType<typeof registry.listCollections>>;
    // Set while the restore of persistent collections is not ready: only the
    // presets are listed, and this says why the rest are missing.
    let unavailable: string | undefined;
    try {
      ({ collections, unavailable } =
        await registry.listCollectionsOrPresets(effectiveUserId));
    } catch (err) {
      failure(res, err, 500);
      return;
    }
    // Filter session-scoped collections to the current session only — prevents
    // stale/parallel sessions from showing in MANAGE and leaking physical ids.
    collections = collections.filter(
      (c) =>
        !c.agentsCopyPending && (c.scope !== 'session' || c.sessionId === sid),
    );

    const mapped = collections.map((c) => ({
      id: c.id,
      logicalId: c.logicalId,
      collectionKind: c.collectionKind,
      writable: !collectionAccessError(c, getUserId(), isAdmin(), 'write'),
      scope: c.scope,
      displayName: c.displayName,
      description: c.description,
      backend: c.backend,
      owner: c.owner,
      createdAt: c.createdAt,
      documentCount: c.documentCount,
      sourceCount: c.sourceCount,
      preset: c.preset,
      // Only on a persistent collection restored degraded.
      ...(c.status ? { status: c.status, statusError: c.statusError } : {}),
      enabled: collectionEnabled(registry, effectiveUserId ?? '', sid, c),
      defaultEnabled: collectionDefault(registry, effectiveUserId ?? '', c),
    }));

    json(res, 200, {
      collections: mapped,
      ...(unavailable ? { collectionsUnavailable: unavailable } : {}),
    });
  });

  // POST /v1/rag/presets/ensure — seed per-user preset collections if missing.
  router.post('/rag/presets/ensure', async (_req: Request, res: Response) => {
    try {
      const userId = getUserId();
      await ensurePresets(registry, userId);
      let listed: Awaited<ReturnType<typeof registry.listCollectionsOrPresets>>;
      try {
        // Presets are seeded; while the restore is not ready only they are
        // listed, with the cause.
        listed = await registry.listCollectionsOrPresets(userId);
      } catch (err) {
        failure(res, err, 500);
        return;
      }
      json(res, 200, {
        ok: true,
        collections: listed.collections,
        ...(listed.unavailable
          ? { collectionsUnavailable: listed.unavailable }
          : {}),
      });
    } catch (err) {
      error(res, 500, `ensurePresets failed: ${(err as Error).message}`);
    }
  });

  // POST /v1/rag/collections
  router.post('/rag/collections', async (req: Request, res: Response) => {
    let lease: Lease | undefined;
    try {
      const { id, displayName, description, scope, backend, copyFrom } =
        req.body;
      if (copyFrom !== undefined) {
        const parsedCopy = agentCopyInput.safeParse(req.body);
        if (
          !parsedCopy.success ||
          parsedCopy.data.copyFrom !==
            (getAgentConfig().profiles?.collectionId ?? 'agents') ||
          getUserId() === 'anonymous'
        ) {
          error(res, 400, 'Invalid agents copy request');
          return;
        }
        const input = parsedCopy.data;
        const logicalId = normalizeLogicalId(input.id);
        const copied = await registry.copyAgentCollection(input.copyFrom, {
          id: userCollectionId(logicalId, getUserId()),
          logicalId,
          displayName: input.displayName,
          description: input.description ?? '',
          scope: 'user',
          owner: getUserId(),
          collectionKind: 'agents',
        });
        json(res, 201, copied);
        return;
      }
      if (req.body.collectionKind === 'agents') {
        error(res, 400, 'Use copyFrom to create an agents collection');
        return;
      }

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

      // Collections persist on one backend; no request picks another.
      const persistentKind = registry.persistentBackend();
      if (
        persistentKind &&
        backend !== undefined &&
        backend !== persistentKind
      ) {
        error(
          res,
          400,
          `backend "${backend}" is not available: collections are stored on "${persistentKind}"`,
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
            'x-session-id is no longer read. A session collection belongs to a session this service issued: send the key of your session (POST /v1/session) in x-clh-session, or keep the clh_session cookie from a previous response and send it back.',
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
          expiresAt: Date.now() + sessionCollectionTtlMs(),
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

      // Idempotent: if the physical collection already exists, return existing
      // meta. Atomic: concurrent requests for one id create it once.
      const { collection: meta, created } = await createRagCollection(
        registry,
        createMeta,
      );
      if (!created) {
        log.info('Collection already exists (idempotent)', {
          id: physical,
          user: userId,
        });
        json(res, 200, meta);
        return;
      }
      log.info('Collection created via API', {
        id: physical,
        logicalId,
        scope: createMeta.scope,
        user: userId,
      });
      json(res, 201, meta);
    } catch (err) {
      failure(res, err, 409);
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
    meta: { scope?: string; owner?: string; collectionKind?: string },
    mode: 'read' | 'write',
    res: Response,
  ): boolean => {
    const refusal = collectionAccessError(meta, getUserId(), isAdmin(), mode);
    if (!refusal) return true;
    error(res, refusal.status, refusal.message);
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
    <P extends Record<string, string>>(
      handler: (
        req: Request<P>,
        res: Response,
        lease?: Lease,
      ) => void | Promise<void>,
    ) =>
    async (req: Request<P>, res: Response): Promise<void> => {
      const physId = (req as Request & { _physId?: string })._physId;
      let meta: Awaited<ReturnType<typeof registry.getCollection>>;
      try {
        meta = physId ? await registry.getCollection(physId) : null;
      } catch (err) {
        failure(res, err, 500);
        return;
      }
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
  router.use(
    '/rag/collections/:id',
    async (req: Request<{ id: string }>, res: Response, next) => {
      // PATCH /enabled must use read-mode so it never creates a new collection.
      const isContentWrite =
        req.method !== 'GET' &&
        !req.path.endsWith('/query') &&
        req.path !== '/enabled';

      // Waits for the restore of persistent collections; while it has failed
      // every collection route is a 503 "collections unavailable: <cause>".
      let physical: string | undefined;
      let meta: Awaited<ReturnType<typeof registry.getCollection>>;
      try {
        physical = await resolveRouteId(
          registry,
          req.params.id,
          getUserId(),
          sessionIdOf(req),
          isContentWrite,
        );
        meta = physical ? await registry.getCollection(physical) : null;
      } catch (err) {
        failure(res, err, 500);
        return;
      }

      if (!physical) {
        error(res, 404, 'Collection not found');
        return;
      }

      (req as Request & { _physId?: string })._physId = physical;

      if (!meta) {
        error(res, 404, 'Collection not found');
        return;
      }
      const isQuery = req.path.endsWith('/query');
      const mode: 'read' | 'write' =
        req.method === 'GET' ||
        isQuery ||
        (req.path === '/enabled' &&
          honouredSessionId(req) &&
          req.body?.scope !== 'default')
          ? 'read'
          : 'write';
      if (!canAccess(meta, mode, res)) return;
      if (
        meta.collectionKind === 'agents' &&
        (req.path === '/upload' ||
          req.path === '/enabled' ||
          req.path === '/documents/bulk' ||
          req.path === '/documents/enabled')
      ) {
        error(
          res,
          400,
          'Agents configuration requires individual record operations',
        );
        return;
      }
      next();
    },
  );

  // GET /v1/rag/collections/:id
  router.get('/rag/collections/:id', async (req: Request, res: Response) => {
    const physId = (req as Request & { _physId?: string })._physId;
    if (!physId) {
      error(res, 404, 'Collection not found');
      return;
    }
    let meta: Awaited<ReturnType<typeof registry.getCollection>>;
    try {
      meta = await registry.getCollection(physId);
    } catch (err) {
      failure(res, err, 500);
      return;
    }
    if (!meta) {
      error(res, 404, `Collection "${physId}" not found`);
      return;
    }
    json(res, 200, meta);
  });

  // PATCH /v1/rag/collections/:id/enabled
  router.patch(
    '/rag/collections/:id/enabled',
    async (req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      const { enabled } = req.body;
      try {
        if (!physId || !(await registry.getCollection(physId))) {
          error(res, 404, 'Collection not found');
          return;
        }
        const sid = honouredSessionId(req);
        if (sid && req.body.scope !== 'default') {
          const userId = getUserId();
          const lease = leaseSession(userId, sid, 'rag', { presented: true });
          if (isRefusal(lease)) {
            refuseLease(res, lease);
            return;
          }
          try {
            await updateSessionCollection(userId, sid, physId, !!enabled);
          } finally {
            lease.release();
          }
        } else await registry.setEnabled(getUserId(), physId, !!enabled);
      } catch (err) {
        failure(res, err, 500);
        return;
      }
      json(res, 200, { id: physId, enabled: !!enabled });
    },
  );

  // PUT /v1/rag/collections/:id
  router.put('/rag/collections/:id', async (req: Request, res: Response) => {
    const physId = (req as Request & { _physId?: string })._physId;
    if (!physId) {
      error(res, 404, 'Collection not found');
      return;
    }
    try {
      const meta = await registry.getCollection(physId);
      if (!meta) {
        error(res, 404, `Collection "${physId}" not found`);
        return;
      }
      const updated = await registry.updateCollection(physId, req.body);
      json(res, 200, updated);
    } catch (err) {
      failure(res, err, 500);
    }
  });

  // DELETE /v1/rag/collections/:id
  router.delete(
    '/rag/collections/:id',
    leased(async (req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) {
        error(res, 404, 'Collection not found');
        return;
      }
      try {
        const meta = await registry.getCollection(physId);
        if (!meta) {
          error(res, 404, `Collection "${physId}" not found`);
          return;
        }
        await deleteRagCollection(registry, physId);
      } catch (err) {
        failure(res, err, 500);
        return;
      }
      res.status(204).end();
    }),
  );

  // -------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------

  // GET /v1/rag/collections/:id/documents
  router.get(
    '/rag/collections/:id/documents',
    async (req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) {
        error(res, 404, 'Collection not found');
        return;
      }
      const offset = Number(req.query.offset) || 0;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      let result: Awaited<ReturnType<typeof registry.listDocuments>>;
      try {
        const meta = await registry.getCollection(physId);
        if (meta?.collectionKind === 'agents') {
          const current = await registry.readAgentCollection(physId);
          result = current
            ? {
                documents: current.documents
                  .slice(offset, offset + limit)
                  .map((document) => ({
                    ...document,
                    enabled: document.metadata.enabled !== false,
                  })),
                total: current.documents.length,
              }
            : null;
        } else {
          result = await registry.listDocuments(physId, { offset, limit });
        }
      } catch (err) {
        failure(res, err, 500);
        return;
      }
      if (!result) {
        error(res, 404, `Collection "${physId}" not found`);
        return;
      }
      const meta = await registry.getCollection(physId);
      if (meta?.collectionKind === 'agents') {
        json(res, 200, {
          ...result,
          documents: result.documents.map((document) =>
            document.metadata.enabled === false
              ? { id: document.id, enabled: false, reason: 'record-disabled' }
              : document,
          ),
        });
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
        if (
          (await registry.getCollection(physId))?.collectionKind === 'agents'
        ) {
          const parsed = agentRecordInput.safeParse(req.body);
          if (!parsed.success)
            return error(res, 400, 'Invalid agent record fields');
          const record = validateAgentProfileRecord(parsed.data);
          json(res, 201, await registry.createAgentRecord(physId, record));
          return;
        }
        const { id, text, metadata } = req.body;
        if (!text) {
          error(res, 400, 'text is required');
          return;
        }
        const doc = await addRagRecord(registry, physId, {
          id,
          text,
          metadata,
          namespace: req.body.namespace ?? undefined,
        });
        json(res, 201, doc);
      } catch (err) {
        failure(res, err, 400);
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
        failure(res, err, 400);
      }
    }),
  );

  router.patch(
    '/rag/collections/:id/documents/enabled',
    leased(async (req: Request, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) return error(res, 404, 'Collection not found');
      const { enabled, source, uploadId = '' } = req.body;
      if (
        typeof enabled !== 'boolean' ||
        typeof source !== 'string' ||
        !source ||
        typeof uploadId !== 'string'
      )
        return error(
          res,
          400,
          'enabled (boolean), source and optional uploadId are required',
        );
      try {
        const result = await registry.setSourceEnabled(
          physId,
          source,
          uploadId,
          enabled,
        );
        if (!result.updated) return error(res, 404, 'Source file not found');
        json(res, 200, result);
      } catch (err) {
        failure(res, err, 400);
      }
    }),
  );

  router.patch(
    '/rag/collections/:id/documents/:did/enabled',
    leased(async (req: Request<{ id: string; did: string }>, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) return error(res, 404, 'Collection not found');
      if (typeof req.body.enabled !== 'boolean')
        return error(res, 400, 'enabled must be a boolean');
      try {
        const doc = await registry.setDocumentEnabled(
          physId,
          req.params.did,
          req.body.enabled,
        );
        if (!doc) return error(res, 404, 'Document not found');
        json(
          res,
          200,
          doc.metadata.enabled === false
            ? { id: doc.id, enabled: false, reason: 'record-disabled' }
            : doc,
        );
      } catch (err) {
        failure(res, err, 400);
      }
    }),
  );

  // GET /v1/rag/collections/:id/documents/:did
  router.get(
    '/rag/collections/:id/documents/:did',
    async (req: Request<{ id: string; did: string }>, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) {
        error(res, 404, 'Collection not found');
        return;
      }
      let doc: Awaited<ReturnType<typeof registry.getDocument>>;
      try {
        const meta = await registry.getCollection(physId);
        if (meta?.collectionKind === 'agents') {
          const current = await registry.readAgentCollection(physId);
          const document = current?.documents.find(
            (entry) => entry.id === req.params.did,
          );
          doc = document
            ? { ...document, enabled: document.metadata.enabled !== false }
            : null;
        } else {
          doc = await registry.getDocument(physId, req.params.did);
        }
      } catch (err) {
        failure(res, err, 500);
        return;
      }
      if (!doc) {
        error(res, 404, 'Document not found');
        return;
      }
      const meta = await registry.getCollection(physId);
      if (meta?.collectionKind === 'agents' && doc.metadata.enabled === false) {
        json(res, 200, {
          id: doc.id,
          enabled: false,
          reason: 'record-disabled',
        });
        return;
      }
      json(res, 200, doc);
    },
  );

  // PUT /v1/rag/collections/:id/documents/:did
  router.put(
    '/rag/collections/:id/documents/:did',
    leased(async (req: Request<{ id: string; did: string }>, res: Response) => {
      try {
        const physId = (req as Request & { _physId?: string })._physId;
        if (!physId) {
          error(res, 404, 'Collection not found');
          return;
        }
        if (
          (await registry.getCollection(physId))?.collectionKind === 'agents'
        ) {
          const parsed = agentRecordUpdateInput.safeParse(req.body);
          if (
            !parsed.success ||
            (parsed.data.id !== undefined && parsed.data.id !== req.params.did)
          )
            return error(res, 400, 'Invalid agent record fields');
          const record = validateAgentProfileRecord({
            ...parsed.data,
            id: req.params.did,
          });
          const updated = await updateRagRecord(
            registry,
            physId,
            req.params.did,
            record,
          );
          if (!updated) return error(res, 404, 'Document not found');
          json(res, 200, updated);
          return;
        }
        const doc = await updateRagRecord(
          registry,
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
        failure(res, err, 400);
      }
    }),
  );

  // DELETE /v1/rag/collections/:id/documents/:did
  router.delete(
    '/rag/collections/:id/documents/:did',
    leased(async (req: Request<{ id: string; did: string }>, res: Response) => {
      const physId = (req as Request & { _physId?: string })._physId;
      if (!physId) {
        error(res, 404, 'Collection not found');
        return;
      }
      let deleted: boolean;
      try {
        deleted = await deleteRagRecord(registry, physId, req.params.did);
      } catch (err) {
        failure(res, err, 500);
        return;
      }
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
        const meta = await registry.getCollection(collectionId);
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
          documentIds: docs.map((doc) => doc.id),
          errors: result.errors,
        });
      } catch (err) {
        failure(res, err, 500);
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
        const store = await registry.getRagStore(physId);
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
        failure(res, err, 500);
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
  router.post(
    '/rag/tool/:name',
    async (req: Request<{ name: string }>, res: Response) => {
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
        const result = await runWithSessionId(
          sid,
          () => dispatchRagTool(registry, name, req.body ?? {}),
          undefined,
          getUserId(),
        );
        json(res, result.ok ? 200 : (result.status ?? 400), result);
      } finally {
        lease?.release();
      }
    },
  );

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
      'PATCH /v1/rag/collections/:id/documents/:did/enabled',
      'PATCH /v1/rag/collections/:id/documents/enabled',
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
