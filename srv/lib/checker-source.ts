import type { RagCaller, ToolTrust } from '@mcp-abap-adt/llm-agent';
import { sessionCollectionId, userCollectionId } from '../collection-ids';
import type { CollectionRegistry } from '../rag-collections';
import { profileToolAllowed } from '../request-session';
import { checkAccess, collectionAccessError } from './collection-access';
import { collectionEnabled } from './collection-toggle';
import { isDialogueResultReader } from './dialogue-rag-scope';
import type { CollectionAddress } from './rag-tool-catalogue';
import { recordPolicy } from './record-policy';
import type { RagTarget } from './tool-journal';
import { resolverFor } from './trust-resolver';

export type EvidenceProvenance = NonNullable<ReturnType<ToolTrust>>;
export interface CheckerSource {
  text: string;
  provenance?: EvidenceProvenance;
}

async function readableCollection(
  registry: CollectionRegistry,
  { userId, sessionId, isAdmin }: RagCaller,
  target: CollectionAddress,
) {
  const { collection, scope } = target;
  const allowed = profileToolAllowed('rag_read');
  const referenceRead =
    isDialogueResultReader('rag_read') &&
    scope === 'session' &&
    collection === 'task-results';
  if (!allowed && !referenceRead) return undefined;
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
    (!allowed &&
      (meta.collectionKind !== 'task-results' ||
        meta.owner !== userId ||
        meta.sessionId !== sessionId)) ||
    collectionAccessError(meta, userId, 'read') ||
    !(await checkAccess(meta, userId, sessionId, isAdmin === true))
  )
    return undefined;
  return meta;
}

export async function readCheckerSource(
  registry: CollectionRegistry,
  caller: RagCaller,
  target: CollectionAddress,
  recordId: string,
): Promise<CheckerSource | undefined> {
  const meta = await readableCollection(registry, caller, target);
  if (!meta) return undefined;
  const record = await registry.getDocument(meta.id, recordId);
  if (
    !record ||
    !recordPolicy(
      record.metadata,
      collectionEnabled(registry, caller.userId, caller.sessionId, meta),
    ).visible
  )
    return undefined;
  return {
    text: record.text,
    provenance: record.trusted
      ? { source: record.source, trust: record.trust }
      : undefined,
  };
}

/** A write result is journal evidence even when its record was deleted. */
export async function checkerRagResultProvenance(
  registry: CollectionRegistry,
  caller: RagCaller,
  target: RagTarget,
): Promise<EvidenceProvenance> {
  const resolver = resolverFor(registry);
  const meta = await readableCollection(registry, caller, target).catch(
    () => undefined,
  );
  const record =
    meta && target.record
      ? await registry.getDocument(meta.id, target.record).catch(() => null)
      : undefined;
  if (record?.trusted) return { source: record.source, trust: record.trust };
  const collection = meta?.displayName || target.collection;
  return {
    source: `${target.scope}:${collection}${target.record ? `/${target.record}` : ''}`,
    trust: meta
      ? resolver.collection(meta)
      : resolver.classDefault(target.scope),
  };
}
