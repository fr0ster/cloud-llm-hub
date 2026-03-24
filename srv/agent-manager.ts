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
  ClineClientAdapter,
  FallbackRag,
  InMemoryMetrics,
  InMemoryRag,
  type IRag,
  type ISpan,
  type IStageHandler,
  MCPClientWrapper,
  McpClientAdapter,
  makeLlm,
  type PipelineContext,
  SessionManager,
  SmartAgentBuilder,
  type SmartAgentHandle,
  type StructuredPipelineDefinition,
  ToolCache,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
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

/**
 * Custom classify handler — extends the built-in classify logic and sets
 * `ctx.ragText` from action subprompts.
 *
 * In the default (hardcoded) flow, ragText is computed inline after classification.
 * The structured pipeline expects ragText to be set by the classify stage,
 * but the built-in ClassifyHandler doesn't do this. Without ragText, the
 * translate/expand/rag-query stages all operate on an empty string.
 */
class CustomClassifyHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const log = cds.log('agent-manager/classify');
    log.info('CustomClassifyHandler executing', {
      inputText: ctx.inputText?.slice(0, 100),
      classificationEnabled: ctx.config.classificationEnabled,
    });
    // Classify input into subprompts (same logic as built-in ClassifyHandler)
    if (ctx.config.classificationEnabled === false) {
      ctx.subprompts = [
        { type: 'action', text: ctx.inputText, dependency: 'independent' },
      ];
      span.setAttribute('skipped', true);
    } else {
      const result = await ctx.classifier.classify(ctx.inputText, ctx.options);
      if (!result.ok) {
        // Classification failed — log error but fallback to action, don't kill pipeline
        log.error('Classifier failed, falling back to action subprompt', {
          error: result.error.message,
        });
        ctx.subprompts = [
          {
            type: 'action',
            text: ctx.inputText,
            context: 'sap-abap',
            dependency: 'independent',
          },
        ];
      } else {
        ctx.subprompts = result.value;
        ctx.options?.sessionLogger?.logStep('classifier_response', {
          subprompts: result.value,
        });
      }
    }

    // Update control flags (same logic as built-in ClassifyHandler._updateControlFlags)
    const actions = ctx.subprompts.filter(
      (sp: { type: string }) => sp.type === 'action',
    );
    const mode = ctx.config.mode || 'smart';
    ctx.isSapRequired =
      actions.some((a: { context?: string }) => a.context === 'sap-abap') ||
      mode === 'hard';
    const ragMode = ctx.config.ragRetrievalMode ?? 'auto';
    ctx.shouldRetrieve =
      ragMode === 'always' || (ragMode === 'auto' && ctx.isSapRequired);

    // Set ragText from action subprompts (NOT done by built-in ClassifyHandler).
    // Without this, translate/expand/rag-query all operate on empty string.
    ctx.ragText =
      actions.map((a: { text: string }) => a.text).join(' ') || ctx.inputText;

    ctx.options?.sessionLogger?.logStep('custom_classify', {
      subpromptCount: ctx.subprompts.length,
      actionCount: actions.length,
      shouldRetrieve: ctx.shouldRetrieve,
      ragText: ctx.ragText.slice(0, 200),
    });

    return true;
  }
}

/**
 * Custom tool-select stage handler using the dedicated 'tools' RAG store.
 *
 * Replaces the built-in ToolSelectHandler which scans ALL ragResults for
 * `tool:*` entries (mixing tool descriptions into assembler output).
 * This handler queries only `ctx.ragStores.tools` and does NOT write to
 * `ctx.ragResults`, keeping tool discovery isolated from user knowledge.
 *
 * v3.0.0 dynamic stores: `tools` is registered via `.withRag()` as a
 * first-class store, but only this handler queries it — no `rag-query`
 * stage in the pipeline for `tools`.
 */
class CustomToolSelectHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const log = cds.log('agent-manager/tool-select');
    log.info('CustomToolSelectHandler executing', {
      ragStoreKeys: Object.keys(ctx.ragStores),
      hasToolsStore: !!ctx.ragStores.tools,
      mcpToolsCount: ctx.mcpTools.length,
      mcpClientsCount: ctx.mcpClients.length,
      inputText: ctx.inputText?.slice(0, 100),
    });
    const mode = ctx.config.mode || 'smart';

    // List all MCP tools if not already done
    if (ctx.mcpTools.length === 0 && ctx.mcpClients.length > 0) {
      const settled = await Promise.allSettled(
        ctx.mcpClients.map(async (client) => ({
          client,
          result: await client.listTools(ctx.options),
        })),
      );
      for (const entry of settled) {
        if (entry.status === 'fulfilled' && entry.value.result.ok) {
          for (const t of entry.value.result.value) {
            if (!ctx.toolClientMap.has(t.name)) {
              ctx.mcpTools.push(t);
              ctx.toolClientMap.set(t.name, entry.value.client);
            }
          }
        }
      }
      log.info('MCP tools loaded', {
        mcpToolsCount: ctx.mcpTools.length,
        clientResults: settled.map((s) =>
          s.status === 'fulfilled'
            ? {
                ok: s.value.result.ok,
                count: s.value.result.ok ? s.value.result.value.length : 0,
              }
            : { ok: false, error: String(s.reason) },
        ),
      });
    }

    // Query the dedicated 'tools' store from ctx.ragStores (registered via withRag)
    const toolsStore = ctx.ragStores.tools;
    const k = (config.k as number) ?? ctx.config.ragQueryK ?? 20;
    const queryText = ctx.ragText || ctx.inputText;
    let ragToolNames = new Set<string>();

    if (!toolsStore) {
      ctx.options?.sessionLogger?.logStep('custom_tool_select_no_store', {
        availableStores: Object.keys(ctx.ragStores),
      });
    }

    if (toolsStore && ctx.mcpTools.length > 0) {
      // Query tools store WITHOUT ragFilter — tools are shared (no namespace).
      // ctx.options contains ragFilter.namespace for per-user isolation,
      // but tool records were upserted without namespace metadata.
      // Passing ragFilter would filter out ALL tool records → 0 results → hallucination.
      const { ragFilter: _unused, ...toolQueryOpts } = (ctx.options ?? {}) as Record<string, unknown>;
      const result = await toolsStore.query(queryText, k, toolQueryOpts);
      if (result.ok) {
        ragToolNames = new Set(
          result.value
            .map((r) => r.metadata.id)
            .filter((id): id is string => !!id?.startsWith('tool:'))
            .map((id) => id.slice(5)),
        );
        ctx.options?.sessionLogger?.logStep('custom_tool_select', {
          query: queryText.slice(0, 200),
          k,
          resultCount: result.value.length,
          matchedTools: [...ragToolNames],
          results: result.value.map((r) => ({
            id: r.metadata.id,
            score: r.score,
            text: r.text.slice(0, 120),
          })),
        });
      }
    }

    // Select tools based on RAG results
    const selectedMcpTools =
      ragToolNames.size > 0
        ? ctx.mcpTools.filter((t) => ragToolNames.has(t.name))
        : mode === 'hard'
          ? ctx.mcpTools
          : [];

    ctx.selectedTools =
      mode === 'hard'
        ? selectedMcpTools
        : [...selectedMcpTools, ...ctx.externalTools];

    // Apply availability filtering
    const filtered = ctx.toolAvailabilityRegistry.filterTools(
      ctx.sessionId,
      ctx.selectedTools,
    );
    ctx.activeTools = filtered.allowed;
    if (filtered.blocked.length > 0) {
      ctx.options?.sessionLogger?.logStep('active_tools_filtered_by_registry', {
        blocked: filtered.blocked,
      });
    }

    span.setAttribute('mcp_tools', ctx.mcpTools.length);
    span.setAttribute('selected', ctx.selectedTools.length);
    span.setAttribute('active', ctx.activeTools.length);

    ctx.options?.sessionLogger?.logStep('tools_selected', {
      totalMcp: ctx.mcpTools.length,
      ragMatchedTools: [...ragToolNames],
      selectedCount: ctx.selectedTools.length,
      selectedNames: ctx.selectedTools.map((t) => t.name),
      activeCount: ctx.activeTools.length,
    });

    return true;
  }
}

/**
 * Custom rag-upsert handler — stores classified subprompts (fact, feedback, state)
 * with per-session namespace for user isolation.
 *
 * The built-in RagUpsertHandler reads namespace from static `ctx.config.sessionPolicy`,
 * but our singleton SmartAgent serves all users. This handler reads the sessionId
 * from `ctx.options` (passed per-request) and uses it as the namespace.
 *
 * This ensures each user's facts/feedback/state are isolated in RAG queries.
 * The 'tools' store is shared — it has no namespace and is NOT written here.
 */
class CustomRagUpsertHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const log = cds.log('agent-manager/rag-upsert');

    // Use ragFilter.namespace (= userId) for per-user isolation.
    // Set in openai-handler.ts from cds.context.user.id (XSUAA/mocked auth).
    // biome-ignore lint/suspicious/noExplicitAny: ragFilter not in CallOptions type
    const namespace = (ctx.options as any)?.ragFilter?.namespace as
      | string
      | undefined;
    const metadata: Record<string, unknown> = {};
    if (namespace) {
      metadata.namespace = namespace;
    }
    // TTL: 1 hour
    metadata.ttl = Math.floor((Date.now() + 3600_000) / 1000);

    // Resolve store by subprompt type (fact→facts, feedback→feedback, state→state)
    const resolveStore = (type: string) =>
      ctx.ragStores[type] ?? ctx.ragStores[`${type}s`];

    // Filter: skip actions and chat, only upsert fact/feedback/state
    const toStore = ctx.subprompts.filter(
      (sp: { type: string }) =>
        sp.type !== 'action' && sp.type !== 'chat' && resolveStore(sp.type),
    );

    if (toStore.length === 0) {
      span.setAttribute('skipped', true);
      return true;
    }

    const results = await Promise.allSettled(
      toStore.map(async (sp: { type: string; text: string }) => {
        const store = resolveStore(sp.type);
        if (!store) return;
        const res = await store.upsert(sp.text, metadata, ctx.options);
        if (!res.ok) {
          log.warn('RAG upsert failed', {
            type: sp.type,
            error: 'error' in res ? String(res.error) : 'unknown',
          });
        }
        return { type: sp.type, ok: res.ok };
      }),
    );

    const stored = results
      .filter((r) => r.status === 'fulfilled' && r.value?.ok)
      .map((r) => (r as PromiseFulfilledResult<{ type: string }>).value.type);

    log.info('RAG upsert completed', {
      namespace: namespace ?? 'none',
      subpromptTypes: toStore.map((sp: { type: string }) => sp.type),
      storedTypes: stored,
    });

    span.setAttribute('stored_count', stored.length);
    return true;
  }
}

/**
 * Structured pipeline definition — mirrors the default flow but uses
 * our custom tool-select handler with a dedicated 'tools' RAG store.
 *
 * Key difference from default: rag-query only queries facts/feedback/state.
 * The 'tools' store is queried exclusively by CustomToolSelectHandler,
 * keeping tool descriptions out of assembler's Known Facts section.
 *
 * Flow: classify → [summarize] → [rag-upsert] → [translate] → [expand] →
 *       [parallel rag-queries] → [rerank] → tool-select → skill-select →
 *       assemble → tool-loop
 */
const pipelineDefinition: StructuredPipelineDefinition = {
  version: '1',
  stages: [
    { id: 'classify', type: 'classify' },
    {
      id: 'summarize',
      type: 'summarize',
      when: 'config.historySummarizationLimit',
    },
    {
      id: 'rag-upsert',
      type: 'rag-upsert',
      when: 'config.ragUpsertEnabled',
    },
    // RAG retrieval: translate → expand → parallel queries → rerank
    // translate and expand must be sequential (both read/write ctx.ragText)
    { id: 'translate', type: 'translate', when: 'shouldRetrieve' },
    { id: 'expand', type: 'expand', when: 'shouldRetrieve' },
    {
      id: 'rag-queries',
      type: 'parallel',
      when: 'shouldRetrieve',
      stages: [
        {
          id: 'rag-facts',
          type: 'rag-query',
          config: { store: 'facts' },
        },
        {
          id: 'rag-feedback',
          type: 'rag-query',
          config: { store: 'feedback' },
        },
        {
          id: 'rag-state',
          type: 'rag-query',
          config: { store: 'state' },
        },
      ],
    },
    { id: 'rerank', type: 'rerank', when: 'shouldRetrieve' },
    // Custom tool-select: uses its own RAG store, not ctx.ragResults.facts
    { id: 'tool-select', type: 'tool-select' },
    { id: 'skill-select', type: 'skill-select' },
    { id: 'assemble', type: 'assemble' },
    { id: 'tool-loop', type: 'tool-loop' },
  ],
};

