/**
 * The one place that turns configuration into instances (spec §4.1).
 * Components receive what is built here; none of them read configuration.
 */
import {
  type CallOptions,
  CircuitBreaker,
  CircuitBreakerEmbedder,
  type IEmbedResult,
  type IQueryEmbedder,
  type IRagProvider,
  type IRetrievalEmbedder,
  symmetricEmbedder,
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
import { createCollectionProvider } from './rag-provider-factory';
import {
  createRagStoreFactory,
  type RagStoreFactory,
} from './rag-store-factory';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder';
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
  breaker: CircuitBreaker;
  fingerprint: EmbedderFingerprint;
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
  const raw = composeEmbedder(createEmbedder());
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
  const embedder = new CircuitBreakerEmbedder(raw, breaker);
  return {
    embedder,
    retrieval: symmetricEmbedder(embedder),
    breaker,
    fingerprint: embedderFingerprint(cfg),
  };
}

/**
 * The agent's search embedder. Since llm-agent 30 the builder no longer meters
 * embedding usage itself; `wrapEmbedder` on the provider underneath keeps the
 * per-request `embedding` usage entries the agent logged before.
 */
export function agentQueryEmbedder(
  e: Embedding,
  component: 'query-embedder' | 'collection-retrieval' = 'query-embedder',
): IQueryEmbedder {
  const query = symmetricEmbedder(wrapEmbedder(e.embedder));
  return {
    embedQuery(
      text: string,
      options: CallOptions | undefined,
    ): Promise<IEmbedResult> {
      return query.embedQuery(text, {
        ...options,
        ...(options?.usage
          ? { usage: options.usage.with({ role: 'embedding', component }) }
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
