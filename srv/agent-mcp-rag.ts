import { QueryEmbedding, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import cds from '@sap/cds';
import type { Request } from 'express';
import { z } from 'zod';
import { getCollectionRegistry, getQueryEmbedder } from './agent-manager';
import { resolveRouteId } from './collection-ids';
import { collectionAccessError } from './lib/collection-access';
import { restoredDocument } from './lib/collection-persistence';
import {
  collectionDefault,
  collectionEnabled,
  updateSessionCollection,
} from './lib/collection-toggle';
import { withCollectionToolScope } from './lib/collection-write-scope';
import { leaseSession } from './lib/gatekeeper';
import { longSessions } from './lib/long-session';
import { readRagDocuments } from './lib/rag-read';
import { recordAttributes, recordPolicy } from './lib/record-policy';
import { resolveSession } from './lib/session-lifecycle';
import { isRefusal } from './lib/session-retention';
import { requestMeasurement } from './lib/usage/request-records';
import { usageRuntime } from './lib/usage/runtime';
import { CollectionSearchRag } from './rag-collections';
import { isReadOnlyTools, profileToolAllowed } from './request-session';
import { resolveSessionKey } from './session-id';

const session = z.string().min(1).optional();
const collection = z.string().min(1);
const offset = z.number().int().nonnegative().optional();
const enabled = z.boolean();
export const ragMcpSchemas = {
  rag_search: z.object({
    session,
    query: z.string().min(1),
    collections: z.array(collection).optional(),
    k: z.number().int().min(1).max(20).default(8),
  }),
  rag_read: z.object({
    session,
    collection,
    id: z.string().min(1),
    offset,
    limit: z.number().int().min(1).max(32000).default(8000),
  }),
  collections_list: z.object({ session }),
  collection_set_enabled: z.object({ session, collection, enabled }),
  collection_records: z.object({
    session,
    collection,
    offset,
    limit: z.number().int().min(1).max(200).default(50),
  }),
  record_set_enabled: z.object({
    session,
    collection,
    id: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    uploadId: z.string().optional(),
    enabled,
  }),
};
export type RagMcpTool = keyof typeof ragMcpSchemas;
const toolNames: RagMcpTool[] = [
  'rag_search',
  'rag_read',
  'collections_list',
  'collection_set_enabled',
  'collection_records',
  'record_set_enabled',
];
type Args = {
  session?: string;
  collection?: string;
  query?: string;
  collections?: string[];
  k?: number;
  id?: string;
  source?: string;
  uploadId?: string;
  enabled?: boolean;
  offset?: number;
  limit?: number;
};
export function ragTextResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}
type Result = ReturnType<typeof ragTextResult>;
const descriptions: Record<RagMcpTool, string> = {
  rag_search:
    'Search RAG content in collections enabled for this session; collections only narrows the selection.',
  rag_read:
    'Read a RAG record, paged by characters. Disabled content exposes attributes and a reason only.',
  collections_list:
    'List readable collections and their effective session enablement.',
  collection_set_enabled:
    'Enable or disable a collection for this session only.',
  collection_records:
    'List a page of record attributes and visible titles in a collection.',
  record_set_enabled:
    'Enable or disable a record by id or all chunks of a source upload. Requires write permission.',
};

export function registerRagMcpTools(
  server: McpServer,
  req: Request,
  userId: string,
  measure: (
    name: RagMcpTool,
    run: (args: Args) => Promise<Result>,
  ) => (args: Args) => Promise<Result>,
): void {
  for (const name of toolNames) {
    if (
      !profileToolAllowed(name) ||
      (isReadOnlyTools() &&
        ![
          'rag_search',
          'rag_read',
          'collection_records',
          'collections_list',
        ].includes(name))
    )
      continue;
    const run = measure(name, (args) =>
      executeRagMcpTool(
        req,
        userId,
        name,
        args,
        requestMeasurement(req)?.traceId,
      ),
    );
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: ragMcpSchemas[name].shape,
      },
      (args: Args) =>
        run({ ...args, session: args.session ?? resolveSessionKey(req).key }),
    );
  }
}

