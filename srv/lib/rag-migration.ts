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
} from '@mcp-abap-adt/qdrant-rag';
import type { QdrantConfig, RagBackendKind } from '../agent-config';
import { restampHubStores } from './hub-store-restamp';
import { apiKeyCredential } from './llm-factory';
import { setRagMigrationReady } from './rag-readiness';
import { migrateSharedHistory } from './session-history-collection';

export { isRagMigrationReady } from './rag-readiness';

type Log = (line: string) => void;
type QdrantMigration = {
  config: QdrantConfig;
  standaloneCollections: readonly string[];
};

/** Provider migration diagnostics are technical; redact URL credentials. */
function failure(
  stage: string,
  error: RagError,
  log: Log,
): Result<void, RagError> {
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

async function migrateQdrantCollections(
  config: QdrantConfig,
  names: Iterable<string>,
  log: Log,
  optional = false,
): Promise<Result<void, RagError>> {
  const credential = config.apiKey
    ? apiKeyCredential(config.apiKey)
    : undefined;
  for (const collection of names) {
    try {
      const reports = await migrateQdrantMultivectors({
        url: config.url,
        collection,
        credential,
      });
      for (const { action } of reports)
        log(
          `RAG migration qdrant/multivectors: collection=${collection} action=${action}`,
        );
    } catch (error) {
      // A standalone store may never have been created. The migration checks
      // for its recovery copy as well as the original before reporting this.
      if (
        optional &&
        error instanceof RagError &&
        error.code === 'RAG_MIGRATION_ERROR' &&
        error.message === `Qdrant collection "${collection}" does not exist`
      )
        continue;
      return failure(
        `qdrant/multivectors/${collection}`,
        new RagError(
          'Multivector migration failed',
          'QDRANT_MULTIVECTOR_ERROR',
        ),
        log,
      );
    }
  }
  return { ok: true, value: undefined };
}

export async function migrateRagData(
  collections: IRagProvider | null,
  kind: RagBackendKind,
  log: Log,
  qdrant?: QdrantConfig,
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
    } else if (kind === 'qdrant' && collections instanceof QdrantRagProvider) {
      if (!qdrant)
        return failure(
          stage,
          new RagError('Missing Qdrant configuration', 'MISSING_CONFIG'),
          log,
        );
      const catalog = await collections.describeCollections();
      if (!catalog.ok) return failure(stage, catalog.error, log);
      const physical = await collections.listCollections();
      if (!physical.ok) return failure(stage, physical.error, log);
      // Keep catalogued names even if the original is absent during a resume.
      const names = new Set([
        ...catalog.value.records.map(({ storeName }) => storeName),
        ...physical.value,
      ]);
      const layout = await migrateQdrantCollections(qdrant, names, log);
      if (!layout.ok) return layout;
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
  entries: readonly { provider: IRagProvider | null; kind: RagBackendKind }[],
  log: Log,
  qdrant?: QdrantMigration,
): Promise<Result<void, RagError>> {
  setRagMigrationReady(false);
  const seen = new Set<IRagProvider>();
  let failed: RagError | undefined;
  if (qdrant?.standaloneCollections.length) {
    const result = await migrateQdrantCollections(
      qdrant.config,
      qdrant.standaloneCollections,
      log,
      true,
    );
    if (!result.ok) failed = result.error;
  }
  for (const { provider, kind } of entries) {
    if (provider && seen.has(provider)) continue;
    if (provider) seen.add(provider);
    const result = await migrateRagData(provider, kind, log, qdrant?.config);
    if (!result.ok) failed = result.error;
  }
  if (failed) return { ok: false, error: failed };
  setRagMigrationReady(true);
  return { ok: true, value: undefined };
}
