/**
 * Agent Configuration Module
 *
 * Reads configuration from environment variables (set via mta.yaml or CF CLI).
 * This configuration is used by Agent Service (OData) to connect to LLM and MCP.
 *
 * Architecture:
 * - Configuration comes from environment variables (mta.yaml deployment or CF CLI)
 * - SAP AI Core access via service binding (cloud-llm-hub-ai-core from mta.yaml)
 * - MCP destination is resolved via SAP Cloud SDK (same as MCP proxy)
 * - All authentication is handled through service binding (AI Core) and destination (MCP)
 *
 * Configuration variables:
 * - LLM_AGENT_MODEL: Model name (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet')
 * - LLM_AGENT_TEMPERATURE: Temperature (default: 0.7)
 * - LLM_AGENT_MAX_TOKENS: Max tokens (default: 2000)
 * - LLM_AGENT_MCP_DESTINATION: Destination name for MCP/ABAP connection (required)
 * - LLM_AGENT_MCP_ENDPOINT: MCP proxy endpoint URL (optional, defaults to local)
 */

import cds from '@sap/cds';

export interface AICoreServiceBinding {
  name: string;
  credentials: {
    clientid: string;
    clientsecret: string;
    url?: string;
    tokenurl?: string;
    serviceurls?: {
      AI_API_URL?: string;
    };
  };
}

export interface AgentConfig {
  /**
   * LLM Configuration
   */
  llm: {
    /**
     * SAP AI Core service binding (from VCAP_SERVICES)
     * Service is bound via mta.yaml (cloud-llm-hub-ai-core resource)
     */
    aiCoreService: AICoreServiceBinding;

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
}

/**
 * Get SAP AI Core service binding from VCAP_SERVICES
 * Service is bound via mta.yaml (cloud-llm-hub-ai-core resource)
 */
function getAICoreServiceBinding(): AICoreServiceBinding | null {
  try {
    const vcapServices = process.env.VCAP_SERVICES
      ? JSON.parse(process.env.VCAP_SERVICES)
      : {};

    // Try different possible service names
    if (vcapServices.aicore && vcapServices.aicore.length > 0) {
      return vcapServices.aicore[0];
    }

    // Also try 'ai-core' (with hyphen)
    if (vcapServices['ai-core'] && vcapServices['ai-core'].length > 0) {
      return vcapServices['ai-core'][0];
    }

    return null;
  } catch (_error) {
    return null;
  }
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

  // LLM Configuration - get SAP AI Core service binding
  const aiCoreService = getAICoreServiceBinding();

  if (!aiCoreService) {
    throw new Error(
      'SAP AI Core service binding not found in VCAP_SERVICES.\n' +
        'Ensure that cloud-llm-hub-ai-core resource is bound in mta.yaml.\n' +
        'The service binding provides access to SAP AI Core via service credentials.',
    );
  }

  const model =
    process.env.LLM_AGENT_MODEL ||
    process.env.SAP_CORE_AI_MODEL ||
    'gpt-4o-mini';
  const temperature = parseFloat(
    process.env.LLM_AGENT_TEMPERATURE ||
      process.env.SAP_CORE_AI_TEMPERATURE ||
      '0.7',
  );
  const maxTokens = parseInt(
    process.env.LLM_AGENT_MAX_TOKENS ||
      process.env.SAP_CORE_AI_MAX_TOKENS ||
      '2000',
    10,
  );

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

  const config: AgentConfig = {
    llm: {
      aiCoreService,
      model,
      temperature,
      maxTokens,
    },
    mcp: {
      destination: mcpDestination,
      endpoint: mcpEndpoint,
    },
  };

  log.info('Agent configuration loaded', {
    model: config.llm.model,
    aiCoreServiceName: config.llm.aiCoreService.name,
    mcpDestination: config.mcp.destination,
    mcpEndpoint: config.mcp.endpoint || 'auto-detect',
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
