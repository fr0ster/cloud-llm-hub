/**
 * Agent Manager - SmartAgent lifecycle management
 *
 * Builds and manages SmartAgent instances using SmartAgentBuilder.
 * Configuration comes from environment variables (set via mta.yaml or CF CLI).
 *
 * Architecture:
 * - SmartAgentBuilder wires together: LLM, MCP, RAG, resilience, caching, metrics
 * - LLM: SAP AI Core via sap-ai-sdk provider
 * - MCP: Embedded EmbeddableMcpServer (in-process, no HTTP overhead)
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
  MCPClientWrapper,
  McpClientAdapter,
  makeLlm,
  SessionManager,
  SmartAgentBuilder,
  type SmartAgentHandle,
  ToolCache,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { HandlerExporter } from '@mcp-abap-adt/core/handlers';
import type { HandlerContext } from '@mcp-abap-adt/core/handlers';
import cds, { type Request } from '@sap/cds';
import { type AgentConfig, getAgentConfig } from './agent-config';
import { createConnection } from './connections/connectionFactory';
import { resolveDestinationSapConfig } from './connections/destinationResolver';
import { loggerAdapter } from './lib/logger';
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
 * Build embedded MCP client (in-process, no HTTP).
 *
 * Uses HandlerExporter to get tool definitions and handlers directly,
 * then wraps them in MCPClientWrapper with `transport: 'embedded'`.
 * Connection is resolved from BTP Destination and injected as handler context.
 */
async function buildEmbeddedMcpAdapter(
  config: AgentConfig,
): Promise<McpClientAdapter> {
  const log = cds.log('agent-manager');

  // Resolve destination to get SAP connection config
  const resolved = await resolveDestinationSapConfig(config.mcp.destination);
  const connection = createConnection({
    sapConfig: resolved.sapConfig,
    destinationName: resolved.destinationName,
  });

  // Get all MCP tool handlers via HandlerExporter
  const exporter = new HandlerExporter({
    includeReadOnly: true,
    includeHighLevel: true,
    includeSearch: true,
    logger: loggerAdapter,
  });

  const entries = exporter.getHandlerEntries();
  const handlerMap = new Map(
    entries.map((e) => [e.toolDefinition.name, e.handler]),
  );

  // Handler context with injected connection
  const context: HandlerContext = {
    connection: connection as unknown as import('@mcp-abap-adt/interfaces').IAbapConnection,
    logger: loggerAdapter,
  };

  log.info('Building embedded MCP client', {
    destination: config.mcp.destination,
    connectionType: connection.constructor.name,
    toolCount: entries.length,
    tools: exporter.getToolNames(),
  });

  // Use embedded transport — direct in-process handler calls
  const mcpClient = new MCPClientWrapper({
    transport: 'embedded',
    listToolsHandler: async () =>
      entries.map((e) => ({
        name: e.toolDefinition.name,
        description: e.toolDefinition.description,
        inputSchema: e.toolDefinition.inputSchema,
      })),
    callToolHandler: async (name, args) => {
      const handler = handlerMap.get(name);
      if (!handler) {
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      return handler(context, args);
    },
  });

  // connect() populates internal tools list from listToolsHandler
  await mcpClient.connect();

  return new McpClientAdapter(mcpClient);
}

/**
 * Get or create SmartAgent handle.
 *
 * Lazy-initializes a singleton SmartAgent built via SmartAgentBuilder:
 * - LLM: sap-ai-sdk provider (wraps @sap-ai-sdk/orchestration)
 * - MCP: Embedded EmbeddableMcpServer (in-process, no HTTP overhead)
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

  // Classifier model: cheaper/faster model for classification, reranking, query expansion
  // Falls back to main model if not explicitly configured
  const classifierModel =
    process.env.LLM_AGENT_CLASSIFIER_MODEL || config.llm.model;

  log.info('Building SmartAgent', {
    model: config.llm.model,
    classifierModel,
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
      maxTokens: config.llm.maxTokens,
      resourceGroup: config.llm.resourceGroup,
    },
    config.llm.temperature,
  );

  // Create classifier LLM (uses classifier model if available, falls back to main model)
  const classifierLlm = makeLlm(
    {
      provider: 'sap-ai-sdk',
      apiKey: 'sap-ai-sdk-managed',
      model: classifierModel,
      maxTokens: config.llm.maxTokens,
      resourceGroup: config.llm.resourceGroup,
    },
    0.1,
  );

  // Create embedded MCP client (in-process, no HTTP)
  // MCP is non-blocking: if destination resolution fails, agent works without MCP tools
  let mcpAdapter: McpClientAdapter | null = null;
  try {
    mcpAdapter = await buildEmbeddedMcpAdapter(config);
  } catch (err) {
    log.warn('MCP initialization failed, agent will work without MCP tools', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

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

  // Build SmartAgent
  const builder = new SmartAgentBuilder({
    agent: {
      maxIterations: config.agent.maxIterations,
      mode: config.agent.mode,
      refreshToolsPerIteration: false,
    },
  })
    .withMainLlm(mainLlm)
    .withClassifierLlm(classifierLlm)
    .withMcpClients(mcpAdapter ? [mcpAdapter] : [])
    // RAG: semantic search with fallback
    // facts = tool discovery + domain knowledge, feedback = separate store
    .withRag({
      facts: factsRag,
      feedback: inMemoryRag,
      state: inMemoryRag,
    })
    // RAG behavior (classification/reranker/queryExpander disabled to reduce SAP AI Core calls)
    .withClassification(false)
    .withRagRetrieval('auto')
    .withRagTranslation(false)
    .withRagUpsert(true)
    // Limit tool selection to top 10 RAG matches (reduces token usage)
    .withRagQueryK(10)
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

  // Vectorize MCP tools into RAG facts store for tool-select stage.
  // withMcpClients() skips auto-vectorization, so we do it manually.
  if (mcpAdapter) {
    const toolsResult = await mcpAdapter.listTools();
    if (toolsResult.ok) {
      const factsStore = handle.ragStores.facts;
      for (const t of toolsResult.value) {
        // Only name + description for RAG discovery; full schema is passed as OpenAI function tools
        await factsStore.upsert(
          `Tool: ${t.name}\nDescription: ${t.description}`,
          { id: `tool:${t.name}` },
        );
      }
      log.info('Vectorized MCP tools into RAG', {
        toolCount: toolsResult.value.length,
      });
    }
  }

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
          mcpErrors: v.mcp.filter((m) => !m.ok).map((m) => m.error || 'unknown'),
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
