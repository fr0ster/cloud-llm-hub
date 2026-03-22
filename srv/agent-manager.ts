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

import type { HandlerContext } from '@mcp-abap-adt/core/handlers';
import { HandlerExporter } from '@mcp-abap-adt/core/handlers';
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
import cds, { type Request } from '@sap/cds';
import { z } from 'zod';
import { type AgentConfig, getAgentConfig } from './agent-config';
import { createConnection } from './connections/connectionFactory';
import { resolveDestinationSapConfig } from './connections/destinationResolver';
import { loggerAdapter } from './lib/logger';
import { SapAiCoreEmbedder } from './lib/sap-ai-core-embedder';

/**
 * Convert inputSchema from HandlerExporter to JSON Schema.
 *
 * HandlerExporter returns Zod raw shapes (Record<string, ZodType>),
 * not JSON Schema. The MCP SDK converts them automatically in listTools,
 * but our embedded MCP path bypasses that conversion.
 */
function toJsonSchema(inputSchema: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { type: 'object', properties: {} };
  }

  // Already JSON Schema (from high-level handlers that define it directly)
  if (
    (inputSchema as Record<string, unknown>).type === 'object' &&
    (inputSchema as Record<string, unknown>).properties
  ) {
    return inputSchema as Record<string, unknown>;
  }

  // Zod raw shape: Record<string, ZodType> — wrap in z.object() and convert
  // Uses Zod v4 built-in toJSONSchema, then strips $schema and additionalProperties
  // which SAP AI Core Orchestration API doesn't expect in tool parameter schemas
  try {
    // biome-ignore lint/suspicious/noExplicitAny: Zod raw shape type varies between handler groups
    const zodObj = z.object(inputSchema as any);
    const result = z.toJSONSchema(zodObj) as Record<string, unknown>;
    delete result.$schema;
    delete result.additionalProperties;
    return result;
  } catch {
    // Fallback: return empty schema
    return { type: 'object', properties: {} };
  }
}

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

  // Handler context with injected connection
  const context: HandlerContext = {
    connection:
      connection as unknown as import('@mcp-abap-adt/interfaces').IAbapConnection,
    logger: loggerAdapter,
  };

  // Inject real connection into handler groups so closure-based handlers (handler.length === 1)
  // use our connection instead of dummyContext (connection: null).
  // HandlerExporter creates groups with dummyContext; BaseMcpServer.registerHandlers() fixes this
  // by setting group.context before calling, but we bypass that — so we do it here.
  // biome-ignore lint/suspicious/noExplicitAny: accessing private handlerGroups field
  const handlerGroups = (exporter as any).handlerGroups as Array<{ context: HandlerContext }>;
  if (handlerGroups) {
    for (const group of handlerGroups) {
      group.context = context;
    }
  }

  // Build handler map (handlers now use updated group.context via closure)
  const handlerMap = new Map(
    entries.map((e) => [e.toolDefinition.name, e.handler]),
  );

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
        inputSchema: toJsonSchema(e.toolDefinition.inputSchema),
      })),
    callToolHandler: async (name, args) => {
      const handler = handlerMap.get(name);
      if (!handler) {
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      try {
        // Handlers from HandlerExporter have two signatures:
        // - length >= 2: (context, args) => ... (direct handlers)
        // - length === 1: (args) => ... (closure-based, uses group.context)
        // Match BaseMcpServer.registerHandlers() logic (line 283-301)
        // biome-ignore lint/suspicious/noExplicitAny: handler may be 1-arg closure or 2-arg direct
        const result =
          handler.length >= 2
            ? await handler(context, args)
            : await (handler as any)(args);
        const resultStr = JSON.stringify(result).slice(0, 1000);
        log.info('MCP tool call', {
          tool: name,
          argsKeys: Object.keys(args || {}),
          args: JSON.stringify(args).slice(0, 300),
          resultLength: resultStr.length,
          resultPreview: resultStr.slice(0, 500),
        });
        return result;
      } catch (err) {
        log.error('MCP tool call failed', {
          tool: name,
          args: JSON.stringify(args).slice(0, 500),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
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
  const rawMainLlm = makeLlm(
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

  // RAG store: respect LLM_AGENT_RAG_TYPE config
  // 'in-memory' = keyword search only (no embedder, no API calls during vectorization)
  // 'vector'    = VectorRag with SapAiCoreEmbedder + FallbackRag to InMemoryRag
  const inMemoryRag = new InMemoryRag();
  let factsRag: InMemoryRag | FallbackRag = inMemoryRag;

  // Keep reference to embedder circuit breaker for diagnostics
  let embedderBreaker: CircuitBreaker | null = null;

  if (config.agent.ragType !== 'in-memory') {
    embedderBreaker = new CircuitBreaker({
      failureThreshold: 30,
      recoveryWindowMs: 60_000,
    });
    const rawEmbedder = new SapAiCoreEmbedder({
      model: embeddingModel,
      resourceGroup: config.llm.resourceGroup,
    });
    const embedder = new CircuitBreakerEmbedder(rawEmbedder, embedderBreaker);
    const vectorRag = new VectorRag(embedder, {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
    });
    factsRag = new FallbackRag(vectorRag, inMemoryRag, embedderBreaker);
  }

  log.info('RAG configured', {
    ragType: config.agent.ragType,
    factsRagType: factsRag.constructor.name,
  });

  // Build SmartAgent
  const builder = new SmartAgentBuilder({
    agent: {
      maxIterations: config.agent.maxIterations,
      mode: config.agent.mode,
      // Keep RAG-selected tools across iterations (don't reload all 259 MCP tools)
      // RAG already selected the relevant tools; refreshing defeats RAG's purpose
      refreshToolsPerIteration: false,
    },
    prompts: {
      system: [
        'You are an SAP ABAP expert assistant connected to a live SAP system via MCP (Model Context Protocol) tools.',
        'You MUST use MCP tools to answer any questions about SAP objects, tables, packages, classes, programs, or system data.',
        'Never guess or provide generic answers when MCP tools are available — always query the SAP system.',
        'When the user asks about SAP objects (tables, packages, classes, function modules, etc.), use SearchObject or other relevant MCP tools to find them.',
        'Respond in the same language the user writes in.',
      ].join('\n'),
    },
  })
    .withMainLlm(rawMainLlm)
    .withClassifierLlm(classifierLlm)
    .withMcpClients(mcpAdapter ? [mcpAdapter] : [])
    // RAG: semantic search with fallback
    // facts = tool discovery + domain knowledge, feedback = separate store
    .withRag({
      facts: factsRag,
      feedback: inMemoryRag,
      state: inMemoryRag,
    })
    // RAG behavior: match reference SmartServer defaults
    // Classification enabled (default) — classifier sets isSapRequired for RAG routing
    // ragRetrieval 'auto' (default) — retrieves RAG only when classifier says SAP-related
    // ragQueryK default (10) — reference uses default
    .withRagTranslation(true)
    .withRagUpsert(true)
    // No .withCircuitBreaker() — our FallbackRag already handles circuit breaking;
    // builder's withCircuitBreaker() would double-wrap RAG stores in another FallbackRag
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

      // Vectorize using same format as builder's auto-vectorization (reference)
      let upsertOk = 0;
      let upsertFail = 0;
      for (const t of toolsResult.value) {
        const text = `Tool: ${t.name}\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.inputSchema)}`;
        const res = await factsStore.upsert(text, { id: `tool:${t.name}` });
        if (res.ok) {
          upsertOk++;
        } else {
          upsertFail++;
          if (upsertFail <= 3) {
            log.warn('Tool vectorization failed', {
              tool: t.name,
              error: 'error' in res ? String(res.error) : 'unknown',
            });
          }
        }
      }
      log.info('Vectorized MCP tools into RAG', {
        toolCount: toolsResult.value.length,
        upsertOk,
        upsertFail,
        embedderBreakerState: embedderBreaker?.state ?? 'n/a',
      });
    }
  }

  // Run health check in background (includes streaming test)
  (async () => {
    try {
      const res = await handle.agent.healthCheck();
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
          mcpErrors: v.mcp
            .filter((m) => !m.ok)
            .map((m) => m.error || 'unknown'),
        });
      } else {
        log.warn('SmartAgent health check failed', {
          error: res.error.message,
        });
      }
    } catch (e) {
      log.warn('SmartAgent health check error', { error: String(e) });
    }
  })();

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
