import type { RagCaller } from '@mcp-abap-adt/llm-agent';
import { sessionCollectionId, userCollectionId } from '../collection-ids';
import type { CollectionRegistry } from '../rag-collections';
import { checkAccess, collectionAccessError } from './collection-access';
import { collectionEnabled } from './collection-toggle';
import type { CollectionAddress } from './rag-tool-catalogue';
import { recordPolicy } from './record-policy';

export async function readCheckerSource(
  registry: CollectionRegistry,
  { userId, sessionId, isAdmin }: RagCaller,
  target: CollectionAddress,
  recordId: string,
): Promise<string | undefined> {
  const { collection, scope } = target;
  const id =
    scope === 'session'
      ? sessionCollectionId(collection, userId, sessionId)
      : scope === 'user'
        ? userCollectionId(collection, userId)
        : collection;
  const meta = await registry.getCollection(id);
  if (
    !meta ||
    meta.scope !== scope ||
    (meta.logicalId ?? meta.id) !== collection ||
    collectionAccessError(meta, userId, 'read') ||
    !(await checkAccess(meta, userId, sessionId, isAdmin === true))
  )
    return undefined;
  const record = await registry.getDocument(id, recordId);
  if (
    !record ||
    !recordPolicy(
      record.metadata,
      collectionEnabled(registry, userId, sessionId, meta),
    ).visible
  )
    return undefined;
  return record.text;
}
