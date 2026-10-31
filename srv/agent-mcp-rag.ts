import {
  type IUsageRecorder,
  QueryEmbedding,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import cds from '@sap/cds';
import type { Request } from 'express';
import { z } from 'zod';
import { resolveRouteId } from './collection-ids';
import { collectionAccessError } from './lib/collection-access';
import { restoredDocument } from './lib/collection-persistence';
import {
  collectionDefault,
  collectionEnabled,
  updateSessionCollection,
} from './lib/collection-toggle';
import { withCollectionToolScope } from './lib/collection-write-scope';
import { longSessions, longSessionsIfReady } from './lib/long-session';
import { readRagDocuments } from './lib/rag-read';
import {
  addRagRecord,
  createAgentKnowledgeCollection,
  deleteRagCollection,
  deleteRagRecord,
  RagWriteError,
  ragWriteFailure,
  resolveRagWriteTarget,
  updateRagRecord,
  validateRagText,
  validateRagWriteSize,
} from './lib/rag-write-operations';
import { recordAttributes, recordPolicy } from './lib/record-policy';
import { isRefusal } from './lib/session-retention';
import { requestMeasurement } from './lib/usage/request-records';
import { usageRuntime } from './lib/usage/runtime';
import {
  type CollectionRegistry,
  CollectionSearchRag,
} from './rag-collections';
import {
  isReadOnlyTools,
  profileToolAllowed,
  runWithSessionId,
} from './request-session';
import { resolveSessionKey } from './session-id';

export type { RagMcpTool } from './lib/rag-tool-catalogue';
export { ragMcpSchemas } from './lib/rag-tool-catalogue';

import {
  eligibleRagTools,
  type RagMcpTool,
  ragDescriptions,
  ragMcpSchemas,
  ragToolEffect,
} from './lib/rag-tool-catalogue';

type Args = {
  name?: string;
  scope?: string;
  record?: string;
  text?: string;
  title?: string;
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
type ValidatedArgs = Args & { scope?: 'user' | 'session' };
export function ragTextResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}
interface WriteFields {
  [key: string]:
    | string
    | boolean
    | { code: string; message: string; status: number };
}
export interface RagWriteErrorResult extends WriteFields {
  result: string;
  error: { code: string; message: string; status: number };
}
export interface CollectionCreateResult extends WriteFields {
  result: string;
  collection: string;
  name: string;
  scope: 'user' | 'session';
  created: boolean;
}
export interface CollectionDeleteResult extends WriteFields {
  result: string;
  collection: string;
  deleted: true;
}
export interface RecordAddResult extends WriteFields {
  result: string;
  collection: string;
  record: string;
  created: true;
}
export interface RecordUpdateResult extends WriteFields {
  result: string;
  collection: string;
  record: string;
  updated: true;
}
export interface RecordDeleteResult extends WriteFields {
  result: string;
  collection: string;
  record: string;
  deleted: true;
}
type WriteResult =
  | RagWriteErrorResult
  | CollectionCreateResult
  | CollectionDeleteResult
  | RecordAddResult
  | RecordUpdateResult
  | RecordDeleteResult;
type Result = ReturnType<typeof ragTextResult> & {
  structuredContent?: WriteResult;
};
function writeResult(value: WriteResult): Result {
  return {
    ...ragTextResult(value.result, 'error' in value),
    structuredContent: value,
  };
}
function writeError(code: string, status: number, message: string): Result {
  return writeResult({ result: message, error: { code, status, message } });
}
const writeOutputBase = { result: z.string(), collection: z.string() };
export const ragWriteErrorOutputSchema = z.object({
  result: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number(),
  }),
});
// MCP clients validate errors too; keep an object root with both result variants.
function writeOutputSchema<T extends z.ZodRawShape>(fields: T) {
  const success = z.object({ ...writeOutputBase, ...fields });
  const variants = z.union([success, ragWriteErrorOutputSchema]);
  const resultSchema = success.partial().extend({
    result: z.string(),
    error: ragWriteErrorOutputSchema.shape.error.optional(),
  });
  return resultSchema.refine(
    (value: z.infer<typeof resultSchema>) => variants.safeParse(value).success,
    'Invalid write result',
  );
}
export const ragWriteOutputSchemas = {
  collection_create: writeOutputSchema({
    name: z.string(),
    scope: z.enum(['user', 'session']),
    created: z.boolean(),
  }),
  collection_delete: writeOutputSchema({ deleted: z.literal(true) }),
  record_add: writeOutputSchema({
    record: z.string(),
    created: z.literal(true),
  }),
  record_update: writeOutputSchema({
    record: z.string(),
    updated: z.literal(true),
  }),
  record_delete: writeOutputSchema({
    record: z.string(),
    deleted: z.literal(true),
  }),
};
function isWriteTool(
  name: RagMcpTool,
): name is keyof typeof ragWriteOutputSchemas {
  return name in ragWriteOutputSchemas;
}

