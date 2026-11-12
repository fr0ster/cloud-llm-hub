import { checkRagAccess, type RagAccessMode } from '@mcp-abap-adt/llm-agent';
import type { CollectionMeta } from '../rag-collections';
import { catalogOwner } from './collection-persistence';
import { withCollectionAccessTarget } from './collection-write-context';
import { getHubRagAccess } from './rag-access';

/** Collection visibility is decided by the library, including role grants. */
export async function checkAccess(
  meta: CollectionMeta,
  userId: string,
  sessionId: string | undefined,
  admin: boolean,
  mode: RagAccessMode = 'read',
): Promise<boolean> {
  if (!sessionId || meta.agentsCopyPending) return false;
  const caller = { sessionId, userId, isAdmin: admin };
  return (
    await withCollectionAccessTarget(meta, () =>
      checkRagAccess(
        caller,
        { name: meta.id, owner: catalogOwner(meta) },
        mode,
        getHubRagAccess().access,
      ),
    )
  ).ok;
}

/** Hub-specific configuration rules; ownership is checked by the library. */
export function collectionAccessError(
  meta: {
    scope?: string;
    owner?: string;
    collectionKind?: string;
    agentsCopyPending?: boolean;
  },
  userId: string,
  mode: 'read' | 'write',
): { status: number; message: string } | undefined {
  if (
    meta.agentsCopyPending ||
    (meta.collectionKind === 'agents' &&
      meta.scope === 'user' &&
      (!userId || userId === 'anonymous' || meta.owner !== userId))
  )
    return { status: 404, message: 'Collection not found' };
  if (mode === 'write' && meta.scope !== 'global' && meta.owner !== userId)
    return { status: 404, message: 'Collection not found' };
  return undefined;
}

/** Apply the same library read decision to collection listings. */
export async function visibleCollections(
  collections: CollectionMeta[],
  userId: string,
  sessionId: string | undefined,
  admin: boolean,
): Promise<CollectionMeta[]> {
  const visible = await Promise.all(
    collections.map((meta) => checkAccess(meta, userId, sessionId, admin)),
  );
  return collections.filter((_meta, index) => visible[index]);
}
