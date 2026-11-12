import {
  HanaVectorRagProvider,
  migrateHanaVectorRagAccess,
} from '@mcp-abap-adt/hana-vector-rag';
import {
  type IRagProvider,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import {
  migratePgVectorRagAccess,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  migrateQdrantVectorRagAccess,
  QdrantRagProvider,
} from '@mcp-abap-adt/qdrant-rag';
import type { RagBackendKind } from '../agent-config';
import { restampHubStores } from './hub-store-restamp';
import { setRagMigrationReady } from './rag-readiness';
import { migrateSharedHistory } from './session-history-collection';

export { isRagMigrationReady } from './rag-readiness';

type Log = (line: string) => void;

/** Never log driver errors: they can contain connection strings or row contents. */
function failure(
  stage: string,
  error: RagError,
  log: Log,
): Result<void, RagError> {
  const diagnostic =
    error.code === 'HUB_RESTAMP_CONFLICT' ||
    /^(Invalid shared history identities|Unresolved shared history identity|Conflicting shared history users|Conflicting history owner):/.test(
      error.message,
    )
      ? error.message
      : error.code;
  log(`RAG migration ${stage}: ${diagnostic}`);
  return {
    ok: false,
    error: new RagError(
      `RAG migration failed at ${stage}`,
      'RAG_MIGRATION_ERROR',
    ),
  };
}

export async function migrateRagData(
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
  try {
    const restamp = await restampHubStores(collections);
    if (!restamp.ok) return failure(`${kind}/hub stores`, restamp.error, log);
    const history = await migrateSharedHistory(collections);
    if (!history.ok) return failure(`${kind}/h_history`, history.error, log);
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
  } catch {
    return failure(
      kind,
      new RagError('Migration threw', 'MIGRATION_EXCEPTION'),
      log,
    );
  }
}

/** All hub providers must succeed before any request is admitted. */
export async function migrateHubRagProviders(
  entries: readonly { provider: IRagProvider | null; kind: RagBackendKind }[],
  log: Log,
): Promise<Result<void, RagError>> {
  setRagMigrationReady(false);
  const seen = new Set<IRagProvider>();
  let failed: RagError | undefined;
  for (const { provider, kind } of entries) {
    if (provider && seen.has(provider)) continue;
    if (provider) seen.add(provider);
    const result = await migrateRagData(provider, kind, log);
    if (!result.ok) failed = result.error;
  }
  if (failed) return { ok: false, error: failed };
  setRagMigrationReady(true);
  return { ok: true, value: undefined };
}
