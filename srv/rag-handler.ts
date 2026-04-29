/**
 * RAG Management REST API — /v1/rag/*
 *
 * Endpoints for managing RAG collections and documents at runtime.
 * Authorization: MCP_Admin for global collections, MCP_Connector for user-scoped.
 */

import cds from '@sap/cds';
import type { Request, Response, Router } from 'express';
import type { CollectionRegistry } from './rag-collections';
import {
  buildRagToolSchemas,
  dispatchRagTool,
  getRagToolNames,
} from './rag-tool-dispatcher';

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
  router.get('/rag/collections', (_req: Request, res: Response) => {
    const userId = getUserId();
    const collections = registry.listCollections(userId);
    json(res, 200, { collections });
  });

  // POST /v1/rag/collections
  router.post('/rag/collections', (req: Request, res: Response) => {
    try {
      const { id, displayName, description, scope, backend } = req.body;

      if (!id || !displayName) {
        error(res, 400, 'id and displayName are required');
        return;
      }

      if (scope === 'global' && !isAdmin()) {
        error(res, 403, 'MCP_Admin role required for global collections');
        return;
      }

      const meta = registry.createCollection({
        id,
        displayName,
        description: description || '',
        scope: scope || 'user',
        backend,
        owner: scope === 'user' ? getUserId() : undefined,
      });

      log.info('Collection created via API', { id, scope, user: getUserId() });
      json(res, 201, meta);
    } catch (err) {
      error(res, 409, (err as Error).message);
    }
  });

  // GET /v1/rag/collections/:id
  router.get('/rag/collections/:id', (req: Request, res: Response) => {
    const meta = registry.getCollection(req.params.id);
    if (!meta) {
      error(res, 404, `Collection "${req.params.id}" not found`);
      return;
    }
    json(res, 200, meta);
  });

  // PUT /v1/rag/collections/:id
  router.put('/rag/collections/:id', (req: Request, res: Response) => {
    const meta = registry.getCollection(req.params.id);
    if (!meta) {
      error(res, 404, `Collection "${req.params.id}" not found`);
      return;
    }

    if (meta.scope === 'global' && !isAdmin()) {
      error(res, 403, 'MCP_Admin role required for global collections');
      return;
    }

    const updated = registry.updateCollection(req.params.id, req.body);
    json(res, 200, updated);
  });

  // DELETE /v1/rag/collections/:id
  router.delete('/rag/collections/:id', (req: Request, res: Response) => {
    const meta = registry.getCollection(req.params.id);
    if (!meta) {
      error(res, 404, `Collection "${req.params.id}" not found`);
      return;
    }

    if (meta.scope === 'global' && !isAdmin()) {
      error(res, 403, 'MCP_Admin role required');
      return;
    }

    try {
      registry.deleteCollection(req.params.id);
      res.status(204).end();
    } catch (err) {
      error(res, 400, (err as Error).message);
    }
  });

  // -------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------

  // GET /v1/rag/collections/:id/documents
  router.get(
    '/rag/collections/:id/documents',
    (req: Request, res: Response) => {
      const offset = Number(req.query.offset) || 0;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const result = registry.listDocuments(req.params.id, { offset, limit });
      if (!result) {
        error(res, 404, `Collection "${req.params.id}" not found`);
        return;
      }
      json(res, 200, result);
    },
  );

  // POST /v1/rag/collections/:id/documents
  router.post(
    '/rag/collections/:id/documents',
    async (req: Request, res: Response) => {
      try {
        const { id, text, metadata } = req.body;
        if (!text) {
          error(res, 400, 'text is required');
          return;
        }
        const docId = id || crypto.randomUUID();
        const namespace = req.body.namespace ?? undefined;
        const doc = await registry.addDocument(
          req.params.id,
          { id: docId, text, metadata: metadata || {} },
          namespace,
        );
        json(res, 201, doc);
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    },
  );

  // POST /v1/rag/collections/:id/documents/bulk
  router.post(
    '/rag/collections/:id/documents/bulk',
    async (req: Request, res: Response) => {
      try {
        const { documents } = req.body;
        if (!Array.isArray(documents) || documents.length === 0) {
          error(res, 400, 'documents array is required');
          return;
        }
        if (documents.length > 100) {
          error(res, 400, 'Maximum 100 documents per bulk request');
          return;
        }

        if (!isAdmin()) {
          const meta = registry.getCollection(req.params.id);
          if (meta?.scope === 'global') {
            error(
              res,
              403,
              'MCP_Admin role required for bulk upload to global collections',
            );
            return;
          }
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
          req.params.id,
          docs,
          namespace,
        );

        log.info('Bulk upload completed', {
          collection: req.params.id,
          added: result.added,
          errors: result.errors.length,
          user: getUserId(),
        });

        json(res, 200, result);
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    },
  );

  // GET /v1/rag/collections/:id/documents/:did
  router.get(
    '/rag/collections/:id/documents/:did',
    (req: Request, res: Response) => {
      const doc = registry.getDocument(req.params.id, req.params.did);
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
    async (req: Request, res: Response) => {
      try {
        const doc = await registry.updateDocument(
          req.params.id,
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
    },
  );

  // DELETE /v1/rag/collections/:id/documents/:did
  router.delete(
    '/rag/collections/:id/documents/:did',
    async (req: Request, res: Response) => {
      const deleted = await registry.deleteDocument(
        req.params.id,
        req.params.did,
      );
      if (!deleted) {
        error(res, 404, 'Document not found');
        return;
      }
      res.status(204).end();
    },
  );

  // -------------------------------------------------------------------
  // File Upload
  // -------------------------------------------------------------------

  // POST /v1/rag/collections/:id/upload
  // Accepts raw text file content, splits into chunks, creates documents.
  // Body: { filename: string, content: string, chunkSize?: number }
  router.post(
    '/rag/collections/:id/upload',
    async (req: Request, res: Response) => {
      try {
        const collectionId = req.params.id;
        const meta = registry.getCollection(collectionId);
        if (!meta) {
          error(res, 404, `Collection "${collectionId}" not found`);
          return;
        }

        if (meta.scope === 'global' && !isAdmin()) {
          error(res, 403, 'MCP_Admin role required for global collections');
          return;
        }

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
        const docs = chunks.map((text, i) => ({
          id: `${slugify(name)}-chunk-${String(i + 1).padStart(3, '0')}`,
          text,
          metadata: {
            source: name,
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
    },
  );

  // -------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------

  // POST /v1/rag/collections/:id/query
  router.post(
    '/rag/collections/:id/query',
    async (req: Request, res: Response) => {
      try {
        const store = registry.getRagStore(req.params.id);
        if (!store) {
          error(res, 404, `Collection "${req.params.id}" not found`);
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
    },
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
    const result = await dispatchRagTool(registry, name, req.body ?? {});
    json(res, result.ok ? 200 : 400, result);
  });

  log.info('RAG management routes registered', {
    prefix: '/v1/rag',
    endpoints: [
      'GET /v1/rag/backends',
      'GET /v1/rag/collections',
      'POST /v1/rag/collections',
      'GET /v1/rag/collections/:id',
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
