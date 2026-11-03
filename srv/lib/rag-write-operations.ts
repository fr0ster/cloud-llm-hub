import crypto from 'node:crypto';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';
import {
  normalizeLogicalId,
  resolveRouteId,
  sessionCollectionId,
  userCollectionId,
} from '../collection-ids';
import {
  type CollectionRegistry,
  type RagDocument,
  sessionCollectionTtlMs,
} from '../rag-collections';
import { isReadOnlyTools } from '../request-session';
import { collectionAccessError } from './collection-access';
import { CollectionBackendError } from './collection-persistence';

import { RagWriteError } from './rag-write-error';
import { buildSkillsPool } from './skills-pool';
import { trustWriteError } from './trust-guard';
import { resolverFor } from './trust-resolver';
import { skillId } from './trusted-skill';

export { RagWriteError } from './rag-write-error';

/** Visibility is checked before applying the stricter trust policy. */
export async function setRagTrust(
  registry: CollectionRegistry,
  collection: string,
  input: { trust: number | null; record?: string },
  identity: RagWriteIdentity,
  update: { displayName?: string; description?: string } = {},
) {
  if (collection === '@skills') {
    const skills = await buildSkillsPool().listSkills();
    if (!skills.ok) throw skills.error;
    const skill =
      input.record === undefined
        ? undefined
        : skills.value.find(
            (s) =>
              skillId(s) === input.record && s.meta.trustAmbiguous !== true,
          );
    const refusal = trustWriteError({
      admin: identity.admin,
      value: input.trust,
      allowNull: input.record !== undefined,
      target: {
        exists: input.record === undefined || skill !== undefined,
        scope: 'global',
        kind: skill?.meta.kind === 'base' ? 'base' : 'informational',
      },
    });
    if (refusal)
      throw new RagWriteError(refusal.code, refusal.status, refusal.code);
    const store = resolverFor(registry).store;
    if (!store) throw new Error('Trust store unavailable');
    if (input.record !== undefined)
      await store.setRecord(
        'skills',
        input.record,
        input.trust,
        identity.userId,
      );
    else if (input.trust !== null)
      await store.setSource('skills', input.trust, identity.userId);
    return { collection };
  }
  const exact = await registry.getCollection(collection);
  const id =
    exact?.id ??
    (await resolveRouteId(
      registry,
      collection,
      identity.userId,
      identity.sessionId,
      false,
    ));
  const meta = id ? await registry.getCollection(id) : null;
  const hidden =
    meta &&
    collectionAccessError(meta, identity.userId, identity.admin, 'read');
  if (
    !id ||
    !meta ||
    hidden ||
    (meta.scope === 'session' && meta.sessionId !== identity.sessionId)
  )
    throw new RagWriteError('NOT_FOUND', 404, 'Collection not found');
  const access = collectionAccessError(
    meta,
    identity.userId,
    identity.admin,
    'write',
  );
  if (access)
    throw new RagWriteError(
      access.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN',
      access.status,
      access.message,
    );
  const refusal = trustWriteError({
    admin: identity.admin,
    value: input.trust,
    allowNull: input.record !== undefined,
    target: {
      exists: true,
      scope: meta.scope,
      collectionKind: meta.collectionKind,
    },
  });
  if (refusal)
    throw new RagWriteError(refusal.code, refusal.status, refusal.code);
  if (input.record !== undefined) {
    const document = await registry.setRecordTrust(
      id,
      input.record,
      input.trust,
      identity.userId,
    );
    if (!document)
      throw new RagWriteError('NOT_FOUND', 404, 'Document not found');
    return { collection: id };
  }
  if (input.trust !== null)
    await registry.updateCollection(id, {
      ...update,
      trust: input.trust,
      trustActor: identity.userId,
    });
  return { collection: id };
}

export const RAG_WRITE_MAX_BYTES = 10 * 1024 * 1024;