/** Cached SmartAgent handle (singleton per configuration) */
let agentHandle: SmartAgentHandle | null = null;
let agentConfig: AgentConfig | null = null;

/** Readiness flag — false until SmartAgent + vectorization complete */
let agentReady = false;

/** Check if SmartAgent is initialized and ready to serve requests */
export function isAgentReady(): boolean {
  return agentReady;
}

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
  const handlerGroups = (exporter as any).handlerGroups as Array<{
    context: HandlerContext;
  }>;
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
export async function getSmartAgent(): Promise<SmartAgentHandle> {
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

  // RAG stores: 4 separate stores for complete isolation (v3.0.0 dynamic stores)
  // - tools: MCP tool descriptions for semantic tool selection (custom handler only)
  // - facts: user knowledge, domain facts (Known Facts in LLM context)
  // - feedback: user feedback, corrections
  // - state: session state
  // Tool discovery uses its own store — never mixes with user knowledge
  const ragStores: Record<string, IRag> = {
    tools: new InMemoryRag(),
    facts: new InMemoryRag(),
    feedback: new InMemoryRag(),
    state: new InMemoryRag(),
  };

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

    // Tools store: pure vector search (no BM25 keywords).
    // Tool descriptions are English, queries may be any language.
    // Multilingual embeddings handle cross-language; BM25 can't.
    const toolsVectorRag = new VectorRag(embedder, {
      vectorWeight: 1.0,
      keywordWeight: 0,
    });
    ragStores.tools = new FallbackRag(
      toolsVectorRag,
      new InMemoryRag(),
      embedderBreaker,
    );

    // Facts store: VectorRag for user knowledge/domain facts
    const factsVectorRag = new VectorRag(embedder, {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
    });
    ragStores.facts = new FallbackRag(
      factsVectorRag,
      new InMemoryRag(),
      embedderBreaker,
    );
  }

  log.info('RAG configured', {
    ragType: config.agent.ragType,
    storeKeys: Object.keys(ragStores),
    toolsRagType: ragStores.tools.constructor.name,
    factsRagType: ragStores.facts.constructor.name,
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
      classifier: [
        'You are a semantic intent classifier. Decompose the user message into logical tasks.',
        'Output ONLY a raw JSON array — no markdown fences, no explanation, no surrounding text.',
        'Each task is an object with these fields:',
        '  "type": one of "action", "fact", "chat", "feedback", "state"',
        '  "text": the task description (copy from user message)',
        '  "context": "sap-abap" if SAP/ABAP terms present, otherwise "general"',
        '  "dependency": "independent" or "sequential"',
        '',
        'Rules:',
        '- Multi-step requests: split into separate objects with "sequential" dependency',
        '- Independent tasks: separate objects with "independent" dependency',
        '- Greetings, math, jokes: type "chat"',
        '- SAP keywords (table, class, program, transport, ABAP, CDS, BAPI, etc.): context "sap-abap"',
        '',
        'Example input: "Read table MARA and tell me a joke"',
        'Example output: [{"type":"action","text":"Read table MARA","context":"sap-abap","dependency":"independent"},{"type":"chat","text":"Tell a joke","context":"general","dependency":"independent"}]',
      ].join('\n'),
    },
  })
    .withMainLlm(rawMainLlm)
    .withClassifierLlm(classifierLlm)
    .withMcpClients(mcpAdapter ? [mcpAdapter] : [])
    // 4 RAG stores: tools (tool discovery), facts (user knowledge), feedback, state
    // Custom tool-select handler queries 'tools' store directly via ctx.ragStores.tools
    // Pipeline rag-query stages only query facts/feedback/state (no tools in assembler output)
    .withRag(ragStores)
    .withRagTranslation(true)
    .withRagUpsert(true)
    // Structured pipeline: same flow as default but with custom handlers
    .withPipeline(pipelineDefinition)
    // Custom classify: wraps built-in + sets ctx.ragText from action subprompts
    // (built-in ClassifyHandler doesn't set ragText, breaking translate/expand/rag-query)
    .withStageHandler('classify', new CustomClassifyHandler())
    // Custom rag-upsert: stores fact/feedback/state with per-session namespace
    .withStageHandler('rag-upsert', new CustomRagUpsertHandler())
    // Custom tool-select: queries ctx.ragStores.tools, not ctx.ragResults
    .withStageHandler('tool-select', new CustomToolSelectHandler())
    // Caching: avoid duplicate tool calls
    .withToolCache(new ToolCache())
    // Metrics: request/tool/RAG/LLM counters and latencies
    .withMetrics(metrics)
    // Session: token budget control
    .withSessionManager(new SessionManager({ tokenBudget: 8000 }))
    // History: compress long conversations
    .withHistorySummarization(20)
    // Cline adapter: detect Cline by system prompt, wrap response in <attempt_completion> XML
    .withClientAdapter(new ClineClientAdapter());

  const handle = await builder.build();
  agentHandle = handle;
  agentConfig = config;

  // Diagnostic: confirm structured pipeline is active
  // biome-ignore lint/suspicious/noExplicitAny: diagnostic access to private fields
  const agentObj = handle.agent as any;
  log.info('SmartAgent pipeline diagnostic', {
    hasPipelineExecutor: !!agentObj.pipelineExecutor,
    hasPipelineStages: !!agentObj.pipelineStages,
    stageCount: agentObj.pipelineStages?.length ?? 0,
    stageIds: agentObj.pipelineStages?.map((s: { id: string }) => s.id) ?? [],
    ragStoreKeys: Object.keys(handle.ragStores),
  });

  // Vectorize MCP tools into the 'tools' RAG store (blocking).
  // MCP is part of the service — vectorization MUST succeed for RAG to work.
  // Sequential upserts with throttle prevent embedding API rate limits (429).
  // If 429 trips the CircuitBreaker, we wait for recovery and retry.
  if (mcpAdapter) {
    const toolsResult = await mcpAdapter.listTools();
    if (!toolsResult.ok) {
      throw new Error('MCP listTools failed — cannot vectorize tools');
    }

    const toolsStore = handle.ragStores.tools;
    const tools = toolsResult.value;
    const maxRetries = 3;
    const throttleMs = 50; // small delay between sequential calls to avoid bursts

    // Build vectorization text for each tool
    const toolEntries = tools.map((t) => {
      const paramNames = Object.keys(
        (t.inputSchema as { properties?: Record<string, unknown> })
          ?.properties ?? {},
      ).join(', ');
      return {
        name: t.name,
        text: [
          `Tool: ${t.name}`,
          `Description: ${t.description}`,
          paramNames ? `Parameters: ${paramNames}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    });

    let pending = toolEntries;
    let totalOk = 0;

    for (
      let attempt = 0;
      attempt <= maxRetries && pending.length > 0;
      attempt++
    ) {
      if (attempt > 0) {
        // Wait for CircuitBreaker recovery window (60s) + margin
        const waitMs = 65_000;
        log.info(
          `Vectorization retry ${attempt}/${maxRetries}: waiting ${waitMs}ms for circuit breaker recovery, ${pending.length} tools remaining`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        // Close breaker so retries go through VectorRag, not InMemoryRag fallback
        embedderBreaker?.recordSuccess();
      }

      const failed: typeof pending = [];
      for (const t of pending) {
        const res = await toolsStore.upsert(t.text, { id: `tool:${t.name}` });
        if (res.ok) {
          totalOk++;
        } else {
          failed.push(t);
        }
        if (throttleMs > 0) {
          await new Promise((r) => setTimeout(r, throttleMs));
        }
      }
      pending = failed;

      if (pending.length > 0) {
        log.warn(
          `Vectorization attempt ${attempt}: ${failed.length} tools failed, ${totalOk} succeeded`,
          {
            embedderBreakerState: embedderBreaker?.state ?? 'n/a',
          },
        );
      }
    }

    if (pending.length > 0) {
      const failedNames = pending.map((t) => t.name);
      log.error(
        'Tool vectorization incomplete — some tools will not be found by RAG',
        {
          failedCount: pending.length,
          failedTools: failedNames.slice(0, 20),
          totalTools: tools.length,
          successCount: totalOk,
          embedderBreakerState: embedderBreaker?.state ?? 'n/a',
        },
      );
      // Don't throw — partial vectorization is better than crash loop.
      // Failed tools won't appear in RAG results but agent still works.
    }

    log.info('Vectorized MCP tools into tools RAG store', {
      toolCount: tools.length,
      upsertOk: totalOk,
      embedderBreakerState: embedderBreaker?.state ?? 'n/a',
    });
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

  agentReady = true;
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
