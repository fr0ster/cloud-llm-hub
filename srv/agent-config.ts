/**
 * Agent Configuration Module
 *
 * Reads configuration from environment variables (set via mta.yaml or CF CLI).
 * This configuration is used by Agent Service (OData) and OpenAI-compatible
 * endpoints to connect SmartAgent to LLM (SAP AI Core) and MCP.
 *
 * Architecture:
 * - Configuration comes from environment variables (mta.yaml deployment or CF CLI)
 * - SAP AI Core access via @sap-ai-sdk/orchestration (reads AICORE_SERVICE_KEY or VCAP_SERVICES)
 * - MCP destination is resolved via SAP Cloud SDK (same as MCP proxy)
 *
 * Configuration variables:
 * - LLM_AGENT_MODEL: Model name (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet')
 * - LLM_AGENT_TEMPERATURE: Temperature (default: 0.7)
 * - LLM_AGENT_MAX_TOKENS: Max tokens (default: 2000)
 * - LLM_AGENT_MCP_DESTINATION: Destination name for MCP/ABAP connection (required)
 * - LLM_AGENT_MCP_ENDPOINT: MCP proxy endpoint URL (optional, defaults to local)
 * - LLM_AGENT_MODE: SmartAgent mode: 'smart' | 'pass' | 'hard' (default: 'smart')
 * - LLM_AGENT_MAX_ITERATIONS: Max tool loop iterations (default: 10)
 * - LLM_AGENT_RAG_TYPE: RAG backend: 'in-memory' | 'ollama' (default: 'in-memory')
 * - LLM_AGENT_EXPOSITION: Handler sets to expose (default: 'readonly,high')
 */

import cds from '@sap/cds';

export type SmartAgentMode = 'smart' | 'pass' | 'hard';
export type RagType = 'in-memory' | 'ollama';

/**
 * Handler set types matching @mcp-abap-adt/core exposition levels.
 * - readonly: Read*, Get* (read-only); auto-includes search + system
 * - high: Create*, Update*, Delete*, Get* (high-level CRUD)
 * - low: *Low — Lock, Unlock, Activate, Check, Validate (low-level ADT ops)
 * - compact: Handler* — unified facade
 * - search: SearchObject, GetObjectsList, GetObjectsByType
 * - system: GetWhereUsed, GetTypeInfo, Runtime*, etc.
 */
export type HandlerSet =
  | 'readonly'
  | 'high'
  | 'low'
  | 'compact'
  | 'search'
  | 'system';

export interface AgentConfig {
  /**
   * LLM Configuration
   */
  llm: {
    /**
     * Model name (determines which LLM provider SAP AI Core routes to)
     * Examples: 'gpt-4o-mini' (OpenAI), 'claude-3-5-sonnet' (Anthropic)
     */
    model: string;

    /**
     * Temperature (0.0 - 2.0)
     */
    temperature: number;

    /**
     * Maximum tokens in response
     */
    maxTokens: number;

    /**
     * SAP AI Core resource group (optional)
     */
    resourceGroup?: string;
  };

  /**
   * MCP Configuration
   */
  mcp: {
    /**
     * MCP destination name for ABAP connection
     * This destination must be configured in Destination service
     * The MCP proxy will use this destination to connect to ABAP
     */
    destination: string;

    /**
     * MCP proxy endpoint URL
     * If not provided, will be constructed from request (for BTP) or use localhost
     */
    endpoint?: string;
  };

  /**
   * SmartAgent orchestration settings
   */
  agent: {
    /** Agent mode: 'smart' (full orchestration), 'pass' (passthrough), 'hard' (tools only) */
    mode: SmartAgentMode;

    /** Maximum tool loop iterations */
    maxIterations: number;

    /** RAG backend type */
    ragType: RagType;

    /** Handler sets to expose (filters which MCP tools are available to the agent) */
    exposition: HandlerSet[];

    /** Max recent messages to include from client history (older excluded, available via RAG) */
    historyRecencyWindow?: number;
  };
}

/**
 * Load agent configuration from environment variables
 *
 * Configuration priority:
 * 1. Environment variables (set via mta.yaml or CF CLI)
 * 2. Default values
 *
 * @throws Error if required configuration is missing
 */
