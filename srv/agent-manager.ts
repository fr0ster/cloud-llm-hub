/**
 * Agent Manager - SmartAgent lifecycle management
 *
 * Builds and manages SmartAgent instances using SmartAgentBuilder.
 * Configuration comes from environment variables (set via mta.yaml or CF CLI).
 *
 * Architecture:
 * - SmartAgentBuilder wires together: LLM, MCP, RAG, resilience, caching, metrics
 * - LLM: SAP AI Core via sap-ai-sdk provider
 * - MCP: MCPClientWrapper → McpClientAdapter → /mcp/stream/http
 * - RAG: FallbackRag(VectorRag → InMemoryRag) with CircuitBreakerEmbedder
 * - RAG quality: LlmQueryExpander (synonym expansion) + LlmReranker (semantic re-scoring)
 * - Resilience: CircuitBreaker for LLM + embedder failures
 * - Caching: ToolCache for deduplication, SessionManager for token budget
 * - Metrics: InMemoryMetrics for request/tool/RAG/LLM counters and latencies
 */

import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  FallbackRag,
  InMemoryMetrics,
  InMemoryRag,
  LlmQueryExpander,
  LlmReranker,
  type MCPClientConfig,
  MCPClientWrapper,
  McpClientAdapter,
  makeLlm,
  SessionManager,
  SmartAgentBuilder,
  type SmartAgentHandle,
  ToolCache,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import cds, { type Request } from '@sap/cds';
import { type AgentConfig, getAgentConfig } from './agent-config';
import { SapAiCoreEmbedder } from './lib/sap-ai-core-embedder';

/** Cached SmartAgent handle (singleton per configuration) */
let agentHandle: SmartAgentHandle | null = null;
let agentConfig: AgentConfig | null = null;

/** Shared metrics instance (survives agent rebuilds) */
const metrics = new InMemoryMetrics();

/** Get agent metrics snapshot */
export function getAgentMetrics() {
  return metrics.snapshot();
}

/**
 * Build MCP client configuration from agent configuration.
 * MCP client connects to MCP proxy, which resolves destination and creates MCP server.
 */
function buildMCPConfig(config: AgentConfig, req: Request): MCPClientConfig {
  const log = cds.log('agent-manager');

  // MCP endpoint - use config or construct from request
  let mcpEndpoint = config.mcp.endpoint;
  if (!mcpEndpoint) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host =
      req.headers.host || req.headers['x-forwarded-host'] || 'localhost:4004';
    mcpEndpoint = `${protocol}://${host}/mcp/stream/http`;
  }

  // Extract authentication from request (for MCP proxy authentication)
  const authHeader = (req.headers.authorization as string) || 'Basic YWxpY2U6';

  const headers: Record<string, string> = {
    Authorization: authHeader,
    'X-SAP-Destination': config.mcp.destination,
  };

  log.debug('Building MCP config', {
    mcpEndpoint,
    mcpDestination: config.mcp.destination,
  });

  return {
    url: mcpEndpoint,
    headers,
  };
}

/**
 * Get or create SmartAgent handle.
 *
 * Lazy-initializes a singleton SmartAgent built via SmartAgentBuilder:
 * - LLM: sap-ai-sdk provider (wraps @sap-ai-sdk/orchestration)
 * - MCP: MCPClientWrapper → McpClientAdapter (connects to /mcp/stream/http)
 * - RAG: VectorRag with SAP AI Core embeddings (hybrid vector + keyword)
 * - Resilience: CircuitBreaker, ToolCache, SessionManager
 */