export function registerRagMcpTools(
  server: McpServer,
  req: Request,
  userId: string,
  measure: (
    name: RagMcpTool,
    run: (args: Args) => Promise<Result>,
  ) => (args: Args) => Promise<Result>,
): void {
  for (const name of eligibleRagTools()) {
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
        description: ragDescriptions[name],
        annotations: { readOnlyHint: ragToolEffect(name) === 'read' },
        inputSchema: ragMcpSchemas[name],
        ...(isWriteTool(name)
          ? { outputSchema: ragWriteOutputSchemas[name] }
          : {}),
      },
      (args: Args) =>
        run({ ...args, session: args.session ?? resolveSessionKey(req).key }),
    );
  }
}

// Keep the host's lifecycle graph out of cached local adapter construction.
function ragHost(): typeof import('./agent-manager') {
  return require('./agent-manager');
}
async function externalSession(userId: string, key: string) {
  const lifecycle: typeof import('./lib/session-lifecycle') = require('./lib/session-lifecycle');
  return lifecycle.resolveSession(userId, key);
}

/** Validates even direct calls, before acquiring the session queue and lease. */
async function executeRagMcpToolImpl(
  context: RagExecutionContext,
  name: RagMcpTool,
  input: object,
): Promise<Result> {
  const { userId, traceId } = context;
  const fail = (code: string, status: number, message: string): Result =>
    isWriteTool(name) || context.internal
      ? writeError(code, status, message)
      : ragTextResult(message, true);
  if (isWriteTool(name)) {
    try {
      validateRagWriteSize(input);
    } catch (error) {
      return fail(
        'PAYLOAD_TOO_LARGE',
        413,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!userId || userId === 'anonymous')
      return fail('UNAUTHENTICATED', 401, 'Authenticated user required');
  }
  if (
    !context.permissions.allows(name) ||
    (context.readOnly && ragToolEffect(name) === 'write')
  )
    return fail('TOOL_FORBIDDEN', 403, `TOOL_FORBIDDEN: ${name}`);
  const parsed = ragMcpSchemas[name].safeParse(input);
  if (!parsed.success)
    return fail('INVALID_ARGUMENT', 400, parsed.error.message);
  const args: ValidatedArgs = parsed.data;
  if (
    name === 'record_set_enabled' &&
    Boolean(args.id) === Boolean(args.source)
  )
    return ragTextResult('Provide exactly one of id or source', true);
  if (
    context.internal &&
    args.session !== undefined &&
    args.session !== context.sessionKey
  )
    return fail(
      'INVALID_ARGUMENT',
      400,
      'Session must match the enclosing conversation',
    );
  const key = context.internal
    ? context.sessionKey
    : (args.session ?? context.sessionKey);
  if (!key)
    return fail(
      'SESSION_REQUIRED',
      400,
      'SESSION_REQUIRED: call session_open first',
    );
  try {
    const s = context.internal
      ? longSessionsIfReady()?.get(userId, key)
      : await externalSession(userId, key);
    if (!s)
      return context.internal
        ? fail(
            'SESSION_REQUIRED',
            400,
            'SESSION_REQUIRED: call session_open first',
          )
        : fail('SESSION_NOT_FOUND', 404, 'SESSION_NOT_FOUND');
    const run = async () => {
      const {
        leaseSession,
      }: typeof import('./lib/gatekeeper') = require('./lib/gatekeeper');
      const lease = leaseSession(userId, key, 'rag', { presented: true });
      if (isRefusal(lease))
        return fail(
          lease.refused === 'closed'
            ? 'session_closed'
            : 'gatekeeper_retention',
          lease.refused === 'closed' ? 410 : 503,
          lease.refused === 'closed' ? 'SESSION_CLOSED' : 'SESSION_RETENTION',
        );
      try {
        return await runWithSessionId(
          key,
          () =>
            runRagTool(
              userId,
              key,
              name,
              args,
              context.admin,
              traceId,
              context.registry,
            ),
          undefined,
          userId,
        );
      } finally {
        lease.release();
      }
    };
    const result = context.trustedAdmission
      ? await run()
      : await longSessions().run(s, run);
    return 'refused' in result
      ? fail(
          result.refused === 'SESSION_CLOSED' && isWriteTool(name)
            ? 'session_closed'
            : result.refused,
          result.refused === 'SESSION_CLOSED' ? 410 : 429,
          result.refused,
        )
      : result;
  } catch (error) {
    if (
      error instanceof Error &&
      'refused' in error &&
      (error.refused === 'SESSION_LIMIT' ||
        error.refused === 'SESSION_STORE_UNAVAILABLE')
    )
      return fail(error.refused, 503, error.refused);
    if (isWriteTool(name)) {
      const failure = ragWriteFailure(
        error instanceof Error ? error : new Error(String(error)),
        name === 'record_add' || name === 'record_update'
          ? 400
          : name === 'collection_create'
            ? 409
            : 500,
      );
      return writeError(failure.code, failure.status, failure.message);
    }
    return ragTextResult(
      error instanceof RagWriteError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error),
      true,
    );
  }
}

