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
import { setSystemContext } from '@mcp-abap-adt/core/utils';
import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  ClineClientAdapter,
  FallbackLlmCallStrategy,
  FallbackRag,
  InMemoryMetrics,
  InMemoryRag,
  IntentEnricher,
  type IQueryEmbedding,
  type IRag,
  MCPClientWrapper,
  McpClientAdapter,
  makeLlm,
  OpenAiEmbedder,
  SessionManager,
  SmartAgentBuilder,
  type SmartAgentHandle,
  ToolCache,
  TranslatePreprocessor,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

import { z } from 'zod';
import { type AgentConfig, getAgentConfig } from './agent-config';

// ---------------------------------------------------------------------------
// NamespaceIgnoringRag — wraps tools store to strip ragFilter on query
// ---------------------------------------------------------------------------
// Tools are vectorized without namespace. When opts include ragFilter (for
// user/destination isolation), the inner store would filter out all tool records.
// This wrapper strips ragFilter before querying, so tools always return results.
// ---------------------------------------------------------------------------

export class NamespaceIgnoringRag implements IRag {
  constructor(private inner: IRag) {}

  async upsert(
    text: string,
    metadata: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) {
    return this.inner.upsert(text, metadata, options);
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: { signal?: AbortSignal; ragFilter?: { namespace?: string } },
  ) {
    // Strip ragFilter — tools have no namespace
    const { ragFilter: _unused, ...cleanOpts } = options ?? {};
    return this.inner.query(embedding, k, cleanOpts);
  }

  async healthCheck() {
    return this.inner.healthCheck();
  }
}

import { createConnection } from './connections/connectionFactory';
import { resolveDestinationSapConfig } from './connections/destinationResolver';
import {
  clearDestinationsCache,
  getAvailableDestinations,
} from './lib/btp-destinations';
import { loggerAdapter } from './lib/logger';
import { SapAiCoreEmbedder } from './lib/sap-ai-core-embedder';
import { CollectionRegistry } from './rag-collections';

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

// NOTE: Custom stage handlers (CustomClassifyHandler, CustomToolSelectHandler,
// CustomRagUpsertHandler) and StructuredPipelineDefinition removed in 6.0.0.
// llm-agent now uses DefaultPipeline with consumer-defined RAG stores only.

const agentHandles = new Map<string, SmartAgentHandle>();

/** Set to true after initSmartAgents() completes, regardless of destination success */
let initializationDone = false;

/** Fallback agent without MCP tools — used when no destinations are available */
let llmOnlyHandle: SmartAgentHandle | null = null;

/** Runtime model overrides (null = use config/env default) */
let currentModel: string | null = null;
let currentClassifierModel: string | null = null;
/** Shared LLM instances (updated on model switch) */
let sharedMainLlm: ReturnType<typeof makeLlm> | null = null;
let sharedClassifierLlm: ReturnType<typeof makeLlm> | null = null;

/** Check if at least one SmartAgent is initialized and ready */
export function isAgentReady(): boolean {
  return initializationDone || agentHandles.size > 0;
}

/** Get the model name currently used by the agent */
export function getCurrentModel(): string {
  return currentModel || getAgentConfig().llm.model;
}

export function getCurrentClassifierModel(): string {
  return (
    currentClassifierModel ||
    process.env.LLM_AGENT_CLASSIFIER_MODEL ||
    getAgentConfig().llm.model
  );
}

/** Shared metrics instance (survives agent rebuilds) */
const metrics = new InMemoryMetrics();

/** Get agent metrics snapshot */
export function getAgentMetrics() {
  return metrics.snapshot();
}

// ---------------------------------------------------------------------------
// Multi-destination state management
// ---------------------------------------------------------------------------

/** Per-destination pre-built state for fast switching */
export interface DestinationState {
  mcpAdapter: McpClientAdapter | null;
  toolsRag: IRag;
  toolCount: number;
  status: 'pending' | 'ready' | 'vectorizing' | 'error' | 'unreachable';
  error?: string;
}

/** Map of destination name → pre-built state */
const destinationStates = new Map<string, DestinationState>();

// ---------------------------------------------------------------------------
// System-to-destination mapping (e.g., "DEV.100" → "S4HANA_DEV")
// ---------------------------------------------------------------------------
// Configured via DESTINATION_MAPPING env var: "DEV.100=S4HANA_DEV,QAS.600=S4HANA_QAS"

const systemDestinationMap = new Map<string, string>();