export async function getSmartAgent(req: Request): Promise<SmartAgentHandle> {
  const log = cds.log('agent-manager');
  const config = getAgentConfig();

  // Return cached handle if config hasn't changed
  if (agentHandle && agentConfig === config) {
    log.debug('Using cached SmartAgent handle');
    return agentHandle;
  }

  // Close existing agent if config changed
  if (agentHandle) {
    log.info('Config changed, closing existing SmartAgent');
    await agentHandle.close().catch((err) => {
      log.warn('Failed to close previous SmartAgent', { error: String(err) });
    });
    agentHandle = null;
  }

  // Embedding model for RAG semantic search
  const embeddingModel =
    process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small';

  log.info('Building SmartAgent', {
    model: config.llm.model,
    embeddingModel,
    mode: config.agent.mode,
    maxIterations: config.agent.maxIterations,
    mcpDestination: config.mcp.destination,
  });

  // Create main LLM via provider factory (uses @sap-ai-sdk/orchestration)
  const mainLlm = makeLlm(
    {
      provider: 'sap-ai-sdk',
      apiKey: 'sap-ai-sdk-managed',
      model: config.llm.model,
      temperature: config.llm.temperature,
      resourceGroup: config.llm.resourceGroup,
    },
    config.llm.temperature,
  );

  // Create classifier LLM (same provider, lower temperature)
  const classifierLlm = makeLlm(
    {
      provider: 'sap-ai-sdk',
      apiKey: 'sap-ai-sdk-managed',
      model: config.llm.model,
      resourceGroup: config.llm.resourceGroup,
    },
    0.1,
  );

  // Create MCP client and wrap in adapter
  const mcpConfig = buildMCPConfig(config, req);
  const mcpClient = new MCPClientWrapper(mcpConfig);
  const mcpAdapter = new McpClientAdapter(mcpClient);

  // Embedder with circuit breaker for resilience
  const embedderBreaker = new CircuitBreaker({
    failureThreshold: 3,
    recoveryWindowMs: 60_000,
  });
  const rawEmbedder = new SapAiCoreEmbedder({
    model: embeddingModel,
    resourceGroup: config.llm.resourceGroup,
  });
  const embedder = new CircuitBreakerEmbedder(rawEmbedder, embedderBreaker);

  // VectorRag with fallback to InMemoryRag when embedder circuit opens
  const vectorRag = new VectorRag(embedder, {
    vectorWeight: 0.7,
    keywordWeight: 0.3,
  });
  const inMemoryRag = new InMemoryRag();
  const factsRag = new FallbackRag(vectorRag, inMemoryRag, embedderBreaker);

  // RAG quality: query expansion + re-ranking via classifier LLM
  const reranker = new LlmReranker(classifierLlm);
  const queryExpander = new LlmQueryExpander(classifierLlm);

  // Build SmartAgent
  const builder = new SmartAgentBuilder({
    agent: {
      maxIterations: config.agent.maxIterations,
      mode: config.agent.mode,
    },
  })
    .withMainLlm(mainLlm)
    .withClassifierLlm(classifierLlm)
    .withMcpClients([mcpAdapter])
    // RAG: semantic search with fallback
    .withRag({
      facts: factsRag,
      feedback: factsRag,
      state: inMemoryRag,
    })
    // RAG quality: expand queries + re-rank results
    .withReranker(reranker)
    .withQueryExpander(queryExpander)
    // RAG behavior
    .withClassification(true)
    .withRagRetrieval('auto')
    .withRagTranslation(true)
    .withRagUpsert(true)
    // Resilience: auto-recovery on SAP AI Core outages
    .withCircuitBreaker({ failureThreshold: 5, recoveryWindowMs: 30_000 })
    // Caching: avoid duplicate tool calls
    .withToolCache(new ToolCache())
    // Metrics: request/tool/RAG/LLM counters and latencies
    .withMetrics(metrics)
    // Session: token budget control
    .withSessionManager(new SessionManager({ tokenBudget: 8000 }))
    // History: compress long conversations
    .withHistorySummarization(20);

  const handle = await builder.build();
  agentHandle = handle;
  agentConfig = config;

  // Run health check in background
  handle.agent
    .healthCheck()
    .then((res) => {
      if (res.ok) {
        const v = res.value;
        const mcpStatus =
          v.mcp.length === 0
            ? 'NONE'
            : v.mcp.every((m) => m.ok)
              ? 'OK'
              : 'PARTIAL/FAIL';
        log.info('SmartAgent health check', {
          llm: v.llm ? 'OK' : 'FAIL',
          rag: v.rag ? 'OK' : 'FAIL',
          mcp: mcpStatus,
        });
      } else {
        log.warn('SmartAgent health check failed', {
          error: res.error.message,
        });
      }
    })
    .catch((e) => {
      log.warn('SmartAgent health check error', { error: String(e) });
    });

  log.info('SmartAgent built and ready');
  return handle;
}

/**
 * Gracefully close the SmartAgent (call on shutdown)
 */
export async function closeSmartAgent(): Promise<void> {
  if (agentHandle) {
    const log = cds.log('agent-manager');
    log.info('Closing SmartAgent');
    await agentHandle.close();
    agentHandle = null;
    agentConfig = null;
  }
}
