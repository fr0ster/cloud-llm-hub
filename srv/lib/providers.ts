/**
 * The one place that turns configuration into instances (spec §4.1).
 * Components receive what is built here; none of them read configuration.
 */
import {
  asymmetricEmbedder,
  type CallOptions,
  CircuitBreaker,
  CircuitBreakerEmbedder,
  type IEmbedder,
  type IEmbedResult,
  type IQueryEmbedder,
  type IRagProvider,
  type IRetrievalEmbedder,
  isBatchEmbedder,
  isBatchSizeLimited,
  symmetricEmbedder,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '@mcp-abap-adt/llm-agent-libs';
import {
  composeEmbedder,
  prefetchEmbedderFactories,
} from '@mcp-abap-adt/llm-agent-rag';
import type { OllamaEmbedder } from '@mcp-abap-adt/ollama-embedder';
import type { OpenAiEmbedder } from '@mcp-abap-adt/openai-embedder';
import type { AgentConfig, EmbedderConfig } from '../agent-config';
import { setDestinationSource } from './btp-destinations';
import {
  createDestinationSource,
  type DestinationSource,
} from './destination-source';
import { apiKeyCredential } from './llm-factory';
import { observeEmbeddingUsage } from './llm-failure';
import { createCollectionProvider } from './rag-provider-factory';
import {
  createRagStoreFactory,
  type RagStoreFactory,
} from './rag-store-factory';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder';
import {
  sessionHistoryRepair,
  sessionHistoryWrite,
} from './session-history-write-scope';
import { usageRuntime } from './usage/runtime';

export interface EmbedderFingerprint {
  provider: string;
  embeddingModel: string;
  baseURL?: string;
  resourceGroup?: string;
}

export interface Embedding {
  /** The provider behind the circuit breaker; wrappers go on this one. */
  embedder: CircuitBreakerEmbedder;
  /**
   * `embedder` in both retrieval roles — what a store takes. Every embedder the
   * hub builds is symmetric (one model embeds stored and search text alike).
   */
  retrieval: IRetrievalEmbedder;
  /** Tool queries retry only rate limits; document writes retain composition. */
  toolSearchRetrieval?: IRetrievalEmbedder;
  toolSearchEmbedder?: CircuitBreakerEmbedder;
  breaker: CircuitBreaker;
  fingerprint: EmbedderFingerprint;
  /** Request-driven tool-search recovery can reach the provider even with an open breaker. */
  probeQueryEmbedder?: IQueryEmbedder;
}

/** `sap-ai-sdk` for AI Core keeps the committed bundle's header valid. */
export function embedderFingerprint(cfg: EmbedderConfig): EmbedderFingerprint {
  if (cfg.kind === 'sap-ai-core') {
    return {
      provider: 'sap-ai-sdk',
      embeddingModel: cfg.model,
      resourceGroup: cfg.resourceGroup || 'default',
    };
  }
  return {
    provider: cfg.kind,
    embeddingModel: cfg.model,
    ...(cfg.url ? { baseURL: cfg.url } : {}),
  };
}

let OpenAiConstructor: typeof OpenAiEmbedder | undefined;
let OllamaConstructor: typeof OllamaEmbedder | undefined;

/** `resolveEmbedder` requires its peers loaded first; awaited once at startup. */
export async function prefetchEmbedder(
  cfg: EmbedderConfig | null,
): Promise<void> {
  if (!cfg || cfg.kind === 'sap-ai-core') return;
  await prefetchEmbedderFactories([cfg.kind]);
  if (cfg.kind === 'openai')
    OpenAiConstructor = (await import('@mcp-abap-adt/openai-embedder'))
      .OpenAiEmbedder;
  else
    OllamaConstructor = (await import('@mcp-abap-adt/ollama-embedder'))
      .OllamaEmbedder;
}

export function buildEmbedding(cfg: EmbedderConfig | null): Embedding | null {
  if (!cfg) return null;
  const usage = usageRuntime()?.recorder;
  const recording = usage ? { usage } : {};
  // Both compositions share the provider's model metadata and usage recording.
  const provider: IEmbedder = createEmbedder();
  const getMaxInputChars = provider.getMaxInputChars?.bind(provider);
  const optionsWithObserver = (options?: CallOptions): CallOptions => ({
    ...options,
    usage: observeEmbeddingUsage(options?.usage ?? usage),
  });
  const raw = {
    embed: (text: string, options?: CallOptions) =>
      provider.embed(text, optionsWithObserver(options)),
    ...(isBatchEmbedder(provider)
      ? {
          embedBatch: (texts: string[], options?: CallOptions) =>
            provider.embedBatch(texts, optionsWithObserver(options)),
        }
      : {}),
    ...(isBatchSizeLimited(provider)
      ? { maxBatchSize: provider.maxBatchSize }
      : {}),
    ...(getMaxInputChars
      ? {
          getMaxInputChars: (options?: CallOptions) =>
            getMaxInputChars(optionsWithObserver(options)),
        }
      : {}),
  };
  const composed = composeEmbedder(raw);
  function createEmbedder() {
    switch (cfg?.kind) {
      case 'sap-ai-core':
        return new SapAiCoreEmbedder({
          ...recording,
          model: cfg.model,
          resourceGroup: cfg.resourceGroup,
        });
      case 'openai': {
        const OpenAiEmbedder = OpenAiConstructor;
        if (!OpenAiEmbedder)
          throw new Error(
            'OpenAI embedder not prefetched; await prefetchEmbedder first',
          );
        return new OpenAiEmbedder({
          ...recording,
          model: cfg.model,
          credential: apiKeyCredential(cfg.apiKey ?? ''),
          ...(cfg.url ? { baseURL: cfg.url } : {}),
        });
      }
      case 'ollama': {
        const OllamaEmbedder = OllamaConstructor;
        if (!OllamaEmbedder)
          throw new Error(
            'Ollama embedder not prefetched; await prefetchEmbedder first',
          );
        return new OllamaEmbedder({
          ...recording,
          model: cfg.model,
          ...(cfg.url ? { ollamaUrl: cfg.url } : {}),
        });
      }
      default:
        throw new Error('Missing embedder configuration');
    }
  }
  // Same breaker settings as today's getOrCreateEmbedder.
  const breaker = new CircuitBreaker({
    failureThreshold: 30,
    recoveryWindowMs: 60_000,
  });
  const embedder = new CircuitBreakerEmbedder(composed, breaker);
  // Reuse composeEmbedder's input cap, with general retries disabled. Quota
  // waits sit inside the shared breaker so a 429 never counts as a failure.
  const toolSearch = composeEmbedder(raw, {
    retry: false,
    throttle: {
      key: `tool-search-embedding:${JSON.stringify(embedderFingerprint(cfg))}`,
      strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }),
    },
  });
  const toolSearchEmbedder = new CircuitBreakerEmbedder(toolSearch, breaker);
  // Both readiness probes must reach the provider through an open shared breaker.
  const probeEmbedder = {
    async embed(text: string, options?: CallOptions) {
      try {
        const result = await toolSearch.embed(text, options);
        if (!options?.signal?.aborted) breaker.recordSuccess();
        return result;
      } catch (error) {
        if (!options?.signal?.aborted) breaker.recordFailure();
        throw error;
      }
    },
  };
  const documentEmbedder = {
    embed: (text: string, options?: CallOptions) =>
      (sessionHistoryWrite.getStore()
        ? sessionHistoryRepair.getStore()
          ? probeEmbedder
          : toolSearchEmbedder
        : embedder
      ).embed(text, options),
  };
  const retrieval = asymmetricEmbedder({
    document: documentEmbedder,
    query: embedder,
  });
  return {
    embedder,
    retrieval,
    toolSearchEmbedder,
    toolSearchRetrieval: asymmetricEmbedder({
      document: documentEmbedder,
      query: toolSearchEmbedder,
    }),
    breaker,
    fingerprint: embedderFingerprint(cfg),
    probeQueryEmbedder: {
      embedQuery: (text, options) => probeEmbedder.embed(text, options),
    },
  };
}