/** Parse DESTINATION_MAPPING env var at startup */
function initDestinationMapping(): void {
  const raw = process.env.DESTINATION_MAPPING || '';
  if (!raw) return;
  const log = cds.log('agent-manager');
  for (const pair of raw.split(',')) {
    const [system, dest] = pair.split('=').map((s) => s.trim());
    if (system && dest) {
      systemDestinationMap.set(system, dest);
    }
  }
  if (systemDestinationMap.size > 0) {
    log.info('Destination mapping loaded', {
      mappings: Object.fromEntries(systemDestinationMap),
    });
  }
}

/**
 * Resolve a SAP system code (e.g., "DEV.100") to a BTP destination name.
 * Returns the destination name if found and active, or an error.
 */
export function resolveSystemDestination(systemCode: string): {
  ok: boolean;
  destination?: string;
  error?: string;
} {
  const dest = systemDestinationMap.get(systemCode);
  if (!dest) {
    return {
      ok: false,
      error: `No destination mapping for system "${systemCode}". Configure DESTINATION_MAPPING env var.`,
    };
  }

  // Check destination state
  const state = destinationStates.get(dest);
  if (!state) {
    return {
      ok: false,
      error: `Destination "${dest}" (mapped from "${systemCode}") is not initialized.`,
    };
  }
  if (state.status === 'unreachable' || state.status === 'error') {
    return {
      ok: false,
      error: `Destination "${dest}" (mapped from "${systemCode}") is ${state.status}: ${state.error || 'unavailable'}`,
    };
  }

  return { ok: true, destination: dest };
}

/** Get all configured system-to-destination mappings */
export function getDestinationMappings(): Record<string, string> {
  return Object.fromEntries(systemDestinationMap);
}

/** Last-used destination per session (for detecting switches in openai-handler) */
const lastDestinationBySession = new Map<string, string>();

/**
 * Per-session conversation topic — the classified ragText from the previous request.
 * Used by CustomToolSelectHandler to enrich short follow-up messages with topic context,
 * so RAG tool selection stays relevant without extra LLM token cost.
 * Example: "create hello world class" persists → next message "ZCL_DEMO_HELLO_AI1"
 * gets enriched → CreateClass found by RAG.
 */
const sessionTopicMap = new Map<string, string>();

/** Get last-used destination for a session, or config default */
export function getCurrentDestination(sessionId?: string): string {
  if (sessionId) {
    return (
      lastDestinationBySession.get(sessionId) ||
      getAgentConfig().mcp.destination
    );
  }
  return getAgentConfig().mcp.destination;
}

/** Clear session topic (call on destination switch alongside clearSession) */
export function clearSessionTopic(sessionId: string): void {
  sessionTopicMap.delete(sessionId);
}

/** Track which destination was used for a session */
export function setSessionDestination(
  sessionId: string,
  destination: string,
): void {
  lastDestinationBySession.set(sessionId, destination);
}

/** Get all destination states for API/UI consumption */
export function getDestinationStates(): Array<{
  name: string;
  status: string;
  toolCount: number;
  error?: string;
}> {
  return [...destinationStates.entries()].map(([name, state]) => ({
    name,
    status: state.status,
    toolCount: state.toolCount,
    error: state.error,
  }));
}

/**
 * Refresh unreachable destinations on demand (called from API endpoint).
 * Re-runs initDestination for all unreachable destinations.
 * Returns updated destination states.
 */
export async function refreshDestinations(): Promise<
  Array<{ name: string; status: string; toolCount: number; error?: string }>
> {
  const log = cds.log('agent-manager');

  // Force re-fetch from BTP (clear 5-min cache)
  clearDestinationsCache();
  const available = await getAvailableDestinations();

  // New destinations not yet in state map
  const newDests = available.filter((d) => !destinationStates.has(d.name));

  // Already known unreachable destinations
  const unreachable = [...destinationStates.entries()]
    .filter(([, s]) => s.status === 'unreachable')
    .map(([name]) => name);

  log.info('Manual destination refresh triggered', {
    fetched: available.map((d) => d.name),
    new: newDests.map((d) => d.name),
    unreachable,
  });

  for (const d of newDests) {
    await initDestination(d.name);
  }

  for (const name of unreachable) {
    await initDestination(name);
    const state = destinationStates.get(name);
    if (state?.status === 'ready') {
      log.info('Destination recovered after manual refresh', {
        destination: name,
        toolCount: state.toolCount,
      });
    }
  }

  return getDestinationStates();
}

