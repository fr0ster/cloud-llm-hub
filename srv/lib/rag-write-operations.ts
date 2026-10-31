import crypto from 'node:crypto';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';
import {
  normalizeLogicalId,
  resolveToolCollectionId,
  sessionCollectionId,
  userCollectionId,
} from '../collection-ids';
import {
  type CollectionRegistry,
  type RagDocument,
  sessionCollectionTtlMs,
} from '../rag-collections';
import { collectionAccessError } from './collection-access';
import { CollectionBackendError } from './collection-persistence';

import { RagWriteError } from './rag-write-error';

export { RagWriteError } from './rag-write-error';

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
  const id = await resolveToolCollectionId(
    registry,
    target,
    identity.userId,
    identity.sessionId,
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
