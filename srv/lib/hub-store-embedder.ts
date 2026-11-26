import {
  type IRag,
  type IRagProvider,
  isRagScanner,
  type RagCollectionRecord,
  RagError,
  type RagJsonValue,
  type Result,
} from '@mcp-abap-adt/llm-agent';

export const EMBEDDED_HUB_STORES = ['h_history', 'h_planner_memory'] as const;
export const SESSION_HISTORY_SOURCE = 'session-history';

export function storeAttributes({
  attributes,
}: RagCollectionRecord): Readonly<Record<string, RagJsonValue>> {
  return attributes &&
    typeof attributes === 'object' &&
    !Array.isArray(attributes)
    ? (attributes as Readonly<Record<string, RagJsonValue>>)
    : {};
}

export function isEmbeddedHubStore(record: RagCollectionRecord): boolean {
  return (
    storeAttributes(record).source === SESSION_HISTORY_SOURCE ||
    (record.scope === 'global' &&
      EMBEDDED_HUB_STORES.some((name) => name === record.name))
  );
}

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
      if (!isEmbeddedHubStore(record)) continue;
      const { embedder } = storeAttributes(record);
      const stored = typeof embedder === 'string' ? embedder : undefined;
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

export async function assertStandaloneStoreEmbedder(
  rag: IRag,
  storeName: string,
  accepted: ReadonlySet<string>,
): Promise<Result<void, RagError>> {
  if (!isRagScanner(rag))
    return {
      ok: false,
      error: new RagError(`Cannot scan "${storeName}"`, 'RAG_UNSUPPORTED'),
    };
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await rag.scan(cursor === undefined ? {} : { cursor });
    if (!page.ok) return page;
    for (const { id, metadata } of page.value.records) {
      const { embedder } = metadata;
      if (typeof embedder !== 'string' || !accepted.has(embedder))
        return {
          ok: false,
          error: new RagError(
            `hub store "${storeName}" has record "${id}" with embedder "${typeof embedder === 'string' ? embedder : 'none'}"; run npm run migrate:embeddings`,
            'EMBEDDER_MIGRATION_REQUIRED',
          ),
        };
    }
    cursor = page.value.cursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor))
        return {
          ok: false,
          error: new RagError(`Collection scan did not advance: ${storeName}`),
        };
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  return { ok: true, value: undefined };
}
