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
 */

import cds from '@sap/cds';

export type SmartAgentMode = 'smart' | 'pass' | 'hard';
export type RagType = 'in-memory' | 'ollama';

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
    },
  };

  log.info('Agent configuration loaded', {
    model: config.llm.model,
    mcpDestination: config.mcp.destination,
    mcpEndpoint: config.mcp.endpoint || 'auto-detect',
    agentMode: config.agent.mode,
    maxIterations: config.agent.maxIterations,
    ragType: config.agent.ragType,
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
