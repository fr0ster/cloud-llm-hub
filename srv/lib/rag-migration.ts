import {
  SHARED_DOCUMENTS_TABLE as HANA_DOCUMENTS_TABLE,
  HanaVectorRagProvider,
  migrateHanaVectorRagAccess,
} from '@mcp-abap-adt/hana-vector-rag';
import {
  type IRagProvider,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import {
  fragmentOrdinalMigrationSql,
  migratePgVectorRagAccess,
  SHARED_DOCUMENTS_TABLE as PG_DOCUMENTS_TABLE,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  migrateQdrantMultivectors,
  migrateQdrantVectorRagAccess,
  QdrantRagProvider,
  RAG_MIGRATION_PRECONDITION,
  RAG_MIGRATION_REJECTED,
  RAG_MIGRATION_UNCONFIRMED,
  RAG_MIGRATION_VERIFICATION,
} from '@mcp-abap-adt/qdrant-rag';
import type { QdrantConfig, RagBackendKind } from '../agent-config';
import { restampHubStores } from './hub-store-restamp';
import { apiKeyCredential } from './llm-factory';
import { setRagMigrationReady } from './rag-readiness';
import { migrateSharedHistory } from './session-history-collection';

export { isRagMigrationReady } from './rag-readiness';

type Log = (line: string) => void;
type ProviderMigration = {
  provider: IRagProvider | null;
  kind: RagBackendKind;
};
type QdrantMigration = {
  config: QdrantConfig;
  standaloneCollections: readonly string[];
};

function failure(
  stage: string,
  error: RagError,
  log: Log,
): Result<void, RagError> {
  switch (error.code) {
    case RAG_MIGRATION_PRECONDITION:
    case RAG_MIGRATION_REJECTED:
    case RAG_MIGRATION_UNCONFIRMED:
    case RAG_MIGRATION_VERIFICATION:
      log(`RAG migration ${stage}: ${error.code}: ${error.message}`);
      return { ok: false, error };
  }

  const missingHanaOrdinal = error.code === 'HANA_FRAGMENT_ORDINAL_MISSING';
  const diagnostic =
    stage.endsWith('/backend') && error.code.startsWith('RAG_')
      ? `${error.code}: ${error.message}`
      : error.code === 'HUB_RESTAMP_CONFLICT' ||
          missingHanaOrdinal ||
          /^(Invalid shared history identities|Unresolved shared history identity|Conflicting shared history users|Conflicting history owner):/.test(
            error.message,
          )
        ? error.message
        : error.code;
  const safe = diagnostic.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/]+:[^\s/]*@/gi,
    '$1[redacted]@',
  );
  log(`RAG migration ${stage}: ${safe}`);
  return {
    ok: false,
    error: new RagError(
      `RAG migration failed at ${stage}${missingHanaOrdinal ? `: ${safe}` : ''}`,
      'RAG_MIGRATION_ERROR',
    ),
  };
}

async function migrateQdrantLayout(
  { config, standaloneCollections }: QdrantMigration,
  providers: Iterable<QdrantRagProvider>,
  log: Log,
): Promise<Result<void, RagError>> {
  let stage = 'qdrant/storage layout';
  try {
    const providerCollections = new Set<string>();
    for (const provider of providers) {
      const catalog = await provider.describeCollections();
      if (!catalog.ok) return failure(stage, catalog.error, log);
      const physical = await provider.listCollections();
      if (!physical.ok) return failure(stage, physical.error, log);
      // Keep catalogued names even if only the recovery copy exists.
      for (const { storeName } of catalog.value.records)
        providerCollections.add(storeName);
      for (const name of physical.value) providerCollections.add(name);
    }

    stage = 'qdrant/multivectors';
    const reports = await migrateQdrantMultivectors({
      url: config.url,
      collections: [
        ...new Set([...standaloneCollections, ...providerCollections]),
      ],
      credential: config.apiKey ? apiKeyCredential(config.apiKey) : undefined,
    });
    for (const { collection, action } of reports)
      log(`RAG migration ${stage}: collection=${collection} action=${action}`);

    const retained = reports
      .filter(({ temporaryCollectionRetained }) => temporaryCollectionRetained)
      .map(({ temporaryCollection }) => temporaryCollection);
    if (retained.length)
      return failure(
        stage,
        new RagError(
          `Qdrant retained temporary collections after a throttled upsert: ${retained.join(', ')}. After all pending Qdrant operations have settled, rerun startup to finish cleanup.`,
          RAG_MIGRATION_UNCONFIRMED,
        ),
        log,
      );
    const missing = reports
      .filter(
        ({ collection, action }) =>
          action === 'absent' && providerCollections.has(collection),
      )
      .map(({ collection }) => collection);
    if (missing.length)
      return failure(
        stage,
        new RagError(
          `Qdrant provider collections are missing: ${missing.join(', ')}.`,
          RAG_MIGRATION_PRECONDITION,
        ),
        log,
      );
    return { ok: true, value: undefined };
  } catch (error) {
    return failure(
      stage,
      error instanceof RagError
        ? error
        : new RagError(
            'Multivector migration failed',
            'QDRANT_MULTIVECTOR_ERROR',
          ),
      log,
    );
  }
}

