import {
  InMemoryRag,
  type IUsageRecorder,
  QueryEmbedding,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import cds from '@sap/cds';
import type { Request } from 'express';
import { z } from 'zod';
import {
  normalizeLogicalId,
  resolveRouteId,
  sessionCollectionId,
  userCollectionId,
} from './collection-ids';
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
import { compactRagSearch } from './lib/rag-search-context';
import {
  addRagRecord,
  createAgentKnowledgeCollection,
  deleteRagCollection,
  deleteRagRecord,
  persistRagRecords,
  RagWriteError,
  ragWriteFailure,
  resolveRagWriteTarget,
  setRagTrust,
  updateRagRecord,
  validateRagText,
  validateRagWriteSize,
} from './lib/rag-write-operations';
import { readLoopPage } from './lib/read-dedup';
import {
  collectionView,
  recordAttributes,
  recordPolicy,
} from './lib/record-policy';
import { runWithRequestLlms } from './lib/session-llms';
import { isRefusal } from './lib/session-retention';
import { informationalSkillDocuments } from './lib/skills-pool';
import { resolverFor } from './lib/trust-resolver';
import { requestMeasurement } from './lib/usage/request-records';
import { usageRuntime } from './lib/usage/runtime';
import {
  type CollectionRegistry,
  CollectionSearchRag,
} from './rag-collections';
import {
  isReadOnlyTools,
  profileToolAllowed,
  runWithReadOnlyTools,
  runWithSessionId,
} from './request-session';
import { resolveSessionKey } from './session-id';

export type { RagMcpTool } from './lib/rag-tool-catalogue';
export { ragMcpSchemas } from './lib/rag-tool-catalogue';

import {
  type CollectionAddress,
  collectionAddress,
  dialogueRagToolAllowed,
  eligibleRagTools,
  type RagMcpTool,
  ragDescriptions,
  ragMcpSchemas,
  ragSchema,
  ragToolEffect,
} from './lib/rag-tool-catalogue';

type Args = {
  records?: string[];
  trust?: z.infer<ReturnType<typeof z.json>>;
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
interface TrustSetResult extends WriteFields {
  result: string;
  collection: string;
  updated: true;
}
type WriteResult =
  | RagWriteErrorResult
  | CollectionCreateResult
  | CollectionDeleteResult
  | RecordAddResult
  | RecordUpdateResult
  | RecordDeleteResult
  | TrustSetResult;
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
  collection_set_trust: writeOutputSchema({ updated: z.literal(true) }),
  record_set_trust: writeOutputSchema({ updated: z.literal(true) }),
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
        // Let trust reach our canonical zod parser so invalid values return
        // INVALID_TRUST rather than the SDK's generic argument error.
        inputSchema:
          name === 'collection_set_trust' || name === 'record_set_trust'
            ? ragMcpSchemas[name].extend({ trust: z.json().optional() })
            : ragMcpSchemas[name],
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

function parseCollectionLabel(value: string): CollectionAddress | undefined {
  const match = /^(global|user|session)[/:]([^/:]+)$/.exec(value);
  if (!match) return undefined;
  const scope = match[1];
  const collection = match[2];
  if (scope !== 'global' && scope !== 'user' && scope !== 'session')
    return undefined;
  return { scope, collection };
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
  if (isWriteTool(name) || name === 'rag_persist') {
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
  // Only reference readers may cross a denied profile boundary to resolve a target.
  if (
    !context.permissions.allows(name) &&
    !(
      context.dialogueRole === 'worker' &&
      (name === 'rag_read' || name === 'collection_records')
    )
  )
    return fail('TOOL_FORBIDDEN', 403, `TOOL_FORBIDDEN: ${name}`);
  if (!dialogueRagToolAllowed(name, context.dialogueRole))
    return fail('TOOL_FORBIDDEN', 403, `TOOL_FORBIDDEN: ${name}`);
  const readOnlyForbidden =
    context.readOnly &&
    ragToolEffect(name) !== 'read' &&
    !(ragToolEffect(name) === 'knowledge' && context.dialogueRole === 'worker');
  // Inspect mutation targets independently of role argument schemas. A refusal
  // must not suggest that retrying with different arguments grants permission.
  if (ragToolEffect(name) !== 'read' && name !== 'rag_persist') {
    const targetInput = z
      .object({
        collection: z
          .union([
            z.string(),
            z.object({ collection: z.string(), scope: z.string() }),
          ])
          .optional(),
        name: z.string().optional(),
        scope: z.string().optional(),
      })
      .safeParse(input);
    if (targetInput.success) {
      const raw = targetInput.data;
      if (name === 'collection_create' && raw.name) {
        let logical: string | undefined;
        try {
          logical = normalizeLogicalId(raw.name);
        } catch {
          // Invalid names are handled by the argument validation below.
        }
        if (logical === 'task-results')
          return fail(
            'TOOL_FORBIDDEN',
            403,
            'Reserved name: task-results is reserved for the session store',
          );
        if (
          context.dialogueRole === 'worker' &&
          raw.scope &&
          raw.scope !== 'session'
        )
          return fail(
            'TOOL_FORBIDDEN',
            403,
            'Workers create session collections only',
          );
      }
      const target =
        typeof raw.collection === 'string'
          ? (parseCollectionLabel(raw.collection) ?? raw.collection)
          : raw.collection;
      if (target) {
        const registry = context.registry ?? ragHost().getCollectionRegistry();
        const collection =
          typeof target === 'string' ? target : target.collection;
        // Only reveal reserved metadata for the caller's own session.
        const exact = await registry.getCollection(collection);
        const reserved =
          collection === 'task-results'
            ? true
            : exact?.collectionKind === 'task-results' &&
              exact.scope === 'session' &&
              exact.owner === userId &&
              exact.sessionId === context.sessionKey;
        if (reserved)
          return fail(
            'TOOL_FORBIDDEN',
            403,
            'TOOL_FORBIDDEN: task results are written by the session store only',
          );
      }
    }
  }
  // Existing worker callers may explicitly request session creation. Keep that
  // compatible without advertising scope or accepting a different write scope.
  const schema =
    context.dialogueRole === 'worker' && name === 'collection_create'
      ? ragSchema('collection_create', 'worker').extend({
          scope: z.literal('session').optional(),
        })
      : ragSchema(name, context.dialogueRole);
  let schemaInput = input;
  if ('collection' in input && typeof input.collection === 'string') {
    const address = parseCollectionLabel(input.collection);
    if (
      address &&
      context.dialogueRole === 'coordinator' &&
      (name === 'rag_read' || name === 'collection_records')
    )
      schemaInput = { ...input, collection: address };
    if (
      address &&
      context.dialogueRole === 'worker' &&
      ragToolEffect(name) !== 'read'
    ) {
      if (address.scope !== 'session')
        return fail(
          'TOOL_FORBIDDEN',
          403,
          'Workers write session collections only',
        );
      schemaInput = { ...input, collection: address.collection };
    }
  }
  if (context.dialogueRole === 'coordinator' && 'collections' in input) {
    const labels = z
      .array(z.union([z.string(), collectionAddress]))
      .safeParse(input.collections);
    if (labels.success)
      schemaInput = {
        ...schemaInput,
        collections: labels.data.map((value) =>
          typeof value === 'string'
            ? (parseCollectionLabel(value) ?? value)
            : value,
        ),
      };
  }
  if (name === 'rag_persist') {
    for (const field of ['from', 'to'] as const) {
      const value =
        field === 'from'
          ? 'from' in input
            ? input.from
            : undefined
          : 'to' in input
            ? input.to
            : undefined;
      if (typeof value !== 'string') continue;
      const address = parseCollectionLabel(value);
      if (address) schemaInput = { ...schemaInput, [field]: address };
    }
  }
  const parsed = schema.safeParse(schemaInput);
  if (!parsed.success && readOnlyForbidden)
    return fail('TOOL_FORBIDDEN', 403, `TOOL_FORBIDDEN: ${name}`);
  if (!parsed.success)
    return fail(
      (name === 'collection_set_trust' || name === 'record_set_trust') &&
        parsed.error.issues.some((issue) => issue.path[0] === 'trust')
        ? 'INVALID_TRUST'
        : 'INVALID_ARGUMENT',
      400,
      parsed.error.message,
    );
  try {
    const registry = context.registry ?? ragHost().getCollectionRegistry();
    const resolvedCollections = new Set<string>();
    const resolveAddress = async (address: CollectionAddress) => {
      const resolved = (id: string) => {
        resolvedCollections.add(id);
        return id;
      };
      if (
        context.dialogueRole === 'worker' &&
        ragToolEffect(name) !== 'read' &&
        address.scope !== 'session'
      )
        throw new RagWriteError(
          'TOOL_FORBIDDEN',
          403,
          'Workers write session collections only',
        );
      if (address.scope === 'global' && address.collection === '@skills')
        return resolved('@skills');
      const global =
        address.scope === 'global'
          ? await registry.getCollection(address.collection)
          : null;
      if (
        global?.scope === 'global' &&
        (global.logicalId ?? global.id) === address.collection
      )
        return resolved(global.id);
      const candidates = (await registry.listCollections(userId)).filter(
        (c) =>
          c.scope === address.scope &&
          (c.scope === 'global' || c.owner === userId) &&
          (c.scope !== 'session' || c.sessionId === context.sessionKey),
      );
      const found = candidates.find(
        (c) => (c.logicalId ?? c.id) === address.collection,
      );
      if (!found)
        throw new RagWriteError(
          'COLLECTION_NOT_FOUND',
          404,
          `Collection ${address.scope}/${address.collection} not found. Candidates: ${candidates.map((c) => `${c.scope}/${c.logicalId ?? c.id}`).join(', ') || '(none)'}`,
        );
      return resolved(found.id);
    };
    const data: Omit<ValidatedArgs, 'collection' | 'collections'> & {
      collection?: string | CollectionAddress;
      collections?: (string | CollectionAddress)[];
      from?: CollectionAddress;
      to?: CollectionAddress;
    } = parsed.data;
    const { collection, collections, from, to, ...rest } = data;
    const args: ValidatedArgs = { ...rest };
    const resolveCollection = async (
      value: string | CollectionAddress,
    ): Promise<string> => {
      if (typeof value !== 'string') return resolveAddress(value);
      const address = parseCollectionLabel(value);
      if (address) return resolveAddress(address);
      if (context.dialogueRole === 'worker' && ragToolEffect(name) !== 'read')
        return resolveAddress({ scope: 'session', collection: value });
      return value;
    };
    if (typeof collection === 'string')
      args.collection = await resolveCollection(collection);
    if (collections) {
      args.collections = await Promise.all(collections.map(resolveCollection));
    }
    if (typeof collection === 'object')
      args.collection = await resolveAddress(collection);
    if (from && to) {
      args.collection = await resolveAddress(from);
      args.name = to.collection;
    }
    if (context.dialogueRole === 'worker' && ragToolEffect(name) !== 'read') {
      if (name === 'collection_create') args.scope = 'session';
    }
    let createLogicalId: string | undefined;
    if (name === 'collection_create') {
      try {
        createLogicalId = normalizeLogicalId(args.name ?? '');
      } catch (error) {
        return fail(
          'INVALID_ARGUMENT',
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (createLogicalId === 'task-results')
      return fail(
        'TOOL_FORBIDDEN',
        403,
        'Reserved name: task-results is reserved for the session store',
      );
    const target =
      args.collection ?? (name === 'collection_create' ? args.name : undefined);
    const targetSession = context.internal
      ? context.sessionKey
      : (args.session ?? context.sessionKey);
    const targetId =
      name === 'collection_create'
        ? args.scope === 'session'
          ? sessionCollectionId(createLogicalId!, userId, targetSession ?? '')
          : userCollectionId(createLogicalId!, userId)
        : target
          ? await resolveRouteId(registry, target, userId, targetSession, false)
          : undefined;
    // Trust mutations can resolve exact physical ids with admin privileges.
    // Inspect that target too, even when ordinary routing hides its owner/session.
    const targetMeta = targetId
      ? await registry.getCollection(targetId)
      : target && ragToolEffect(name) !== 'read' && name !== 'rag_persist'
        ? await registry.getCollection(target)
        : null;
    const ownTaskResults =
      targetMeta?.collectionKind === 'task-results' &&
      targetMeta.scope === 'session' &&
      targetMeta.owner === userId &&
      targetMeta.sessionId === context.sessionKey;
    if (
      targetMeta?.collectionKind === 'task-results' &&
      !ownTaskResults &&
      (name === 'collection_set_trust' || name === 'record_set_trust')
    )
      return fail('NOT_FOUND', 404, 'Collection not found');
    if (
      ownTaskResults &&
      ragToolEffect(name) !== 'read' &&
      name !== 'rag_persist'
    )
      return fail(
        'TOOL_FORBIDDEN',
        403,
        'TOOL_FORBIDDEN: task results are written by the session store only',
      );
    const referenceRead =
      context.dialogueRole === 'worker' &&
      ownTaskResults &&
      (name === 'rag_read' || name === 'collection_records');
    if (
      (!context.permissions.allows(name) && !referenceRead) ||
      readOnlyForbidden
    )
      return fail('TOOL_FORBIDDEN', 403, `TOOL_FORBIDDEN: ${name}`);
    if (name === 'rag_persist' && context.dialogueRole !== 'coordinator')
      return fail(
        'TOOL_FORBIDDEN',
        403,
        'Persistence requires dialogue coordinator',
      );
    if (context.dialogueRole === 'worker' && ragToolEffect(name) !== 'read') {
      if (name === 'collection_create') {
        if (args.scope !== 'session')
          return fail(
            'TOOL_FORBIDDEN',
            403,
            'Workers create session collections only',
          );
      } else if (
        name === 'record_add' ||
        name === 'record_update' ||
        name === 'record_set_enabled'
      ) {
        if (
          targetMeta?.scope !== 'session' ||
          targetMeta.owner !== userId ||
          targetMeta.sessionId !== context.sessionKey
        )
          return fail(
            'TOOL_FORBIDDEN',
            403,
            'Workers write only their own session collections',
          );
      } else return fail('TOOL_FORBIDDEN', 403, 'Worker mutation unavailable');
    }
    if (
      name === 'record_set_enabled' &&
      Boolean(args.id) === Boolean(args.source)
    )
      return ragTextResult('Provide exactly one of id or source', true);
    if (
      (context.internal || context.dialogueRole !== undefined) &&
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
    if (
      context.internal &&
      context.statelessRead &&
      context.readOnly &&
      ragToolEffect(name) === 'read'
    )
      return await runRagTool(
        userId,
        key,
        name,
        args,
        false,
        traceId,
        context.registry,
        true,
        context.dialogueRole,
        resolvedCollections,
      );
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
        const invoke = () =>
          runRagTool(
            userId,
            key,
            name,
            args,
            context.admin,
            traceId,
            context.registry,
            false,
            context.dialogueRole,
            resolvedCollections,
          );
        return await runWithSessionId(
          key,
          () => (context.readOnly ? runWithReadOnlyTools(invoke) : invoke()),
          undefined,
          userId,
        );
      } finally {
        lease.release();
      }
    };
    const result = context.trustedAdmission
      ? await runWithRequestLlms(s, run)
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
    if (error instanceof RagWriteError && context.dialogueRole)
      return fail(error.code, error.status, error.message);
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
  hideAgents = false,
  role?: 'worker' | 'coordinator',
  resolvedCollections: ReadonlySet<string> = new Set(),
): Promise<Result> {
  const registry = suppliedRegistry ?? ragHost().getCollectionRegistry();
  if (name === 'rag_persist') {
    const target = await persistRagRecords(
      registry,
      args.collection ?? '',
      args.name ?? '',
      args.records,
      { userId, sessionId: sid, admin: false },
    );
    return ragTextResult(
      JSON.stringify(
        role === 'coordinator'
          ? { ...target, scope: 'user', collection: args.name }
          : target,
      ),
    );
  }
  if (isWriteTool(name)) {
    const identity = { userId, sessionId: sid, admin };
    if (name === 'collection_set_trust' || name === 'record_set_trust') {
      const parsed = ragMcpSchemas[name].parse(args);
      const result = await setRagTrust(
        registry,
        parsed.collection,
        {
          trust: parsed.trust,
          ...('record' in parsed ? { record: parsed.record } : {}),
        },
        identity,
      );
      return writeResult({
        result: 'Trust updated.',
        collection: result.collection,
        updated: true,
      });
    }
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
  const label = async (id: string) => {
    if (id === '@skills') return 'global/@skills';
    const meta = await registry.getCollection(id);
    return meta ? `${meta.scope}/${meta.logicalId ?? meta.id}` : id;
  };
  const respond = (value: object) =>
    ragTextResult(
      JSON.stringify(
        role && args.collection === '@skills'
          ? { collection: 'global/@skills', ...value }
          : value,
      ),
    );
  const resolve = async (entry: string) => {
    if (role === 'coordinator' && entry === '@skills') return entry;
    const exact =
      role === 'coordinator' ? await registry.getCollection(entry) : null;
    const id =
      resolvedCollections.has(entry) || exact?.scope === 'global'
        ? entry
        : await resolveRouteId(registry, entry, userId, sid, false);
    if (!id) throw new Error('Collection not found');
    const meta = await registry.getCollection(id);
    if (!meta) throw new Error('Collection not found');
    if (
      meta.collectionKind === 'agents' &&
      (hideAgents ||
        name === 'record_set_enabled' ||
        name === 'collection_set_enabled')
    )
      throw new Error('TOOL_FORBIDDEN: agents configuration is REST-only');
    if (meta.scope === 'session' && meta.sessionId !== sid)
      throw new Error('Collection not found');
    const refusal = collectionAccessError(
      meta,
      userId,
      admin,
      name === 'record_set_enabled' ? 'write' : 'read',
    );
    if (refusal) throw new Error(refusal.message);
    return id;
  };
  if (
    args.collection === '@skills' &&
    (name === 'rag_read' || name === 'collection_records')
  ) {
    const all = await informationalSkillDocuments(resolverFor(registry));
    if (name === 'rag_read') {
      const doc = all.find((item) => item.id === args.id);
      if (!doc) throw new Error('Document not found');
      const input = await resolverFor(registry).inputForSkill(
        doc.id,
        false,
        doc.metadata.kind === 'correction' ? 'correction' : 'system',
      );
      const start = args.offset ?? 0;

      const page = readLoopPage(
        traceId,
        '@skills',
        doc.id,
        doc.text,
        start,
        args.limit,
        (page) =>
          respond({ ...page, attributes: recordAttributes(doc, input) })
            .content,
      );
      return respond(
        'alreadyRead' in page
          ? page
          : { ...page, attributes: recordAttributes(doc, input) },
      );
    }
    const offset = args.offset ?? 0;
    return respond({
      total: all.length,
      records: await Promise.all(
        all.slice(offset, offset + (args.limit ?? 50)).map(async (doc) => ({
          id: doc.id,
          title: doc.text.split(/\r?\n/, 1)[0].slice(0, 120),
          attributes: recordAttributes(
            doc,
            await resolverFor(registry).inputForSkill(
              doc.id,
              false,
              doc.metadata.kind === 'correction' ? 'correction' : 'system',
            ),
          ),
        })),
      ),
    });
  }
  if (name === 'collections_list') {
    const collections = await registry.listCollections(
      userId && userId !== 'anonymous' ? userId : undefined,
    );
    return respond({
      collections: collections
        .filter(
          (c) =>
            (!hideAgents || c.collectionKind !== 'agents') &&
            (c.scope !== 'session' || c.sessionId === sid),
        )
        .map((c) =>
          role === 'coordinator'
            ? {
                scope: c.scope,
                collection: c.logicalId ?? c.id,
                records: c.documentCount,
                enabled: collectionEnabled(registry, userId, sid, c),
              }
            : {
                id: c.id,
                ...(role
                  ? { collection: `${c.scope}/${c.logicalId ?? c.id}` }
                  : {}),
                name: c.displayName,
                scope: c.scope,
                collectionKind: c.collectionKind,
                enabled: collectionEnabled(registry, userId, sid, c),
                defaultEnabled: collectionDefault(registry, userId, c),
                documents: c.documentCount,
                ...(() => {
                  const view = collectionView(
                    c,
                    resolverFor(registry).inputFor(
                      { id: '', text: '', createdAt: '', metadata: {} },
                      c,
                    ),
                  );
                  return view.trusted
                    ? {
                        trusted: true,
                        trust: view.trust,
                        trustClass: view.trustClass,
                        ...(view.trustOverride !== undefined
                          ? { trustOverride: view.trustOverride }
                          : {}),
                      }
                    : { trusted: false };
                })(),
              },
        ),
    });
  }
  if (name === 'rag_search') {
    const entries =
      args.collections ??
      (await registry.listCollections(userId))
        .filter(
          (c) =>
            c.collectionKind !== 'agents' &&
            c.collectionKind !== 'task-results' &&
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
      source?: string;
      trust?: number;
    }[] = [];
    const unavailable: { collection: string; error: string }[] = [];
    for (const id of ids) {
      try {
        if (role === 'coordinator' && id === '@skills') {
          const documents = await informationalSkillDocuments(
            resolverFor(registry),
          );
          const store = new InMemoryRag();
          for (const doc of documents) {
            const saved = await store.upsert(doc.text, { id: doc.id });
            if (!saved.ok) throw saved.error;
          }
          const result = await store.query(
            new TextOnlyEmbedding(args.query ?? ''),
            args.k ?? 8,
          );
          if (!result.ok) throw result.error;
          for (const hit of result.value) {
            const doc = documents.find((doc) => doc.id === hit.metadata.id);
            if (!doc) continue;
            hits.push({
              collection: 'global/@skills',
              id: doc.id,
              text: doc.text,
              score: hit.score,
              title: doc.text.split(/\r?\n/, 1)[0].slice(0, 120),
              ...recordAttributes(
                doc,
                await resolverFor(registry).inputForSkill(
                  doc.id,
                  false,
                  doc.metadata.kind === 'correction' ? 'correction' : 'system',
                ),
              ),
            });
          }
          continue;
        }
        const meta = await registry.getCollection(id);
        if (
          !meta ||
          meta.collectionKind === 'agents' ||
          meta.collectionKind === 'task-results' ||
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
              collection: role ? await label(id) : id,
              id: doc.id,
              title: doc.text.split(/\r?\n/, 1)[0].slice(0, 120),
              text: doc.text,
              score: hit.score,
              ...(() => {
                const attributes = recordAttributes(
                  doc,
                  resolverFor(registry).inputFor(doc, meta),
                );
                return attributes.trusted
                  ? { source: attributes.source, trust: attributes.trust }
                  : {};
              })(),
            });
        }
        hits.push(...collectionHits);
      } catch (error) {
        const note = {
          collection: role ? await label(id) : id,
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
    if (compactRagSearch())
      return respond({
        hits: hits
          .sort((a, b) => b.score - a.score)
          .slice(0, args.k ?? 8)
          .map(({ text, ...hit }) => ({
            ...hit,
            snippet: text.slice(0, 400),
            textLength: text.length,
          })),
        ...(unavailable.length ? { unavailable } : {}),
      });
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
    const attributes = recordAttributes(
      doc,
      resolverFor(registry).inputFor(doc, meta),
    );
    if (!visibility.visible)
      return respond({
        ...(role ? { collection: await label(id) } : {}),
        id: doc.id,
        attributes,
        reason: visibility.reason,
      });
    const start = args.offset ?? 0;

    const page = readLoopPage(
      traceId,
      id,
      doc.id,
      doc.text,
      start,
      args.limit,
      (page) => respond({ ...page, attributes }).content,
    );
    return respond({
      ...(role ? { collection: await label(id) } : {}),
      ...('alreadyRead' in page ? page : { ...page, attributes }),
    });
  }
  const page = await readRagDocuments(registry, id, {
    offset: args.offset,
    limit: args.limit ?? 50,
  });
  if (!page) throw new Error('Collection not found');
  return respond({
    ...(role ? { collection: await label(id) } : {}),
    total: page.total,
    records: page.documents.map((doc) => {
      const visibility = recordPolicy(doc.metadata, active);
      return {
        id: doc.id,
        attributes: recordAttributes(
          doc,
          resolverFor(registry).inputFor(doc, meta),
        ),
        ...(visibility.visible
          ? {
              ...(meta.collectionKind === 'task-results'
                ? {
                    taskId: doc.metadata.taskId,
                    stepId: doc.metadata.stepId,
                    worker: doc.metadata.worker,
                    goal: doc.metadata.goal,
                    summary: doc.metadata.summary,
                    chars: doc.metadata.chars,
                    outcome: doc.metadata.outcome,
                  }
                : { title: doc.text.split(/\r?\n/, 1)[0].slice(0, 120) }),
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
  readonly dialogueRole?: 'worker' | 'coordinator';
  readonly registry?: CollectionRegistry;
  readonly userId: string;
  readonly admin: boolean;
  readonly sessionKey?: string;
  readonly internal: boolean;
  readonly statelessRead?: boolean;
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

/** External MCP preserves argument/header precedence and queue admission. */
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
