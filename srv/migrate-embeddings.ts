import './env-setup';

import { get } from 'node:http';
import {
  type IRagProvider,
  RagError,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  ensureAiCoreCredentials,
  getAgentConfig,
  type RagBackendKind,
} from './agent-config';
import { historyProvider, initProviders } from './agent-manager';
import { storePrefixFor } from './lib/collection-persistence';
import {
  isEmbeddedStore,
  migrateEmbeddings,
  migrateStandaloneStore,
} from './lib/embedder-migration';
import {
  SESSION_HISTORY_SOURCE,
  storeAttributes,
} from './lib/hub-store-embedder';
import {
  openStandalonePlannerMemory,
  PLANNER_MEMORY_STORE,
} from './lib/planner-context';
import { startProviders } from './lib/providers';
import {
  persistentMigrationProviders,
  runStartMigrations,
} from './lib/rag-migration';
import {
  PROVIDER_DEFAULT_DIMENSION,
  providerVectorDimension,
} from './lib/rag-provider-factory';
import {
  compatibleFingerprintHashes,
  fingerprintHash,
} from './lib/tool-corpus';

function hubAnswersHealth(port: string | number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path: '/health' }, (response) => {
      response.destroy();
      resolve(true);
    }).once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

async function migrationDimension(
  provider: IRagProvider,
  kind: RagBackendKind,
  storePrefix?: string,
): Promise<number> {
  if (kind !== 'qdrant') return PROVIDER_DEFAULT_DIMENSION;
  if (!provider.describeCollections)
    throw new RagError('Embedder migration requires a provider catalog');
  const catalog = await provider.describeCollections();
  if (!catalog.ok) throw catalog.error;

  const resolve = providerVectorDimension(provider);
  let dimension: number | undefined;
  for (const record of catalog.value.records) {
    if (!isEmbeddedStore(record, storePrefix)) continue;
    const { storeName } = record;
    const size = await resolve(storeName);
    if (dimension !== undefined && dimension !== size)
      throw new RagError(
        `Qdrant store "${storeName}" has dimension ${size}, but the other embedded stores have dimension ${dimension}`,
        'EMBEDDER_DIMENSION_MISMATCH',
      );
    dimension = size;
  }
  return dimension ?? PROVIDER_DEFAULT_DIMENSION;
}

export async function main(env: NodeJS.ProcessEnv): Promise<number> {
  try {
    if (
      env.VCAP_APPLICATION === undefined &&
      (await hubAnswersHealth(env.PORT || cds.env.server?.port || 4004))
    ) {
      console.error('stop the hub before migrating');
      return 1;
    }

    ensureAiCoreCredentials();
    const config = getAgentConfig();
    const p = await startProviders(config);
    initProviders(p);
    const { embedding } = p;
    if (!embedding) {
      console.log('No embedding configured. Nothing to migrate.');
      return 0;
    }

    const layout = await runStartMigrations(p, console.log);
    if (!layout.ok) throw layout.error;

    const { fingerprint, retrieval, toolSearchEmbedder } = embedding;
    const current = fingerprintHash(fingerprint);
    const compatible = compatibleFingerprintHashes(
      fingerprint,
      p.compatibleEmbeddingResourceGroups,
    );
    const historyEmbedder = toolSearchEmbedder
      ? symmetricEmbedder(toolSearchEmbedder)
      : retrieval;
    let promptTokens = 0;
    let tokensReported = false;
    for (const [provider, kind] of persistentMigrationProviders(p)) {
      const storePrefix = storePrefixFor(kind, config.rag.qdrant?.prefix);
      const result = await migrateEmbeddings(provider, {
        current,
        compatible,
        embedder: retrieval,
        storePrefix,
        storeEmbedder: (record) =>
          record.name === 'h_history' ||
          storeAttributes(record).source === SESSION_HISTORY_SOURCE
            ? historyEmbedder
            : retrieval,
        dimension: await migrationDimension(provider, kind, storePrefix),
        log: console.log,
      });
      if (!result.ok) throw result.error;
      promptTokens += result.value.promptTokens;
      tokensReported ||= result.value.tokensReported;
    }

    if (p.stores.backendOf('session') === 'qdrant') {
      const opened = await openStandalonePlannerMemory(p.stores);
      if (!opened.ok) throw opened.error;
      if (opened.value) {
        const name = p.stores.qdrantCollection(PLANNER_MEMORY_STORE);
        const resolve = providerVectorDimension(historyProvider('qdrant'));
        const result = await migrateStandaloneStore(opened.value, name, {
          current,
          compatible,
          embedder: retrieval,
          dimension: await resolve(name),
          log: console.log,
        });
        if (!result.ok) throw result.error;
        promptTokens += result.value.promptTokens;
        tokensReported ||= result.value.tokensReported;
      }
    }

    const usage = tokensReported ? `input ${promptTokens}` : 'not reported';
    console.log(`tokens ${fingerprint.embeddingModel}: ${usage}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (require.main === module) void main(process.env).then(process.exit);