export function loadAgentConfig(): AgentConfig {
  const log = cds.log('agent-config');

  // LLM Configuration
  const model =
    process.env.LLM_AGENT_MODEL ||
    process.env.SAP_CORE_AI_MODEL ||
    'gpt-4o-mini';
  const temperature = Number.parseFloat(
    process.env.LLM_AGENT_TEMPERATURE ||
      process.env.SAP_CORE_AI_TEMPERATURE ||
      '0.7',
  );
  const maxTokens = Number.parseInt(
    process.env.LLM_AGENT_MAX_TOKENS ||
      process.env.SAP_CORE_AI_MAX_TOKENS ||
      '2000',
    10,
  );
  const resourceGroup = process.env.LLM_AGENT_RESOURCE_GROUP;

  // MCP Configuration
  const mcpDestination = process.env.LLM_AGENT_MCP_DESTINATION;

  if (!mcpDestination) {
    throw new Error(
      'LLM_AGENT_MCP_DESTINATION environment variable is required.\n' +
        'This destination must be configured in Destination service (BTP Cockpit).\n' +
        'The destination should point to your ABAP system (same as MCP proxy uses).',
    );
  }

  const mcpEndpoint =
    process.env.LLM_AGENT_MCP_ENDPOINT || process.env.MCP_ENDPOINT;

  // SmartAgent settings
  const mode = (process.env.LLM_AGENT_MODE || 'smart') as SmartAgentMode;
  const maxIterations = Number.parseInt(
    process.env.LLM_AGENT_MAX_ITERATIONS || '10',
    10,
  );
  const ragType = (process.env.LLM_AGENT_RAG_TYPE || 'in-memory') as RagType;

  // Handler set exposition (which MCP tool groups to expose)
  const expositionRaw = process.env.LLM_AGENT_EXPOSITION || 'readonly,high';
  const validSets = new Set<HandlerSet>([
    'readonly',
    'high',
    'low',
    'compact',
    'search',
    'system',
  ]);
  const exposition = expositionRaw
    .split(',')
    .map((s) => s.trim().toLowerCase() as HandlerSet)
    .filter((s) => validSets.has(s));
  // Auto-include search + system when readonly is present (matches mcp-abap-adt behavior)
  if (exposition.includes('readonly')) {
    if (!exposition.includes('search')) exposition.push('search');
    if (!exposition.includes('system')) exposition.push('system');
  }

  // History recency window (max recent messages from client history)
  const historyRecencyWindowRaw = process.env.LLM_AGENT_HISTORY_RECENCY_WINDOW;
  const historyRecencyWindow = historyRecencyWindowRaw
    ? Number.parseInt(historyRecencyWindowRaw, 10)
    : undefined;

  const config: AgentConfig = {
    llm: {
      model,
      temperature,
      maxTokens,
      resourceGroup,
    },
    mcp: {
      destination: mcpDestination,
      endpoint: mcpEndpoint,
    },
    agent: {
      mode,
      maxIterations,
      ragType,
      exposition,
      historyRecencyWindow,
    },
  };

  log.info('Agent configuration loaded', {
    model: config.llm.model,
    mcpDestination: config.mcp.destination,
    mcpEndpoint: config.mcp.endpoint || 'auto-detect',
    agentMode: config.agent.mode,
    maxIterations: config.agent.maxIterations,
    ragType: config.agent.ragType,
    exposition: config.agent.exposition,
    historyRecencyWindow: config.agent.historyRecencyWindow ?? 'unlimited',
  });

  return config;
}

/**
 * Get agent configuration (singleton)
 * Configuration is loaded once and cached
 */
let cachedConfig: AgentConfig | null = null;

export function getAgentConfig(): AgentConfig {
  if (!cachedConfig) {
    cachedConfig = loadAgentConfig();
  }
  return cachedConfig;
}

/**
 * Clear cached configuration (useful for testing)
 */
export function clearAgentConfig(): void {
  cachedConfig = null;
}

/**
 * Check whether SAP AI Core service binding is available.
 *
 * The sap-ai-sdk reads credentials from AICORE_SERVICE_KEY env var
 * or from 'aicore' / 'ai-core' entries in VCAP_SERVICES.
 * When AI Core resource is set to `active: false` in mta.yaml (no binding),
 * none of these will be present and agent endpoints cannot function.
 */
export function isAiCoreConfigured(): boolean {
  if (process.env.AICORE_SERVICE_KEY) return true;

  const vcap = process.env.VCAP_SERVICES;
  if (!vcap) return false;

  try {
    const services = JSON.parse(vcap);
    return !!(services.aicore?.[0] || services['ai-core']?.[0]);
  } catch {
    return false;
  }
}

/**
 * Ensure AI Core credentials are available.
 * Priority: VCAP_SERVICES > AICORE_SERVICE_KEY > individual AICORE_* env vars
 */
export function ensureAiCoreCredentials(): void {
  if (isAiCoreConfigured()) return;

  const authUrl = process.env.AICORE_AUTH_URL;
  const clientId = process.env.AICORE_CLIENT_ID;
  const clientSecret = process.env.AICORE_CLIENT_SECRET;
  const baseUrl = process.env.AICORE_BASE_URL;

  if (authUrl && clientId && clientSecret && baseUrl) {
    process.env.AICORE_SERVICE_KEY = JSON.stringify({
      clientid: clientId,
      clientsecret: clientSecret,
      url: authUrl,
      serviceurls: { AI_API_URL: baseUrl },
    });
    cds.log('agent-config').info('AI Core credentials assembled from env vars');
  }
}
