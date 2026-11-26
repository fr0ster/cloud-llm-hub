import {
  embedDocumentRecords,
  type IDocumentEmbedder,
  type IEmbedResult,
  type IRagBackendWriter,
  type IRagProvider,
  isRagCatalogUpdater,
  isRagScanner,
  type RagCollectionRecord,
  RagError,
  type RagJsonValue,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { encodeEmbedderAttribute } from './collection-persistence';
import { EMBEDDED_HUB_STORES } from './hub-store-embedder';

export interface EmbedderMigrationOptions {
  current: string;
  compatible: ReadonlySet<string>;
  embedder: IDocumentEmbedder;
  /** Alternate path to the same model, selected by the logical catalog name. */
  storeEmbedder?: (storeName: string) => IDocumentEmbedder;
  dimension: number;
  log: (line: string) => void;
}

export interface StoreMigration {
  storeName: string;
  action: 'reembedded' | 'restamped' | 'current';
  records: number;
  fragments: number;
  ms: number;
}

export interface EmbedderMigrationReport {
  stores: StoreMigration[];
  promptTokens: number;
  tokensReported: boolean;
}

const ZERO_VECTOR_HUB_STORES = new Set([
  'h_sessions',
  'h_runs',
  'h_trust',
  'h_dialogue',
]);

type PrecomputedRecord = Parameters<
  NonNullable<IRagBackendWriter['upsertManyPrecomputedRaw']>
>[0][number];

function storeAttributes({
  attributes,
}: RagCollectionRecord): Readonly<Record<string, RagJsonValue>> {
  return attributes &&
    typeof attributes === 'object' &&
    !Array.isArray(attributes)
    ? (attributes as Readonly<Record<string, RagJsonValue>>)
    : {};
}

export function isEmbeddedStore(record: RagCollectionRecord): boolean {
  if (ZERO_VECTOR_HUB_STORES.has(record.name)) return false;
  const attributes = storeAttributes(record);
  if (attributes.collectionKind === 'task-results') return false;
  return (
    'embedder' in attributes ||
    (record.scope === 'global' &&
      EMBEDDED_HUB_STORES.some((name) => name === record.name))
  );
}

export async function migrateEmbeddings(
  provider: IRagProvider,
  opts: EmbedderMigrationOptions,
): Promise<Result<EmbedderMigrationReport, RagError>> {
  const report: EmbedderMigrationReport = {
    stores: [],
    promptTokens: 0,
    tokensReported: false,
  };
  const accepted = new Set([opts.current, ...opts.compatible]);
  const recordUsage = ({ usage }: IEmbedResult) => {
    if (usage) {
      report.promptTokens += usage.promptTokens;
      report.tokensReported = true;
    }
  };

  let context = `catalog for "${provider.name}"`;
  try {
    if (!provider.describeCollections)
      throw new RagError('Embedder migration requires a provider catalog');
    const catalog = await provider.describeCollections();
    if (!catalog.ok) throw catalog.error;
    if (catalog.value.rejected.length) {
      const rejected = catalog.value.rejected
        .map(
          ({ storeName, reason }) => `${storeName ?? '(unnamed)'}: ${reason}`,
        )
        .join(', ');
      throw new RagError(`Rejected catalog records: ${rejected}`);
    }
    const stores = catalog.value.records.filter(isEmbeddedStore);
    if (stores.length === 0) return { ok: true, value: report };
    if (!provider.openCollection)
      throw new RagError('Embedder migration requires a collection opener');

    context = 'dimension probe';
    const probe = await opts.embedder.embedDocument('dimension probe');
    if (probe.vector.length !== opts.dimension) {
      const error = new RagError(
        `embedder dimension ${probe.vector.length} does not match the store dimension ${opts.dimension}`,
        'EMBEDDER_DIMENSION_MISMATCH',
      );
      opts.log(
        `Embedder migration ${context}: ${error.code}: ${error.message}`,
      );
      return { ok: false, error };
    }
    recordUsage(probe);

    for (const record of stores) {
      const { storeName } = record;
      context = storeName;
      const started = Date.now();
      const attributes = storeAttributes(record);
      const stored =
        typeof attributes.embedder === 'string'
          ? attributes.embedder
          : undefined;
      const restamp = stored !== opts.current;
      const updater = isRagCatalogUpdater(provider) ? provider : undefined;
      if (restamp && !updater)
        throw new RagError(
          'Cannot update the collection catalog',
          'RAG_UNSUPPORTED',
        );

      const opened = await provider.openCollection(record);
      if (!opened.ok) throw opened.error;
      const { rag } = opened.value;
      if (!isRagScanner(rag))
        throw new RagError('Cannot scan the collection', 'RAG_UNSUPPORTED');
      const embedder = opts.storeEmbedder?.(record.name) ?? opts.embedder;
      const writer = rag.writer?.();
      let records = 0;
      let fragments = 0;
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        context = storeName;
        const page = await rag.scan(cursor === undefined ? {} : { cursor });
        if (!page.ok) throw page.error;
        cursor = page.value.cursor;
        if (cursor !== undefined) {
          if (seenCursors.has(cursor))
            throw new RagError('Collection scan did not advance');
          seenCursors.add(cursor);
        }
        const stale = page.value.records.filter(({ metadata }) => {
          const hash = metadata.embedder ?? stored;
          return typeof hash !== 'string' || !accepted.has(hash);
        });
        if (stale.length === 0) continue;
        if (!writer?.upsertManyPrecomputedRaw && !writer?.upsertPrecomputedRaw)
          throw new RagError(
            'Cannot write precomputed records',
            'RAG_UNSUPPORTED',
          );

        const texts = stale.map(({ text }) => text);
        let pageEmbeddings: IEmbedResult[][];
        try {
          pageEmbeddings = await embedDocumentRecords(embedder, texts);
        } catch {
          pageEmbeddings = [];
          for (const { id, text } of stale) {
            context = `${storeName}/${id}`;
            const [embedded] = await embedDocumentRecords(embedder, [text]);
            pageEmbeddings.push(embedded);
          }
        }

        const items: PrecomputedRecord[] = stale.map(
          ({ id, text, metadata }, index) => ({
            id,
            text,
            vector: pageEmbeddings[index].map(({ vector }) => vector),
            metadata: { ...metadata, embedder: opts.current },
          }),
        );
        if (writer.upsertManyPrecomputedRaw) {
          context = `${storeName}/${items.map(({ id }) => id).join(', ')}`;
          const written = await writer.upsertManyPrecomputedRaw(items);
          if (!written.ok) throw written.error;
        } else if (writer.upsertPrecomputedRaw) {
          for (const { id, text, vector, metadata } of items) {
            context = `${storeName}/${id}`;
            const written = await writer.upsertPrecomputedRaw(
              id,
              text,
              vector,
              metadata,
            );
            if (!written.ok) throw written.error;
          }
        }
        for (const embedded of pageEmbeddings) {
          fragments += embedded.length;
          for (const result of embedded) recordUsage(result);
        }
        records += items.length;
      } while (cursor !== undefined);

      context = storeName;
      if (restamp && updater) {
        const updated = await updater.updateCollection(storeName, {
          attributes: {
            ...attributes,
            ...encodeEmbedderAttribute(opts.current),
          },
        });
        if (!updated.ok) throw updated.error;
      }
      const action =
        records > 0 ? 'reembedded' : restamp ? 'restamped' : 'current';
      const ms = Date.now() - started;
      report.stores.push({ storeName, action, records, fragments, ms });
      opts.log(
        `Embedder migration ${storeName}: ${action}, ${records} records, ${fragments} fragments, ${ms} ms`,
      );
    }
    return { ok: true, value: report };
  } catch (cause) {
    const code =
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? cause.code
        : 'EMBEDDER_MIGRATION_ERROR';
    const message = cause instanceof Error ? cause.message : String(cause);
    opts.log(`Embedder migration ${context}: ${code}`);
    return { ok: false, error: new RagError(`${context}: ${message}`, code) };
  }
}