async function runRagTool(
  userId: string,
  sid: string,
  name: RagMcpTool,
  args: ValidatedArgs,
  admin: boolean,
  traceId?: string,
  suppliedRegistry?: CollectionRegistry,
): Promise<Result> {
  const registry = suppliedRegistry ?? ragHost().getCollectionRegistry();
  if (isWriteTool(name)) {
    const identity = { userId, sessionId: sid, admin };
    if (name === 'collection_create') {
      const created = await createAgentKnowledgeCollection(
        registry,
        args.name ?? '',
        args.scope ?? 'user',
        identity,
      );
      return writeResult({
        result: created.created
          ? 'Collection created.'
          : 'Collection already existed.',
        collection: created.collection.id,
        name: created.collection.logicalId ?? '',
        scope: args.scope ?? 'user',
        created: created.created,
      });
    }
    const id = await resolveRagWriteTarget(
      registry,
      args.collection ?? '',
      identity,
    );
    if (name === 'collection_delete') {
      await deleteRagCollection(registry, id);
      return writeResult({
        result: 'Collection deleted.',
        collection: id,
        deleted: true,
      });
    }
    if (name === 'record_delete') {
      if (!(await deleteRagRecord(registry, id, args.record ?? '')))
        throw new RagWriteError('RECORD_NOT_FOUND', 404, 'Document not found');
      return writeResult({
        result: 'Record deleted.',
        collection: id,
        record: args.record ?? '',
        deleted: true,
      });
    }
    validateRagText(args.text ?? '');
    const options = {
      usage: usageRuntime()
        ?.forSession({ userId, sessionId: sid })
        .with({
          ...(traceId ? { requestId: traceId, traceId } : {}),
          role: 'embedding',
          component: 'collection-write',
        }),
    };
    const metadata = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.source !== undefined ? { source: args.source } : {}),
    };
    if (name === 'record_add') {
      const doc = await addRagRecord(
        registry,
        id,
        { id: args.record, createOnly: true, text: args.text ?? '', metadata },
        options,
      );
      return writeResult({
        result: 'Record added.',
        collection: id,
        record: doc.id,
        created: true,
      });
    }
    const doc = await updateRagRecord(
      registry,
      id,
      args.record ?? '',
      { text: args.text, metadata },
      options,
    );
    if (!doc)
      throw new RagWriteError('RECORD_NOT_FOUND', 404, 'Document not found');
    return writeResult({
      result: 'Record updated.',
      collection: id,
      record: doc.id,
      updated: true,
    });
  }
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
    const embedder = ragHost().getQueryEmbedder();
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
  const id =
    name === 'record_set_enabled'
      ? await resolveRagWriteTarget(registry, args.collection ?? '', {
          userId,
          sessionId: sid,
          admin,
        })
      : await resolve(args.collection ?? '');
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

export interface RagExecutionContext {
  readonly registry?: CollectionRegistry;
  readonly userId: string;
  readonly admin: boolean;
  readonly sessionKey?: string;
  readonly internal: boolean;
  readonly trustedAdmission: boolean;
  readonly permissions: { allows(name: string): boolean };
  readonly readOnly: boolean;
  readonly traceId?: string;
  readonly taskId?: string;
  readonly channel: 'openai' | 'anthropic' | 'mcp-agent' | 'rest';
  readonly measurement?: IUsageRecorder;
}

export async function executeRagTool(
  context: RagExecutionContext,
  name: RagMcpTool,
  input: object,
): Promise<Result> {
  const started = Date.now();
  const result = await withCollectionToolScope(() =>
    executeRagMcpToolImpl(context, name, input),
  );
  context.measurement?.record({
    context: {
      userId: context.userId,
      sessionId: context.sessionKey,
      traceId: context.traceId,
      ...(context.taskId ? { taskId: context.taskId } : {}),
      channel: context.channel,
    },
    kind: 'tool.call',
    outcome: result.isError ? 'error' : 'ok',
    tool: name,
    dispatched: true,
    embedded: true,
    transportOutcome: 'ok',
    toolOutcome: result.isError ? 'error' : 'ok',
    durationMs: Date.now() - started,
    requestBytes: Buffer.byteLength(JSON.stringify(input)),
    responseBytes: Buffer.byteLength(JSON.stringify(result)),
  });
  return result;
}

/** External MCP preserves argument/header/cookie precedence and queue admission. */
export function executeRagMcpTool(
  req: Pick<Request, 'headers'>,
  userId: string,
  name: RagMcpTool,
  input: Args,
  traceId?: string,
  registry?: CollectionRegistry,
): Promise<Result> {
  return executeRagTool(
    {
      userId,
      registry,
      admin: cds.context?.user?.is('MCP_Admin') ?? false,
      sessionKey: resolveSessionKey(req).key,
      internal: false,
      trustedAdmission: false,
      permissions: { allows: profileToolAllowed },
      readOnly: isReadOnlyTools(),
      traceId,
      channel: 'mcp-agent',
    },
    name,
    input,
  );
}
