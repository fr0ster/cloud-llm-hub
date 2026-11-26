import {
  embedDocumentRecords,
  type IDocumentEmbedder,
  type IEmbedResult,
  type IRag,
  type IRagBackendWriter,
  type IRagProvider,
  isRagCatalogUpdater,
  isRagScanner,
  type RagCollectionRecord,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import {
  decodeEmbedderAliases,
  encodeEmbedderAttribute,
} from './collection-persistence';
import { isEmbeddedHubStore, storeAttributes } from './hub-store-embedder';

export interface EmbedderMigrationOptions {
  current: string;
  compatible: ReadonlySet<string>;
  embedder: IDocumentEmbedder;
  /** Alternate path to the same model, selected by the catalog record. */
  storeEmbedder?: (record: RagCollectionRecord) => IDocumentEmbedder;
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

export function isEmbeddedStore(record: RagCollectionRecord): boolean {
  if (isEmbeddedHubStore(record)) return true;
  if (ZERO_VECTOR_HUB_STORES.has(record.name)) return false;
  const attributes = storeAttributes(record);
  return (
    attributes.collectionKind !== 'task-results' && 'embedder' in attributes
  );
}

function newReport(): EmbedderMigrationReport {
  return { stores: [], promptTokens: 0, tokensReported: false };
}

function recordUsage(report: EmbedderMigrationReport, { usage }: IEmbedResult) {
  if (usage) {
    report.promptTokens += usage.promptTokens;
    report.tokensReported = true;
  }
}

function migrationError<T>(
  log: EmbedderMigrationOptions['log'],
  context: string,
  cause: T,
): RagError {
  const code =
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string'
      ? cause.code
      : 'EMBEDDER_MIGRATION_ERROR';
  const message = cause instanceof Error ? cause.message : String(cause);
  log(`Embedder migration ${context}: ${code}`);
  return new RagError(`${context}: ${message}`, code);
}

async function probeDimension(
  opts: EmbedderMigrationOptions,
  report: EmbedderMigrationReport,
): Promise<Result<void, RagError>> {
  try {
    const probe = await opts.embedder.embedDocument('dimension probe');
    if (probe.vector.length !== opts.dimension) {
      const error = new RagError(
        `embedder dimension ${probe.vector.length} does not match the store dimension ${opts.dimension}`,
        'EMBEDDER_DIMENSION_MISMATCH',
      );
      opts.log(
        `Embedder migration dimension probe: ${error.code}: ${error.message}`,
      );
      return { ok: false, error };
    }
    recordUsage(report, probe);
    return { ok: true, value: undefined };
  } catch (cause) {
    return {
      ok: false,
      error: migrationError(opts.log, 'dimension probe', cause),
    };
  }
}

type StoreCounts = Pick<StoreMigration, 'records' | 'fragments'>;

async function migrateStorePages(
  rag: IRag,
  storeName: string,
  embedder: IDocumentEmbedder,
  opts: EmbedderMigrationOptions,
  report: EmbedderMigrationReport,
  catalog?: { stored?: string; aliases: Set<string> },
): Promise<Result<StoreCounts, RagError>> {
  let context = storeName;
  try {
    if (!isRagScanner(rag))
      throw new RagError('Cannot scan the collection', 'RAG_UNSUPPORTED');
    const accepted = new Set([
      opts.current,
      ...opts.compatible,
      ...(catalog?.aliases ?? []),
    ]);
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
        const hash = metadata.embedder ?? catalog?.stored;
        if (typeof hash !== 'string' || !accepted.has(hash)) return true;
        if (hash !== opts.current && opts.compatible.has(hash))
          catalog?.aliases.add(hash);
        return false;
      });
      if (stale.length === 0) continue;
      if (!writer?.upsertManyPrecomputedRaw && !writer?.upsertPrecomputedRaw)
        throw new RagError(
          'Cannot write precomputed records',
          'RAG_UNSUPPORTED',
        );

      let pageEmbeddings: IEmbedResult[][];
      try {
        pageEmbeddings = await embedDocumentRecords(
          embedder,
          stale.map(({ text }) => text),
        );
      } catch (batchError) {
        for (const { id, text } of stale) {
          context = `${storeName}/${id}`;
          await embedDocumentRecords(embedder, [text]);
        }
        context = storeName;
        throw batchError;
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
        for (const result of embedded) recordUsage(report, result);
      }
      records += items.length;
    } while (cursor !== undefined);
    return { ok: true, value: { records, fragments } };
  } catch (cause) {
    return { ok: false, error: migrationError(opts.log, context, cause) };
  }
}