// ---------------------------------------------------------------------------
// Shared embedder + RAG stores (survive destination switches)
// ---------------------------------------------------------------------------

let sharedEmbedderBreaker: CircuitBreaker | null = null;
let sharedEmbedder: CircuitBreakerEmbedder | null = null;

// ---------------------------------------------------------------------------
// Collection Registry (singleton — manages dynamic RAG collections)
// ---------------------------------------------------------------------------

let collectionRegistryInstance: CollectionRegistry | null = null;

/** Get or create the shared CollectionRegistry. */
export function getCollectionRegistry(): CollectionRegistry {
  if (!collectionRegistryInstance) {
    const embedding = getOrCreateEmbedder(getAgentConfig().llm.resourceGroup);
    collectionRegistryInstance = new CollectionRegistry({
      storagePath: process.env.RAG_STORAGE_PATH || undefined,
      embedder: embedding?.embedder ?? null,
      breaker: embedding?.breaker ?? null,
    });
  }
  return collectionRegistryInstance;
}

/** Get or create shared embedder (singleton) */
function getOrCreateEmbedder(resourceGroup?: string): {
  embedder: CircuitBreakerEmbedder;
  breaker: CircuitBreaker;
} | null {
  const config = getAgentConfig();
  if (config.agent.ragType === 'in-memory') return null;

  if (!sharedEmbedder) {
    const embeddingModel =
      process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small';
    sharedEmbedderBreaker = new CircuitBreaker({
      failureThreshold: 30,
      recoveryWindowMs: 60_000,
    });

    // Create embedder based on LLM provider
    let rawEmbedder: SapAiCoreEmbedder | OpenAiEmbedder;
    if (config.llm.provider === 'sap-ai-sdk') {
      rawEmbedder = new SapAiCoreEmbedder({
        model: embeddingModel,
        resourceGroup,
      });
    } else {
      // OpenAI-compatible embedder for openai/anthropic/deepseek providers
      rawEmbedder = new OpenAiEmbedder({
        apiKey: config.llm.apiKey || '',
        baseURL: config.llm.baseUrl,
        model: embeddingModel,
      });
    }

    sharedEmbedder = new CircuitBreakerEmbedder(
      rawEmbedder,
      sharedEmbedderBreaker,
    );
  }

  return {
    embedder: sharedEmbedder,
    breaker: sharedEmbedderBreaker as NonNullable<typeof sharedEmbedderBreaker>,
  };
}

/** Create a tools RAG store (one per destination), wrapped to ignore ragFilter */
function createToolsRagStore(resourceGroup?: string): IRag {
  const embedding = getOrCreateEmbedder(resourceGroup);
  if (!embedding) return new NamespaceIgnoringRag(new InMemoryRag());

  const config = getAgentConfig();
  const helperLlm = makeLlm(
    {
      provider: config.llm.provider,
      apiKey: config.llm.apiKey || 'sap-ai-sdk-managed',
      baseURL: config.llm.baseUrl,
      model: process.env.LLM_AGENT_CLASSIFIER_MODEL || config.llm.model,
      resourceGroup: config.llm.resourceGroup,
    },
    0.1,
  );

  const toolsVectorRag = new VectorRag(embedding.embedder, {
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    // Translate non-English queries to English before vector search (tool descriptions are English)
    queryPreprocessors: [new TranslatePreprocessor(helperLlm)],
    // Enrich tool descriptions with intent/synonyms at indexing time
    documentEnrichers: [new IntentEnricher(helperLlm)],
  });
  const fallback = new FallbackRag(
    toolsVectorRag,
    new InMemoryRag(),
    embedding.breaker,
  );
  return new NamespaceIgnoringRag(fallback);
}

// ---------------------------------------------------------------------------
// Tool vectorization (extracted for reuse across destinations)
// ---------------------------------------------------------------------------