export function validateRagWriteSize(input: object): void {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > RAG_WRITE_MAX_BYTES)
    throw new RagWriteError('PAYLOAD_TOO_LARGE', 413, 'Request exceeds 10 MiB');
}

export function validateRagText(text: string): void {
  if (!text)
    throw new RagWriteError('INVALID_ARGUMENT', 400, 'text is required');
}

export interface RagWriteIdentity {
  userId: string;
  sessionId?: string;
  admin: boolean;
}

export async function resolveRagWriteTarget(
  registry: CollectionRegistry,
  target: string,
  identity: RagWriteIdentity,
): Promise<string> {
  const id = await resolveRouteId(
    registry,
    target,
    identity.userId,
    identity.sessionId,
    false,
  );
  const meta = id ? await registry.getCollection(id) : null;
  if (!id || !meta)
    throw new RagWriteError(
      'COLLECTION_NOT_FOUND',
      404,
      'Collection not found',
    );
  const hidden = collectionAccessError(
    meta,
    identity.userId,
    identity.admin,
    'read',
  );
  if (hidden)
    throw new RagWriteError('COLLECTION_NOT_FOUND', 404, hidden.message);
  if (meta.scope === 'global' && isReadOnlyTools())
    throw new RagWriteError(
      'TOOL_FORBIDDEN',
      403,
      'Global mutations require write tools',
    );
  if (meta.collectionKind === 'agents')
    throw new RagWriteError(
      'TOOL_FORBIDDEN',
      403,
      'Agents collections are excluded',
    );
  const refusal = collectionAccessError(
    meta,
    identity.userId,
    identity.admin,
    'write',
  );
  if (refusal)
    throw new RagWriteError(
      refusal.status === 404 ? 'COLLECTION_NOT_FOUND' : 'FORBIDDEN',
      refusal.status,
      refusal.message,
    );
  return id;
}

export function createRagCollection(
  registry: CollectionRegistry,
  input: Parameters<CollectionRegistry['createCollection']>[0],
) {
  return registry.getOrCreateCollection(input);
}