/** Validates even direct calls, before acquiring the session queue and lease. */
async function executeRagMcpToolImpl(
  req: Pick<Request, 'headers'>,
  userId: string,
  name: RagMcpTool,
  input: Args,
  traceId?: string,
): Promise<Result> {
  if (
    !profileToolAllowed(name) ||
    (isReadOnlyTools() &&
      ![
        'rag_search',
        'rag_read',
        'collection_records',
        'collections_list',
      ].includes(name))
  )
    return ragTextResult(`TOOL_FORBIDDEN: ${name}`, true);
  const parsed = ragMcpSchemas[name].safeParse(input);
  if (!parsed.success) return ragTextResult(parsed.error.message, true);
  const args: Args = parsed.data;
  if (
    name === 'record_set_enabled' &&
    Boolean(args.id) === Boolean(args.source)
  )
    return ragTextResult('Provide exactly one of id or source', true);
  const key = args.session ?? resolveSessionKey(req).key;
  if (!key)
    return ragTextResult('SESSION_REQUIRED: call session_open first', true);
  try {
    const s = await resolveSession(userId, key);
    if (!s) return ragTextResult('SESSION_NOT_FOUND', true);
    const result = await longSessions().run(s, async () => {
      const lease = leaseSession(userId, key, 'rag', { presented: true });
      if (isRefusal(lease))
        return ragTextResult(
          lease.refused === 'closed' ? 'SESSION_CLOSED' : 'SESSION_RETENTION',
          true,
        );
      try {
        return await runRagTool(userId, key, name, args, traceId);
      } finally {
        lease.release();
      }
    });
    return 'refused' in result ? ragTextResult(result.refused, true) : result;
  } catch (error) {
    if (
      error instanceof Error &&
      'refused' in error &&
      (error.refused === 'SESSION_LIMIT' ||
        error.refused === 'SESSION_STORE_UNAVAILABLE')
    )
      return ragTextResult(error.refused, true);
    return ragTextResult(
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
}

async function runRagTool(
  userId: string,
  sid: string,
  name: RagMcpTool,
  args: Args,
  traceId?: string,
): Promise<Result> {
  const registry = getCollectionRegistry();
  const admin = cds.context?.user?.is('MCP_Admin') ?? false;
  const respond = (value: object) => ragTextResult(JSON.stringify(value));
  const resolve = async (entry: string) => {
    const id = await resolveRouteId(registry, entry, userId, sid, false);
    if (!id) throw new Error('Collection not found');
    const meta = await registry.getCollection(id);
    if (!meta) throw new Error('Collection not found');
    if (
      meta.collectionKind === 'agents' &&
      (name === 'record_set_enabled' || name === 'collection_set_enabled')
    )
      throw new Error('TOOL_FORBIDDEN: agents configuration is REST-only');
    const refusal = collectionAccessError(
      meta,
      userId,
      admin,
      name === 'record_set_enabled' ? 'write' : 'read',
    );
    if (refusal) throw new Error(refusal.message);
    return id;
  };
  if (name === 'collections_list') {
    const collections = await registry.listCollections(
      userId && userId !== 'anonymous' ? userId : undefined,
    );
    return respond({
      collections: collections
        .filter((c) => c.scope !== 'session' || c.sessionId === sid)
        .map((c) => ({
          id: c.id,
          name: c.displayName,
          scope: c.scope,
          collectionKind: c.collectionKind,
          enabled: collectionEnabled(registry, userId, sid, c),
          defaultEnabled: collectionDefault(registry, userId, c),
          documents: c.documentCount,
        })),
    });
  }
  if (name === 'rag_search') {
    const entries =
      args.collections ??
      (await registry.listCollections(userId))
        .filter(
          (c) =>
            c.collectionKind !== 'agents' &&
            (c.scope !== 'session' || c.sessionId === sid),
        )
        .map((c) => c.id);
    const ids = [...new Set(await Promise.all(entries.map(resolve)))];
    const embedder = getQueryEmbedder();
    const embedding = embedder
      ? new QueryEmbedding(args.query ?? '', embedder, {
          usage: usageRuntime()
            ?.forSession({ userId, sessionId: sid })
            .with({
              ...(traceId ? { requestId: traceId, traceId } : {}),
              role: 'embedding',
              component: 'collection-retrieval',
            }),
        })
      : new TextOnlyEmbedding(args.query ?? '');
    const hits: {
      collection: string;
      id: string;
      title?: string;
      text: string;
      score: number;
    }[] = [];
    const unavailable: { collection: string; error: string }[] = [];
    for (const id of ids) {
      try {
        const meta = await registry.getCollection(id);
        if (
          !meta ||
          meta.collectionKind === 'agents' ||
          !collectionEnabled(registry, userId, sid, meta)
        )
          continue;
        const store = await registry.getRagStore(id);
        if (!store) throw new Error('Collection store unavailable');
        const result = await new CollectionSearchRag(store).query(
          embedding,
          args.k ?? 8,
        );
        if (!result.ok) throw result.error;
        const collectionHits: typeof hits = [];
        for (const hit of result.value) {
          if (!hit.metadata.id) continue;
          const record = restoredDocument(id, {
            id: hit.metadata.id,
            text: hit.text,
            metadata: hit.metadata,
          });
          const doc = await registry.getDocument(id, record.id);
          if (doc && recordPolicy(doc.metadata, true).visible)
            collectionHits.push({
              collection: id,
              id: doc.id,
              title: doc.text.split(/\r?\n/, 1)[0].slice(0, 120),
              text: doc.text,
              score: hit.score,
            });
        }
        hits.push(...collectionHits);
      } catch (error) {
        const note = {
          collection: id,
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            500,
          ),
        };
        // Reserve half the response for healthy results, including JSON escaping.
        if (JSON.stringify([...unavailable, note]).length <= 12000)
          unavailable.push(note);
      }
    }
    const bounded: typeof hits = [];
    const payload = (results: typeof hits) => ({
      hits: results,
      ...(unavailable.length ? { unavailable } : {}),
    });
    for (const hit of hits
      .sort((a, b) => b.score - a.score)
      .slice(0, args.k ?? 8)) {
      const candidate = { ...hit };
      if (JSON.stringify(payload([...bounded, candidate])).length > 24000) {
        candidate.text = ' [truncated]';
        if (JSON.stringify(payload([...bounded, candidate])).length > 24000)
          break;
        // Count serialized characters too: quotes and control characters expand.
        let low = 0;
        let high = Math.min(hit.text.length, 24000);
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          candidate.text = `${hit.text.slice(0, middle)} [truncated]`;
          if (JSON.stringify(payload([...bounded, candidate])).length <= 24000)
            low = middle;
          else high = middle - 1;
        }
        candidate.text = `${hit.text.slice(0, low)} [truncated]`;
      }
      bounded.push(candidate);
    }
    return respond(payload(bounded));
  }
  const id = await resolve(args.collection ?? '');
  const meta = await registry.getCollection(id);
  if (!meta) throw new Error('Collection not found');
  const active = collectionEnabled(registry, userId, sid, meta);
  if (name === 'collection_set_enabled') {
    await updateSessionCollection(userId, sid, id, args.enabled === true);
    return respond({ id, enabled: args.enabled });
  }
  if (name === 'record_set_enabled') {
    // Resolver enforces the same ownership and session checks as REST writes.
    if (args.id) {
      const doc = await registry.setDocumentEnabled(
        id,
        args.id,
        args.enabled === true,
      );
      if (!doc) throw new Error('Document not found');
      return respond({ id: doc.id, enabled: doc.enabled });
    }
    const result = await registry.setSourceEnabled(
      id,
      args.source ?? '',
      args.uploadId ?? '',
      args.enabled === true,
    );
    if (!result.updated) throw new Error('Source file not found');
    return respond(result);
  }
  if (name === 'rag_read') {
    const doc = (await readRagDocuments(registry, id, { id: args.id ?? '' }))
      ?.documents[0];
    if (!doc) throw new Error('Document not found');
    const visibility = recordPolicy(doc.metadata, active);
    const attributes = recordAttributes(doc.metadata);
    if (!visibility.visible)
      return respond({ id: doc.id, attributes, reason: visibility.reason });
    const start = args.offset ?? 0;
    const end = Math.min(doc.text.length, start + (args.limit ?? 8000));
    return respond({
      id: doc.id,
      offset: start,
      total: doc.text.length,
      ...(end < doc.text.length ? { next: end } : {}),
      text: doc.text.slice(start, end),
      attributes,
    });
  }
  const page = await readRagDocuments(registry, id, {
    offset: args.offset,
    limit: args.limit ?? 50,
  });
  if (!page) throw new Error('Collection not found');
  return respond({
    total: page.total,
    records: page.documents.map((doc) => {
      const visibility = recordPolicy(doc.metadata, active);
      return {
        id: doc.id,
        attributes: recordAttributes(doc.metadata),
        ...(visibility.visible
          ? {
              title: doc.text.split(/\r?\n/, 1)[0].slice(0, 120),
              ...(typeof doc.metadata.source === 'string'
                ? { source: doc.metadata.source }
                : {}),
            }
          : {
              reason: visibility.reason,
            }),
      };
    }),
  });
}

export function executeRagMcpTool(
  ...args: Parameters<typeof executeRagMcpToolImpl>
): ReturnType<typeof executeRagMcpToolImpl> {
  return withCollectionToolScope(() => executeRagMcpToolImpl(...args));
}