/** Vectorize MCP tools into a RAG store */
async function vectorizeTools(
  mcpAdapter: McpClientAdapter,
  toolsStore: IRag,
  embedderBreaker: CircuitBreaker | null,
): Promise<{ ok: number; failed: number; total: number }> {
  const log = cds.log('agent-manager');

  const toolsResult = await mcpAdapter.listTools();
  if (!toolsResult.ok) {
    throw new Error('MCP listTools failed — cannot vectorize tools');
  }

  const tools = toolsResult.value;
  const maxRetries = 3;
  const throttleMs = 50;

  // Build basic tool entries
  const basicEntries = tools.map((t) => {
    const paramNames = Object.keys(
      (t.inputSchema as { properties?: Record<string, unknown> })?.properties ??
        {},
    ).join(', ');
    return {
      name: t.name,
      description: t.description || '',
      paramNames,
      text: [
        `Tool: ${t.name}`,
        `Description: ${t.description}`,
        paramNames ? `Parameters: ${paramNames}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });

  // NOTE: LLM enrichment now handled by IntentEnricher in VectorRag (llm-agent 8.0.0).
  // TranslatePreprocessor handles query translation for non-English searches.
  const toolEntries = basicEntries.map((t) => ({
    name: t.name,
    text: t.text,
  }));

  let pending = toolEntries;
  let totalOk = 0;

  for (
    let attempt = 0;
    attempt <= maxRetries && pending.length > 0;
    attempt++
  ) {
    if (attempt > 0) {
      const waitMs = 65_000;
      log.info(
        `Vectorization retry ${attempt}/${maxRetries}: waiting ${waitMs}ms, ${pending.length} tools remaining`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
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
        `Vectorization attempt ${attempt}: ${failed.length} failed, ${totalOk} succeeded`,
        { embedderBreakerState: embedderBreaker?.state ?? 'n/a' },
      );
    }
  }

  if (pending.length > 0) {
    log.error('Tool vectorization incomplete', {
      failedCount: pending.length,
      failedTools: pending.map((t) => t.name).slice(0, 20),
      totalTools: tools.length,
      successCount: totalOk,
    });
  }

  log.info('Vectorized MCP tools', {
    toolCount: tools.length,
    upsertOk: totalOk,
    embedderBreakerState: embedderBreaker?.state ?? 'n/a',
  });

  return { ok: totalOk, failed: pending.length, total: tools.length };
}

// ---------------------------------------------------------------------------
// Per-destination initialization
// ---------------------------------------------------------------------------

/**
 * Initialize a single destination: build MCP adapter, vectorize tools, build SmartAgent.
 * Updates destinationStates map and agentHandles map.
 */
async function initDestination(
  destinationName: string,
): Promise<DestinationState> {
  const log = cds.log('agent-manager');
  const config = getAgentConfig();

  log.info('Initializing destination', { destination: destinationName });

  const state: DestinationState = {
    mcpAdapter: null,
    toolsRag: createToolsRagStore(config.llm.resourceGroup),
    toolCount: 0,
    status: 'vectorizing',
  };
  destinationStates.set(destinationName, state);

  try {
    state.mcpAdapter = await buildEmbeddedMcpAdapter(destinationName);

    const embedding = getOrCreateEmbedder(config.llm.resourceGroup);
    const result = await vectorizeTools(
      state.mcpAdapter,
      state.toolsRag,
      embedding?.breaker ?? null,
    );
    state.toolCount = result.ok;

    // Build a full SmartAgent for this destination
    const handle = await buildAgentForDestination(
      state.mcpAdapter,
      state.toolsRag,
      config,
    );
    agentHandles.set(destinationName, handle);
    state.status = 'ready';
    log.info('Destination ready', {
      destination: destinationName,
      toolCount: state.toolCount,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    state.error = errorMsg;
    // Distinguish unreachable (probe failed) from other init errors
    if (errorMsg.includes('unreachable')) {
      state.status = 'unreachable';
      log.warn('Destination unreachable, skipping', {
        destination: destinationName,
        error: errorMsg,
      });
    } else {
      state.status = 'error';
      log.error('Destination initialization failed', {
        destination: destinationName,
        error: errorMsg,
      });
    }
  }

  return state;
}

/**
 * Initialize remaining destinations in background (after primary is ready).
 * Fetches available SAP destinations from BTP Destination Service and
 * vectorizes each one's MCP tools into a separate RAG store.
 */
async function initBackgroundDestinations(): Promise<void> {
  const log = cds.log('agent-manager');

  try {
    const destinations = await getAvailableDestinations();
    const primaryDest = getAgentConfig().mcp.destination;
    const others = destinations.filter((d) => d.name !== primaryDest);

    if (others.length === 0) {
      log.info('No additional destinations to initialize');
      return;
    }

    log.info('Starting background destination initialization', {
      destinations: others.map((d) => d.name),
    });

    // Register all destinations as 'pending' immediately so UI sees the full list
    for (const dest of others) {
      if (!destinationStates.has(dest.name)) {
        destinationStates.set(dest.name, {
          mcpAdapter: null,
          toolsRag: new InMemoryRag(),
          toolCount: 0,
          status: 'pending',
        });
      }
    }

    // Sequential: each destination does embedding calls, avoid overwhelming API
    for (const dest of others) {
      const state = destinationStates.get(dest.name);
      if (state?.status === 'ready') continue;
      await initDestination(dest.name);
    }

    const states = [...destinationStates.values()];
    log.info('Background destination initialization complete', {
      total: destinationStates.size,
      ready: states.filter((s) => s.status === 'ready').length,
      unreachable: states.filter((s) => s.status === 'unreachable').length,
      errors: states.filter((s) => s.status === 'error').length,
    });

    // Schedule periodic retry for unreachable destinations
    scheduleUnreachableRetry();
  } catch (err) {
    log.warn('Background destination initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Periodically retry unreachable destinations (every 5 min) */
const UNREACHABLE_RETRY_INTERVAL_MS = 5 * 60 * 1000;
let unreachableRetryTimer: ReturnType<typeof setInterval> | null = null;

function scheduleUnreachableRetry(): void {
  if (unreachableRetryTimer) return;
  const log = cds.log('agent-manager');

  unreachableRetryTimer = setInterval(async () => {
    const unreachable = [...destinationStates.entries()].filter(
      ([, s]) => s.status === 'unreachable',
    );
    if (unreachable.length === 0) {
      // All destinations reachable — stop retrying
      if (unreachableRetryTimer) {
        clearInterval(unreachableRetryTimer);
        unreachableRetryTimer = null;
      }
      return;
    }

    log.info('Retrying unreachable destinations', {
      destinations: unreachable.map(([name]) => name),
    });

    for (const [name] of unreachable) {
      await initDestination(name);
      const state = destinationStates.get(name);
      if (state?.status === 'ready') {
        log.info('Previously unreachable destination is now ready', {
          destination: name,
          toolCount: state.toolCount,
        });
      }
    }
  }, UNREACHABLE_RETRY_INTERVAL_MS);
}

/**
 * Build embedded MCP client (in-process, no HTTP).
 *
 * Uses HandlerExporter to get tool definitions and handlers directly,
 * then wraps them in MCPClientWrapper with `transport: 'embedded'`.
 * Connection is resolved from BTP Destination and injected as handler context.
 */
async function buildEmbeddedMcpAdapter(
  destinationName: string,
): Promise<McpClientAdapter> {
  const log = cds.log('agent-manager');

  // Resolve destination to get SAP connection config
  const resolved = await resolveDestinationSapConfig(destinationName);
  const connection = createConnection({
    sapConfig: resolved.sapConfig,
    destinationName: resolved.destinationName,
  });

  // Probe: verify SAP system is reachable before building the full MCP adapter
  const PROBE_TIMEOUT_MS = 15_000;
  const abapConn =
    connection as unknown as import('@mcp-abap-adt/interfaces').IAbapConnection;
  try {
    const probeResult = await abapConn.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: PROBE_TIMEOUT_MS,
    });
    if (probeResult.status >= 500) {
      throw new Error(`SAP system returned HTTP ${probeResult.status}`);
    }
    log.info('Destination probe OK', {
      destination: destinationName,
      status: probeResult.status,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Destination "${destinationName}" is unreachable: ${msg}`);
  }

  // Pre-fetch CSRF token so it's ready for all tool calls.
  // Without this, parallel tool calls race for CSRF and most fail with 403.
  await connection.connect();

  // Resolve system context: responsible person + master system.
  // On-premise via BTP Destination: user from destination auth (e.g. MCPDEV01).
  // Cloud: /systeminformation endpoint (called automatically as fallback).
  // NOTE: Only call with explicit overrides — fallback to /systeminformation
  // can interfere with CSRF token management on on-premise systems.
  const destinationUser = resolved.username || resolved.sapConfig.username;
  if (destinationUser) {
    setSystemContext({ responsible: destinationUser });
    log.info('System context set from destination user', {
      destination: destinationName,
      responsible: destinationUser,
    });
  }

  // Get MCP tool handlers filtered by configured exposition (handler sets)
  const config = getAgentConfig();
  const expo = config.agent.exposition;
  const exporter = new HandlerExporter({
    includeReadOnly: expo.includes('readonly'),
    includeHighLevel: expo.includes('high'),
    includeLowLevel: expo.includes('low'),
    includeCompact: expo.includes('compact'),
    includeSystem: expo.includes('system'),
    includeSearch: expo.includes('search'),
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
    destination: destinationName,
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
        const toolCall =
          handler.length >= 2
            ? handler(context, args)
            : (handler as unknown as (a: typeof args) => unknown)(args);

        // Timeout: prevent hanging when SAP system doesn't respond (e.g. after destination switch)
        const MCP_TOOL_TIMEOUT_MS =
          Number(process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS) || 120_000;
        const result = await Promise.race([
          toolCall,
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `MCP tool "${name}" timed out after ${MCP_TOOL_TIMEOUT_MS / 1000}s`,
                  ),
                ),
              MCP_TOOL_TIMEOUT_MS,
            ),
          ),
        ]);

        const resultStr = JSON.stringify(result).slice(0, 1000);
        log.info('MCP tool call', {
          destination: destinationName,
          tool: name,
          handlerType: handler.length >= 2 ? 'direct' : 'closure',
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

/** Create shared LLM instances (called once, reused across all agents) */
function getOrCreateSharedLlms(config: AgentConfig): {
  mainLlm: ReturnType<typeof makeLlm>;
  classifierLlm: ReturnType<typeof makeLlm>;
} {
  if (!sharedMainLlm) {
    const mainModel = getCurrentModel();
    sharedMainLlm = makeLlm(
      {
        provider: config.llm.provider,
        apiKey: config.llm.apiKey || 'sap-ai-sdk-managed',
        baseURL: config.llm.baseUrl,
        model: mainModel,
        temperature: config.llm.temperature,
        maxTokens: config.llm.maxTokens,
        resourceGroup: config.llm.resourceGroup,
      },
      config.llm.temperature,
    );
  }
  if (!sharedClassifierLlm) {
    const classifierModel =
      process.env.LLM_AGENT_CLASSIFIER_MODEL || config.llm.model;
    sharedClassifierLlm = makeLlm(
      {
        provider: config.llm.provider,
        apiKey: config.llm.apiKey || 'sap-ai-sdk-managed',
        baseURL: config.llm.baseUrl,
        model: classifierModel,
        maxTokens: config.llm.maxTokens,
        resourceGroup: config.llm.resourceGroup,
      },
      0.1,
    );
  }
  return {
    mainLlm: sharedMainLlm,
    classifierLlm: sharedClassifierLlm,
  };
}

/**
 * Build a SmartAgent for a specific destination.
 * Shares LLM, embedder, facts/feedback/state RAG, metrics across all agents.
 */
async function buildAgentForDestination(
  mcpAdapter: McpClientAdapter,
  toolsRag: IRag,
  config: AgentConfig,
): Promise<SmartAgentHandle> {
  const log = cds.log('agent-manager');
  const { mainLlm, classifierLlm } = getOrCreateSharedLlms(config);

  const builder = new SmartAgentBuilder({
    agent: {
      maxIterations: config.agent.maxIterations,
      mode: config.agent.mode,
      historyRecencyWindow: config.agent.historyRecencyWindow,
      refreshToolsPerIteration: false,
      toolReselectPerIteration: true,
      ragQueryK: 5,
      // Disable classifier — all input treated as action. Ensures tool search always runs.
      classificationEnabled: false,
    },
    prompts: {
      system: [
        'Use MCP tools when they can accomplish the task. Answer or fulfill requests when possible.',
        'When an action is impossible with available tools — say so and do not attempt it.',
        "Respond in the user's language. Code and object names always in English.",
      ].join('\n'),
      classifier: [
        'You are a Semantic Intent Analyzer. Decompose the user message into logical tasks.',
        'For each task, identify:',
        '  - "type": action (tasks, knowledge questions, SAP operations) or chat (greetings, math, jokes).',
        '  - "text": the actual task description.',
        '  - "context": "sap-abap" if SAP terms present, otherwise "general".',
        '  - "dependency": "independent" or "sequential".',
        '',
        'Rules:',
        '- Multi-step requests: split into separate "action" subprompts with "sequential" dependency.',
        '- Independent tasks: separate subprompts with "independent" dependency.',
        '- Knowledge/factual questions MUST be "action" — NOT "chat".',
        '- Requests to read, list, show, check, analyze, or get any data = "action".',
        '- Only greetings ("hi", "hello"), pure math, and jokes without data requests = "chat".',
        '',
        'Return ONLY a JSON array.',
      ].join('\n'),
    },
  })
    .withMainLlm(mainLlm)
    .withClassifierLlm(classifierLlm)
    .withMcpClients([mcpAdapter]);

  // Tools RAG store for MCP tool selection (auto-vectorized)
  builder.setToolsRag(toolsRag);

  // Share embedder across all RAG queries
  if (sharedEmbedder) builder.withEmbedder(sharedEmbedder);

  builder
    .withClassification(false) // Disable classifier — treat all input as action.
    // Classifier caused tool selection to be skipped for "chat" queries.
    // Without classifier, RAG query + tool selection always runs.
    .withLlmCallStrategy(new FallbackLlmCallStrategy())
    .withToolReselection(true)
    .withToolCache(new ToolCache({ ttlMs: 30_000 }))
    .withMetrics(metrics)
    .withSessionManager(new SessionManager({ tokenBudget: 8000 }))
    .withHistorySummarization(20)
    .withClientAdapter(new ClineClientAdapter());

  // Default hardcoded flow — matches PoC for minimal token overhead.
  // Tools store wrapped with NamespaceIgnoringRag to strip ragFilter
  // (tools have no namespace, but opts carry ragFilter for user isolation).

  const handle = await builder.build();

  // Diagnostic: confirm structured pipeline is active
  // biome-ignore lint/suspicious/noExplicitAny: diagnostic access to private fields
  const agentObj = handle.agent as any;
  log.info('SmartAgent pipeline diagnostic', {
    hasPipelineExecutor: !!agentObj.pipelineExecutor,
    hasPipelineStages: !!agentObj.pipelineStages,
    stageCount: agentObj.pipelineStages?.length ?? 0,
    stageIds: agentObj.pipelineStages?.map((s: { id: string }) => s.id) ?? [],
    ragStoreKeys: Object.keys(handle.ragStores),
    refreshToolsPerIteration: agentObj.config?.refreshToolsPerIteration,
    toolReselectPerIteration: agentObj.config?.toolReselectPerIteration,
    ragQueryK: agentObj.config?.ragQueryK,
  });

  return handle;
}

/**
 * Build a SmartAgent without MCP tools — LLM-only mode.
 * Used as fallback when no SAP destinations are available.
 */
async function buildLlmOnlyAgent(
  config: AgentConfig,
): Promise<SmartAgentHandle> {
  const log = cds.log('agent-manager');
  const { mainLlm, classifierLlm } = getOrCreateSharedLlms(config);

  const builder = new SmartAgentBuilder({
    agent: {
      maxIterations: 1,
      mode: config.agent.mode,
      historyRecencyWindow: config.agent.historyRecencyWindow,
      refreshToolsPerIteration: false,
      toolReselectPerIteration: false,
      ragQueryK: 0,
      classificationEnabled: false,
    },
    prompts: {
      system: [
        'You are a helpful AI assistant. No MCP tools are available — SAP system destinations are not configured or unreachable.',
        'Answer questions using your knowledge. If the user asks to perform SAP operations, explain that SAP connectivity is not available.',
        "Respond in the user's language. Code and object names always in English.",
      ].join('\n'),
    },
  })
    .withMainLlm(mainLlm)
    .withClassifierLlm(classifierLlm)
    .withClassification(false)
    .withLlmCallStrategy(new FallbackLlmCallStrategy())
    .withMetrics(metrics)
    .withSessionManager(new SessionManager({ tokenBudget: 8000 }))
    .withHistorySummarization(20)
    .withClientAdapter(new ClineClientAdapter());

  if (sharedEmbedder) builder.withEmbedder(sharedEmbedder);

  const handle = await builder.build();
  log.info('LLM-only agent built (no MCP tools)');
  return handle;
}

/**
 * Get SmartAgent handle for a destination.
 *
 * Each destination has its own SmartAgent with isolated MCP connection.
 * Shared resources: LLM, embedder, facts/feedback/state RAG, metrics.
 */
export async function getSmartAgent(
  requestedModel?: string,
  requestedDestination?: string,
  requestedClassifierModel?: string,
): Promise<SmartAgentHandle> {
  const log = cds.log('agent-manager');
  const config = getAgentConfig();

  // --- Model hot-swap (updates all agents — LLM is stateless) ---
  const activeModel = getCurrentModel();
  if (
    requestedModel &&
    requestedModel !== activeModel &&
    agentHandles.size > 0
  ) {
    const newLlm = makeLlm(
      {
        provider: config.llm.provider,
        apiKey: config.llm.apiKey || 'sap-ai-sdk-managed',
        baseURL: config.llm.baseUrl,
        model: requestedModel,
        temperature: config.llm.temperature,
        maxTokens: config.llm.maxTokens,
        resourceGroup: config.llm.resourceGroup,
      },
      config.llm.temperature,
    );

    for (const handle of agentHandles.values()) {
      // biome-ignore lint/suspicious/noExplicitAny: accessing internal deps for model hot-swap
      (handle.agent as any).deps.mainLlm = newLlm;
    }
    sharedMainLlm = newLlm;
    currentModel = requestedModel;

    log.info('Model hot-swapped across all agents', {
      from: activeModel,
      to: requestedModel,
      agentCount: agentHandles.size,
    });
  }

  // --- Classifier model hot-swap ---
  if (
    requestedClassifierModel &&
    requestedClassifierModel !== getCurrentClassifierModel() &&
    agentHandles.size > 0
  ) {
    const newClassifier = makeLlm(
      {
        provider: config.llm.provider,
        apiKey: config.llm.apiKey || 'sap-ai-sdk-managed',
        baseURL: config.llm.baseUrl,
        model: requestedClassifierModel,
        maxTokens: config.llm.maxTokens,
        resourceGroup: config.llm.resourceGroup,
      },
      0.3,
    );
    for (const handle of agentHandles.values()) {
      // biome-ignore lint/suspicious/noExplicitAny: accessing internal deps for model hot-swap
      (handle.agent as any).deps.classifierLlm = newClassifier;
    }
    sharedClassifierLlm = newClassifier;
    const prev = getCurrentClassifierModel();
    currentClassifierModel = requestedClassifierModel;
    log.info('Classifier model hot-swapped', {
      from: prev,
      to: requestedClassifierModel,
    });
  }

  // --- Destination lookup (no hot-swap — each dest has its own agent) ---
  const destName = requestedDestination || config.mcp.destination;
  const handle = agentHandles.get(destName);

  if (handle) {
    return handle;
  }

  // Destination not ready — fall back to LLM-only agent
  const destState = destinationStates.get(destName);
  const status = destState?.status ?? 'unknown';
  log.warn('Requested destination has no agent — using LLM-only fallback', {
    destination: destName,
    status,
  });

  if (!llmOnlyHandle) {
    llmOnlyHandle = await buildLlmOnlyAgent(config);
  }
  return llmOnlyHandle;
}

/**
 * Initialize the primary destination and start background init for others.
 * Called once from server.ts on startup.
 */
export async function initSmartAgents(): Promise<void> {
  const log = cds.log('agent-manager');
  initDestinationMapping();
  const config = getAgentConfig();
  const destName = config.mcp.destination;

  // LLM-only mode: no MCP destination configured
  if (!destName) {
    log.info('No MCP destination configured — starting in LLM-only mode', {
      model: getCurrentModel(),
      mode: config.agent.mode,
    });
    llmOnlyHandle = await buildLlmOnlyAgent(config);
    initializationDone = true;
    return;
  }

  log.info('Initializing primary destination', {
    destination: destName,
    model: getCurrentModel(),
    embeddingModel:
      process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small',
    mode: config.agent.mode,
  });

  // Initialize primary destination (blocking — must be ready before serving)
  await initDestination(destName);

  const handle = agentHandles.get(destName);
  if (!handle) {
    log.warn(
      'Primary destination failed to initialize — building LLM-only fallback',
      {
        destination: destName,
      },
    );
    llmOnlyHandle = await buildLlmOnlyAgent(config);
  }

  // Run health check in background (only if primary destination initialized)
  if (handle) {
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
            destination: destName,
            llm: v.llm ? 'OK' : 'FAIL',
            rag: v.rag ? 'OK' : 'FAIL',
            mcp: mcpStatus,
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
  }

  initializationDone = true;

  log.info(
    handle
      ? 'SmartAgent ready'
      : 'SmartAgent initialized (degraded — no MCP destinations)',
    {
      destination: destName,
      model: getCurrentModel(),
    },
  );

  // Background: initialize remaining SAP destinations (non-blocking)
  initBackgroundDestinations().catch((err) => {
    log.warn('Background destination init error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Gracefully close all SmartAgents (call on shutdown)
 */
export async function closeSmartAgent(): Promise<void> {
  const log = cds.log('agent-manager');
  for (const [dest, handle] of agentHandles) {
    log.info('Closing SmartAgent', { destination: dest });
    await handle.close().catch((err) => {
      log.warn('Failed to close SmartAgent', {
        destination: dest,
        error: String(err),
      });
    });
  }
  agentHandles.clear();
}
