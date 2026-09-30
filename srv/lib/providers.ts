/**
 * The one place that turns configuration into instances (spec §4.1).
 * Components receive what is built here; none of them read configuration.
 */
import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  type IQueryEmbedder,
  type IRetrievalEmbedder,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '@mcp-abap-adt/llm-agent-libs';
import {
  composeEmbedder,
  prefetchEmbedderFactories,
  resolveEmbedder,
} from '@mcp-abap-adt/llm-agent-rag';
import type { AgentConfig, EmbedderConfig } from '../agent-config';
import { setDestinationSource } from './btp-destinations';
import {
  createDestinationSource,
  type DestinationSource,
} from './destination-source';
import { apiKeyCredential } from './llm-factory';
import {
  createRagStoreFactory,
  type RagStoreFactory,
} from './rag-store-factory';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder';

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

/** `resolveEmbedder` requires its peers loaded first; awaited once at startup. */
export async function prefetchEmbedder(
  cfg: EmbedderConfig | null,
): Promise<void> {
  if (cfg && cfg.kind !== 'sap-ai-core')
    await prefetchEmbedderFactories([cfg.kind]);
}

export function buildEmbedding(cfg: EmbedderConfig | null): Embedding | null {
  if (!cfg) return null;
  const raw =
    cfg.kind === 'sap-ai-core'
      ? composeEmbedder(
          new SapAiCoreEmbedder({
            model: cfg.model,
            resourceGroup: cfg.resourceGroup,
          }),
        )
      : cfg.kind === 'openai'
        ? resolveEmbedder({
            provider: 'openai',
            model: cfg.model,
            credential: apiKeyCredential(cfg.apiKey ?? ''),
            ...(cfg.url ? { url: cfg.url } : {}),
          })
        : resolveEmbedder({
            provider: 'ollama',
            model: cfg.model,
            ...(cfg.url ? { url: cfg.url } : {}),
          });
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
export function agentQueryEmbedder(e: Embedding): IQueryEmbedder {
  return symmetricEmbedder(wrapEmbedder(e.embedder));
}

export interface Providers {
  embedding: Embedding | null;
  stores: RagStoreFactory;
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
    destinations,
  };
}