export async function createAgentKnowledgeCollection(
  registry: CollectionRegistry,
  name: string,
  scope: 'user' | 'session',
  identity: RagWriteIdentity,
) {
  let logicalId: string;
  try {
    logicalId = normalizeLogicalId(name);
  } catch (error) {
    throw new RagWriteError(
      'INVALID_ARGUMENT',
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
  const id =
    scope === 'session'
      ? sessionCollectionId(
          logicalId,
          identity.userId,
          identity.sessionId ?? '',
        )
      : userCollectionId(logicalId, identity.userId);
  const existing = await registry.getCollection(id);
  if (existing?.agentsCopyPending)
    throw new RagWriteError(
      'COLLECTION_NOT_FOUND',
      404,
      'Collection not found',
    );
  if (existing?.collectionKind === 'agents')
    throw new RagWriteError(
      'TOOL_FORBIDDEN',
      403,
      'Agents collections are excluded',
    );
  const result = await createRagCollection(registry, {
    id,
    logicalId,
    displayName: logicalId,
    description: '',
    scope,
    owner: identity.userId,
    ...(scope === 'session'
      ? {
          sessionId: identity.sessionId,
          expiresAt: Date.now() + sessionCollectionTtlMs(),
        }
      : {}),
  });
  if (result.collection.collectionKind === 'agents')
    throw new RagWriteError(
      'TOOL_FORBIDDEN',
      403,
      'Agents collections are excluded',
    );
  return result;
}

export function deleteRagCollection(registry: CollectionRegistry, id: string) {
  return registry.deleteCollection(id);
}

export async function addRagRecord(
  registry: CollectionRegistry,
  collection: string,
  input: {
    id?: string;
    createOnly?: boolean;
    text: string;
    metadata?: RagDocument['metadata'];
    namespace?: string;
  },
  options?: CallOptions,
) {
  validateRagText(input.text);
  if (input.createOnly && input.id !== undefined && !input.id)
    throw new RagWriteError('INVALID_ARGUMENT', 400, 'Document id is required');
  const document = {
    id: input.id || crypto.randomUUID(),
    text: input.text,
    metadata: input.metadata || {},
  };
  return registry.addDocument(collection, document, input.namespace, {
    ...options,
    createOnly: input.createOnly,
  });
}

export function updateRagRecord(
  registry: CollectionRegistry,
  collection: string,
  record: string,
  input: Parameters<CollectionRegistry['updateDocument']>[2],
  options?: CallOptions,
) {
  return options
    ? registry.updateDocument(collection, record, input, undefined, options)
    : registry.updateDocument(collection, record, input);
}

export function deleteRagRecord(
  registry: CollectionRegistry,
  collection: string,
  record: string,
) {
  return registry.deleteDocument(collection, record);
}

export function ragWriteFailure(
  error: Error,
  fallback: number,
): { code: string; status: number; message: string } {
  if (error.message.startsWith('TOOL_FORBIDDEN:'))
    return { code: 'TOOL_FORBIDDEN', status: 403, message: error.message };
  return {
    code:
      error instanceof RagWriteError
        ? error.code
        : error instanceof CollectionBackendError
          ? error.cause.code
          : error instanceof RagError
            ? error.code
            : /embed/i.test(error.message)
              ? 'EMBEDDING_FAILED'
              : 'BACKEND_ERROR',
    status:
      error instanceof RagWriteError
        ? error.status
        : error instanceof CollectionBackendError
          ? error.httpStatus
          : fallback,
    message: error.message,
  };
}

/** Deterministic promotion through normal quota and trust-sanitizing ingress. */
export async function persistRagRecords(
  registry: CollectionRegistry,
  source: string,
  targetName: string,
  records: string[] | undefined,
  identity: RagWriteIdentity,
) {
  if (
    !identity.userId ||
    identity.userId === 'anonymous' ||
    !identity.sessionId
  )
    throw new RagWriteError(
      'TOOL_FORBIDDEN',
      403,
      'Authenticated session required',
    );
  const sourceId = await resolveRouteId(
    registry,
    source,
    identity.userId,
    identity.sessionId,
    false,
  );
  const meta = sourceId ? await registry.getCollection(sourceId) : null;
  if (
    !sourceId ||
    !meta ||
    meta.scope !== 'session' ||
    meta.owner !== identity.userId ||
    meta.sessionId !== identity.sessionId
  )
    throw new RagWriteError(
      'COLLECTION_NOT_FOUND',
      404,
      'Session collection not found',
    );
  const documents: RagDocument[] = [];
  if (records) {
    for (const id of new Set(records)) {
      const doc = await registry.getDocument(sourceId, id);
      if (!doc)
        throw new RagWriteError('RECORD_NOT_FOUND', 404, 'Document not found');
      documents.push(doc);
    }
  } else {
    let offset = 0;
    for (;;) {
      const page = await registry.listDocuments(sourceId, {
        offset,
        limit: 200,
      });
      if (!page)
        throw new RagWriteError(
          'COLLECTION_NOT_FOUND',
          404,
          'Collection not found',
        );
      documents.push(
        ...page.documents.filter((doc) => doc.metadata.enabled !== false),
      );
      offset += page.documents.length;
      if (offset >= page.total) break;
    }
  }
  const target = await createAgentKnowledgeCollection(
    registry,
    targetName,
    'user',
    { ...identity, admin: false },
  );
  const timestamp = new Date().toISOString();
  for (const doc of documents) {
    await addRagRecord(registry, target.collection.id, {
      id: doc.id,
      text: doc.text,
      metadata: {
        ...doc.metadata,
        persistenceProvenance: {
          sourceCollection: sourceId,
          sourceRecord: doc.id,
          timestamp,
        },
      },
    });
  }
  return {
    collection: target.collection.id,
    records: documents.map((doc) => doc.id),
  };
}