function reportStore(
  report: EmbedderMigrationReport,
  log: EmbedderMigrationOptions['log'],
  storeName: string,
  { records, fragments }: StoreCounts,
  started: number,
  restamped = false,
): void {
  const action =
    records > 0 ? 'reembedded' : restamped ? 'restamped' : 'current';
  const ms = Date.now() - started;
  report.stores.push({ storeName, action, records, fragments, ms });
  log(
    `Embedder migration ${storeName}: ${action}, ${records} records, ${fragments} fragments, ${ms} ms`,
  );
}

export async function migrateStandaloneStore(
  rag: IRag,
  storeName: string,
  opts: EmbedderMigrationOptions,
): Promise<Result<EmbedderMigrationReport, RagError>> {
  const report = newReport();
  const probe = await probeDimension(opts, report);
  if (!probe.ok) return probe;
  const started = Date.now();
  const migrated = await migrateStorePages(
    rag,
    storeName,
    opts.embedder,
    opts,
    report,
  );
  if (!migrated.ok) return migrated;
  reportStore(report, opts.log, storeName, migrated.value, started);
  return { ok: true, value: report };
}

export async function migrateEmbeddings(
  provider: IRagProvider,
  opts: EmbedderMigrationOptions,
): Promise<Result<EmbedderMigrationReport, RagError>> {
  const report = newReport();
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

    const probe = await probeDimension(opts, report);
    if (!probe.ok) return probe;
    const updater = isRagCatalogUpdater(provider) ? provider : undefined;

    for (const record of stores) {
      const { storeName } = record;
      context = storeName;
      const started = Date.now();
      const attributes = storeAttributes(record);
      const stored =
        typeof attributes.embedder === 'string'
          ? attributes.embedder
          : undefined;
      const aliases = new Set(
        decodeEmbedderAliases(attributes.embedderAliases),
      );
      const aliasCount = aliases.size;
      if (
        stored !== undefined &&
        stored !== opts.current &&
        opts.compatible.has(stored)
      )
        aliases.add(stored);
      if (stored !== opts.current && !updater)
        throw new RagError(
          'Cannot update the collection catalog',
          'RAG_UNSUPPORTED',
        );

      const opened = await provider.openCollection(record);
      if (!opened.ok) throw opened.error;
      const migrated = await migrateStorePages(
        opened.value.rag,
        storeName,
        opts.storeEmbedder?.(record) ?? opts.embedder,
        opts,
        report,
        { stored, aliases },
      );
      if (!migrated.ok) return migrated;

      const restamp = stored !== opts.current || aliases.size !== aliasCount;
      if (restamp) {
        if (!updater)
          throw new RagError(
            'Cannot update the collection catalog',
            'RAG_UNSUPPORTED',
          );
        const updated = await updater.updateCollection(storeName, {
          attributes: {
            ...attributes,
            ...encodeEmbedderAttribute(opts.current, [...aliases]),
          },
        });
        if (!updated.ok) throw updated.error;
      }
      reportStore(
        report,
        opts.log,
        storeName,
        migrated.value,
        started,
        restamp,
      );
    }
    return { ok: true, value: report };
  } catch (cause) {
    return { ok: false, error: migrationError(opts.log, context, cause) };
  }
}
