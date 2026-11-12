import {
  InMemoryRagProvider,
  type IRagProvider,
  type RagScanRecord,
} from '@mcp-abap-adt/llm-agent';
export function legacyProvider(
  rows: RagScanRecord[],
  provider: IRagProvider = new InMemoryRagProvider({
    name: 'migration',
    supportedScopes: ['session', 'global'],
  }),
): IRagProvider {
  if (
    !provider.describeCollections ||
    !provider.openCollection ||
    !provider.deleteCollection
  )
    throw new Error('Catalog required');
  const describe = provider.describeCollections.bind(provider);
  const open = provider.openCollection.bind(provider);
  let legacy = true;
  const remove = provider.deleteCollection.bind(provider);
  return {
    ...provider,
    name: provider.name,
    kind: provider.kind,
    editable: true,
    supportedScopes: provider.supportedScopes,
    createCollection: provider.createCollection.bind(provider),
    describeCollections: async () => {
      const catalog = await describe();
      if (!catalog.ok) return catalog;
      return {
        ok: true,
        value: {
          ...catalog.value,
          records: [
            ...catalog.value.records,
            ...(legacy
              ? [
                  {
                    name: 'h_history',
                    storeName: 'h_history',
                    scope: 'global' as const,
                  },
                ]
              : []),
          ],
        },
      };
    },
    openCollection: async (record) =>
      record.storeName === 'h_history'
        ? {
            ok: true,
            value: {
              rag: {
                query: async () => ({ ok: true, value: [] }),
                getById: async () => ({ ok: true, value: null }),
                healthCheck: async () => ({ ok: true, value: undefined }),
                scan: async () => ({ ok: true, value: { records: rows } }),
              },
              editor: {
                upsert: async () => ({ ok: true, value: { id: 'unused' } }),
                deleteById: async () => ({ ok: true, value: false }),
              },
            },
          }
        : open(record),
    deleteCollection: async (name) => {
      if (name === 'h_history') {
        legacy = false;
        return { ok: true, value: undefined };
      }
      return remove(name);
    },
  };
}
