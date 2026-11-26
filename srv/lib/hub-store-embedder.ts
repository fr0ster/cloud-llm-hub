import {
  type IRagProvider,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';

export const EMBEDDED_HUB_STORES = ['h_history', 'h_planner_memory'] as const;

export async function assertHubStoresEmbedder(
  provider: IRagProvider,
  current: string,
): Promise<Result<void, RagError>> {
  if (!provider.describeCollections)
    return {
      ok: false,
      error: new RagError(
        'Hub store embedder check requires a provider catalog',
      ),
    };
  try {
    const catalog = await provider.describeCollections();
    if (!catalog.ok) return catalog;
    for (const record of catalog.value.records) {
      if (
        record.scope !== 'global' ||
        !EMBEDDED_HUB_STORES.some((name) => name === record.name)
      )
        continue;
      const { attributes } = record;
      const stored =
        attributes &&
        typeof attributes === 'object' &&
        'embedder' in attributes &&
        typeof attributes.embedder === 'string'
          ? attributes.embedder
          : undefined;
      if (stored !== current)
        return {
          ok: false,
          error: new RagError(
            `hub store "${record.storeName}" was embedded with "${stored ?? 'none'}", the current embedder is "${current}"; run npm run migrate:embeddings`,
            'EMBEDDER_MIGRATION_REQUIRED',
          ),
        };
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof RagError ? error : new RagError(String(error)),
    };
  }
}
