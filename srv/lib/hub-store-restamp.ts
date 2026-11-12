import {
  type IRagProvider,
  isRagScanner,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { PROVIDER_DEFAULT_DIMENSION } from './rag-provider-factory';

const stores = new Set([
  'h_dialogue',
  'h_runs',
  'h_sessions',
  'h_planner_memory',
]);

/** Run before the backend owner migration; legacy rows must be read unfiltered. */
export async function restampHubStores(
  provider: IRagProvider,
): Promise<Result<{ rewritten: number }, RagError>> {
  if (!provider.describeCollections || !provider.openCollection)
    return {
      ok: false,
      error: new RagError('Hub restamp requires a provider catalog'),
    };
  try {
    const catalog = await provider.describeCollections();
    if (!catalog.ok) return catalog;
    let rewritten = 0;
    const conflicts: { storeName: string; rowId: string; keys: string[] }[] =
      [];
    // Record writers use the provider default dimension and never embed text.
    const zeroVector = new Array<number>(PROVIDER_DEFAULT_DIMENSION).fill(0);
    for (const record of catalog.value.records) {
      if (!stores.has(record.name)) continue;
      const opened = await provider.openCollection(record);
      if (!opened.ok) return opened;
      const { rag } = opened.value;
      const writer = rag.writer?.();
      if (!isRagScanner(rag) || !writer)
        return {
          ok: false,
          error: new RagError(`Cannot restamp ${record.storeName}`),
        };
      let cursor: string | undefined;
      do {
        const page = await rag.scan({
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!page.ok) return page;
        for (const row of page.value.records) {
          const { sessionId, userId, ...metadata } = row.metadata;
          const planner = record.name === 'h_planner_memory';
          const keys = new Set<string>();
          const check = (source: string, target: string) => {
            const sourceValue = row.metadata[source];
            const targetValue = row.metadata[target];
            if (
              sourceValue !== undefined &&
              targetValue !== undefined &&
              sourceValue !== targetValue
            ) {
              keys.add(source);
              keys.add(target);
            }
          };
          check('userId', 'authorUserId');
          check('sessionId', 'hubSessionId');
          if (planner) {
            check('sessionId', 'namespace');
            check('hubSessionId', 'namespace');
          }
          if (keys.size > 0) {
            conflicts.push({
              storeName: record.storeName,
              rowId: row.id,
              keys: [...keys].sort(),
            });
            continue;
          }
          if (planner) {
            const owner =
              sessionId ??
              (typeof metadata.hubSessionId === 'string'
                ? metadata.hubSessionId
                : undefined);
            if (owner === undefined && userId === undefined) continue;
            if (typeof owner === 'string') metadata.namespace = owner;
            delete metadata.hubSessionId;
          } else {
            if (sessionId === undefined && userId === undefined) continue;
            if (sessionId !== undefined) metadata.hubSessionId = sessionId;
          }
          if (userId !== undefined) metadata.authorUserId = userId;
          if (
            record.name !== 'h_planner_memory' &&
            !writer.upsertPrecomputedRaw
          )
            return {
              ok: false,
              error: new RagError(
                `No precomputed writer for ${record.storeName}`,
              ),
            };
          const result =
            record.name === 'h_planner_memory'
              ? await writer.upsertRaw(row.id, row.text, metadata)
              : await writer.upsertPrecomputedRaw?.(
                  row.id,
                  row.text,
                  zeroVector,
                  metadata,
                );
          if (!result)
            return { ok: false, error: new RagError('Missing restamp writer') };
          if (!result.ok) return result;
          rewritten++;
        }
        if (page.value.cursor !== undefined && page.value.cursor === cursor)
          return {
            ok: false,
            error: new RagError('Hub restamp scan did not advance'),
          };
        cursor = page.value.cursor;
      } while (cursor !== undefined);
    }
    if (conflicts.length > 0)
      return {
        ok: false,
        error: new RagError(
          `Hub restamp conflicts: ${JSON.stringify(conflicts)}`,
          'HUB_RESTAMP_CONFLICT',
        ),
      };
    return { ok: true, value: { rewritten } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof RagError ? error : new RagError(String(error)),
    };
  }
}