export async function migrateRagData(
  collections: IRagProvider | null,
  kind: RagBackendKind,
  log: Log,
  qdrant?: QdrantConfig,
): Promise<Result<void, RagError>> {
  if (kind !== 'qdrant' || !(collections instanceof QdrantRagProvider))
    return migrateProviderData(collections, kind, log);
  return migrateRagProviders(
    [{ provider: collections, kind }],
    log,
    qdrant && { config: qdrant, standaloneCollections: [] },
  );
}

async function migrateProviderData(
  collections: IRagProvider | null,
  kind: RagBackendKind,
  log: Log,
): Promise<Result<void, RagError>> {
  if (!['hana-vector', 'pg-vector', 'qdrant'].includes(kind))
    return { ok: true, value: undefined };
  if (!collections)
    return failure(
      kind,
      new RagError('Missing provider', 'MISSING_PROVIDER'),
      log,
    );
  let stage = `${kind}/storage layout`;
  try {
    if (kind === 'pg-vector' && collections instanceof PgVectorRagProvider) {
      const { client, schema } = await collections.accessPersistence();
      await client.query(
        fragmentOrdinalMigrationSql(PG_DOCUMENTS_TABLE, 'shared', schema),
      );
    } else if (
      kind === 'hana-vector' &&
      collections instanceof HanaVectorRagProvider
    ) {
      const { client, schema } = await collections.accessPersistence();
      const rows = await client.query(
        `SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ${schema ? '?' : 'CURRENT_SCHEMA'} AND TABLE_NAME = ? AND COLUMN_NAME = 'FRAGMENT_ORDINAL'`,
        schema ? [schema, HANA_DOCUMENTS_TABLE] : [HANA_DOCUMENTS_TABLE],
      );
      if (!rows.length)
        return failure(
          stage,
          new RagError(
            'RAG_DOCUMENTS.FRAGMENT_ORDINAL is missing. Deploy the updated HDI artifacts before starting the hub.',
            'HANA_FRAGMENT_ORDINAL_MISSING',
          ),
          log,
        );
    }
    stage = `${kind}/hub stores`;
    const restamp = await restampHubStores(collections);
    if (!restamp.ok) return failure(`${kind}/hub stores`, restamp.error, log);
    stage = `${kind}/h_history`;
    const history = await migrateSharedHistory(collections);
    if (!history.ok) return failure(`${kind}/h_history`, history.error, log);
    stage = `${kind}/backend`;
    const backend =
      kind === 'hana-vector' && collections instanceof HanaVectorRagProvider
        ? await migrateHanaVectorRagAccess(collections)
        : kind === 'pg-vector' && collections instanceof PgVectorRagProvider
          ? await migratePgVectorRagAccess(collections)
          : kind === 'qdrant' && collections instanceof QdrantRagProvider
            ? await migrateQdrantVectorRagAccess(collections)
            : {
                ok: false as const,
                error: new RagError(
                  'Provider kind mismatch',
                  'PROVIDER_KIND_MISMATCH',
                ),
              };
    if (!backend.ok) return failure(`${kind}/backend`, backend.error, log);
    for (const finding of backend.value.reported)
      log(
        `RAG migration ${kind}: store=${finding.storeName} reason=${finding.reason}`,
      );
    if (backend.value.reported.length)
      return {
        ok: false,
        error: new RagError(
          'RAG migration reported findings',
          'RAG_MIGRATION_ERROR',
        ),
      };
    log(
      `RAG migration ${kind}: rewritten=${restamp.value.rewritten} moved=${history.value.moved}`,
    );
    return { ok: true, value: undefined };
  } catch (error) {
    return failure(
      stage,
      error instanceof RagError
        ? error
        : new RagError('Migration threw', 'MIGRATION_EXCEPTION'),
      log,
    );
  }
}

/** All hub providers must succeed before any request is admitted. */
export async function migrateHubRagProviders(
  entries: readonly ProviderMigration[],
  log: Log,
  qdrant?: QdrantMigration,
): Promise<Result<void, RagError>> {
  setRagMigrationReady(false);
  const result = await migrateRagProviders(entries, log, qdrant);
  if (result.ok) setRagMigrationReady(true);
  return result;
}

async function migrateRagProviders(
  entries: readonly ProviderMigration[],
  log: Log,
  qdrant?: QdrantMigration,
): Promise<Result<void, RagError>> {
  const qdrantProviders = new Set<QdrantRagProvider>();
  for (const { provider, kind } of entries) {
    if (kind === 'qdrant' && provider instanceof QdrantRagProvider)
      qdrantProviders.add(provider);
  }
  if (qdrant) {
    const layout = await migrateQdrantLayout(qdrant, qdrantProviders, log);
    if (!layout.ok) return layout;
  } else if (qdrantProviders.size) {
    return failure(
      'qdrant/storage layout',
      new RagError('Missing Qdrant configuration', 'MISSING_CONFIG'),
      log,
    );
  }

  const seen = new Set<IRagProvider>();
  for (const { provider, kind } of entries) {
    if (provider && seen.has(provider)) continue;
    if (provider) seen.add(provider);
    const result = await migrateProviderData(provider, kind, log);
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}
