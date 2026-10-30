import type { CollectionRegistry } from '../rag-collections';

/** Agent configuration is read from the backend on every readback. */
export async function readRagDocuments(
  registry: CollectionRegistry,
  collectionId: string,
  options: {
    id?: string;
    offset?: number;
    limit?: number;
    canonical?: boolean;
  },
) {
  const meta = await registry.getCollection(collectionId);
  if (meta?.collectionKind === 'agents') {
    const current = await registry.readAgentCollection(collectionId);
    if (!current) return null;
    const documents =
      options.id === undefined
        ? current.documents.slice(
            options.offset ?? 0,
            (options.offset ?? 0) + (options.limit ?? 50),
          )
        : current.documents.filter((doc) => doc.id === options.id);
    return { documents, total: current.documents.length };
  }
  if (options.id !== undefined) {
    const doc =
      (options.canonical
        ? await registry.findActiveByCanonicalKey(collectionId, options.id)
        : null) ?? (await registry.getDocument(collectionId, options.id));
    return { documents: doc ? [doc] : [], total: doc ? 1 : 0 };
  }
  return registry.listDocuments(collectionId, options);
}