/**
 * The agent's search embedder. Since llm-agent 30 the builder no longer meters
 * embedding usage itself; `wrapEmbedder` on the provider underneath keeps the
 * per-request `embedding` usage entries the agent logged before.
 */
export function agentQueryEmbedder(
  e: Embedding,
  component:
    | 'query-embedder'
    | 'collection-retrieval'
    | 'tool-search' = 'query-embedder',
): IQueryEmbedder {
  const toolSearch = component === 'tool-search';
  const query = symmetricEmbedder(
    wrapEmbedder(
      toolSearch ? (e.toolSearchEmbedder ?? e.embedder) : e.embedder,
    ),
  );
  return {
    embedQuery(
      text: string,
      options: CallOptions | undefined,
    ): Promise<IEmbedResult> {
      return query.embedQuery(text, {
        ...options,
        ...(options?.usage
          ? {
              usage: options.usage.with({
                role: 'embedding',
                component: toolSearch ? 'query-embedder' : component,
              }),
            }
          : {}),
      });
    },
  };
}

export interface Providers {
  embedding: Embedding | null;
  stores: RagStoreFactory;
  /** The provider behind persistent collections; null unless that class is persistent. */
  collections?: IRagProvider | null;
  destinations: DestinationSource;
}

/** The startup step (spec §4.1): short, awaited, before the registry and routes. */
export async function startProviders(
  cfg: Pick<AgentConfig, 'rag' | 'destinations'>,
): Promise<Providers> {
  await prefetchEmbedder(cfg.rag.embedder);
  const embedding = buildEmbedding(cfg.rag.embedder);
  const destinations = createDestinationSource(cfg.destinations);
  setDestinationSource(destinations);
  return {
    embedding,
    stores: createRagStoreFactory(cfg.rag, embedding),
    collections: embedding
      ? createCollectionProvider(cfg.rag, embedding)
      : null,
    destinations,
  };
}
