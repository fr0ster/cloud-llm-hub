/**
 * Agent Manager - Wrapper for LLM Agent
 *
 * This wrapper handles all configuration at cloud-llm-hub level.
 * Configuration comes from environment variables (set via mta.yaml or CF CLI).
 *
 * Architecture:
 * - Configuration → Agent Manager → creates LLM provider with SAP AI Core destination → creates MCP client with MCP destination → passes to Agent
 * - Agent → works with MCP client (doesn't know about SAP)
 * - MCP Client → connects to MCP proxy with destination header
 * - MCP Proxy → resolves destination and creates MCP server with SAP config
 *
 * Configuration:
 * - LLM settings (model, temperature, maxTokens) from env vars
 * - SAP AI Core destination from env vars
 * - MCP destination from env vars
 * - All authentication handled through destinations
 */

import type { MCPClientConfig } from '@cloud-llm-hub/llm-agent';
import {
  type BaseAgent,
  MCPClientWrapper,
  SapCoreAIAgent,
  SapCoreAIProvider,
} from '@cloud-llm-hub/llm-agent';
import cds, { type Request } from '@sap/cds';
import { type AgentConfig, getAgentConfig } from './agent-config';

interface AgentInstance {
  agent: BaseAgent;
  created: number;
  expiresAt?: number;
  destinationName?: string;
}

const agentCache = new Map<string, AgentInstance>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Build MCP client configuration from agent configuration
 * MCP client connects to MCP proxy, which resolves destination and creates MCP server
 */
function buildMCPConfig(config: AgentConfig, req: Request): MCPClientConfig {
  const log = cds.log('agent-manager');

  // MCP endpoint - use config or construct from request
  let mcpEndpoint = config.mcp.endpoint;
  if (!mcpEndpoint) {
    // On BTP, construct URL from request
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host =
      req.headers.host || req.headers['x-forwarded-host'] || 'localhost:4004';
    mcpEndpoint = `${protocol}://${host}/mcp/stream/http`;
  }

  // Extract authentication from request (for MCP proxy authentication)
  const authHeader = (req.headers.authorization as string) || 'Basic YWxpY2U6';

  // Build headers for MCP proxy
  // MCP proxy will resolve destination and create MCP server with SAP config
  const headers: Record<string, string> = {
    Authorization: authHeader,
    // Pass destination name to MCP proxy
    // MCP proxy will resolve this destination and use it for ABAP connection
    'X-SAP-Destination': config.mcp.destination,
  };

  log.debug('Building MCP config from agent configuration', {
    mcpEndpoint,
    mcpDestination: config.mcp.destination,
  });

  return {
    url: mcpEndpoint,
    headers,
  };
}

/**
 * Get cache key for agent instance
 * Since configuration is global (from env vars), we use a single cache key
 */
function getCacheKey(config: AgentConfig): string {
  // Cache by MCP destination (since that's what varies per agent instance)
  return `agent:config:${config.mcp.destination}:${config.llm.model}`;
}

/**
 * Create LLM provider based on agent configuration
 *
 * IMPORTANT: All LLM providers are accessed through SAP AI Core.
 * - OpenAI models → SAP AI Core → OpenAI
 * - Anthropic models → SAP AI Core → Anthropic
 * - DeepSeek models → SAP AI Core → DeepSeek
 *
 * Architecture:
 * - Configuration comes from environment variables (set via mta.yaml or CF CLI)
 * - SAP AI Core access via service binding (cloud-llm-hub-ai-core from mta.yaml)
 * - Service binding provides credentials (clientid, clientsecret, serviceurls)
 * - All authentication is handled through service binding (OAuth2ClientCredentials)
 * - Model/provider configuration is done in SAP AI Core Launchpad
 *
 * Configuration (from env vars):
 * - LLM_AGENT_MODEL: Model name (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet')
 * - LLM_AGENT_TEMPERATURE: Temperature (default: 0.7)
 * - LLM_AGENT_MAX_TOKENS: Max tokens (default: 2000)
 */
async function createLLMProvider(
  config: AgentConfig,
): Promise<SapCoreAIProvider> {
  const log = cds.log('agent-manager');

  const aiCoreService = config.llm.aiCoreService;
  const serviceCredentials = aiCoreService.credentials;
  const serviceUrl =
    serviceCredentials?.serviceurls?.AI_API_URL ||
    serviceCredentials?.url ||
    'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com';

  log.info('Creating SAP Core AI provider via service binding', {
    serviceName: aiCoreService.name,
    serviceUrl: serviceUrl,
    model: config.llm.model,
  });

  // Create SAP Core AI provider with HTTP client using service binding
  // All authentication is handled through service binding (OAuth2ClientCredentials)
  return new SapCoreAIProvider({
    destinationName: 'cloud-llm-hub-ai-core', // Fallback name (not used, serviceUrl is used instead)
    apiKey: '', // Not used for SAP AI Core
    model: config.llm.model,
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
    httpClient: async (httpConfig) => {
      log.debug('Making request to SAP AI Core via service binding', {
        serviceUrl: serviceUrl,
        url: httpConfig.url,
        method: httpConfig.method,
      });

      // Use service binding directly - make HTTP request to service URL
      const axios = await import('axios');
      const fullUrl = `${serviceUrl}${httpConfig.url}`;

      // Get OAuth2 token from service binding credentials
      // SAP AI Core uses OAuth2ClientCredentials flow
      let accessToken: string | undefined;
      if (serviceCredentials.clientid && serviceCredentials.clientsecret) {
        try {
          const tokenUrl =
            serviceCredentials.tokenurl ||
            serviceCredentials.url ||
            'https://acme-subaccount.authentication.eu10.hana.ondemand.com/oauth/token';

          const tokenResponse = await axios.default.post(
            tokenUrl,
            new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: serviceCredentials.clientid,
              client_secret: serviceCredentials.clientsecret,
            }),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
            },
          );

          accessToken = tokenResponse.data.access_token;
          log.debug('Obtained OAuth2 token from service binding');
        } catch (tokenError: unknown) {
          const err =
            tokenError instanceof Error
              ? tokenError
              : new Error(String(tokenError));
          log.warn('Failed to get OAuth2 token from service binding', {
            error: err.message,
          });
          // Fallback to Basic auth if OAuth2 fails
        }
      }

      // Use OAuth2 token if available, otherwise try Basic auth
      const authHeader = accessToken
        ? `Bearer ${accessToken}`
        : serviceCredentials.clientid && serviceCredentials.clientsecret
          ? `Basic ${Buffer.from(`${serviceCredentials.clientid}:${serviceCredentials.clientsecret}`).toString('base64')}`
          : undefined;

      if (!authHeader) {
        throw new Error('No authentication method available for SAP AI Core');
      }

      const response = await axios.default.request({
        // biome-ignore lint/suspicious/noExplicitAny: axios method type is not fully compatible with httpConfig.method
        method: httpConfig.method as any,
        url: fullUrl,
        headers: {
          ...httpConfig.headers,
          Authorization: authHeader,
        },
        data: httpConfig.data,
      });

      return { data: response.data };
    },
    log: log,
  });
}

/**
 * Create agent instance based on LLM provider type
 *
 * All agents use SAP Core AI provider, which routes to different LLM providers
 * based on the model name (e.g., 'gpt-4o-mini' → OpenAI, 'claude-3-5-sonnet' → Anthropic)
 */
async function createAgentForProvider(
  llmProvider: SapCoreAIProvider,
  mcpClient: MCPClientWrapper,
): Promise<BaseAgent> {
  const log = cds.log('agent-manager');

  // All agents use SAP Core AI provider
  log.debug('Creating SapCoreAIAgent');
  return new SapCoreAIAgent({
    llmProvider,
    mcpClient,
  });
}

/**
 * Get or create agent instance
 * Configuration comes from environment variables (set via mta.yaml or CF CLI)
 * This is the main entry point - agent doesn't know about SAP, only about MCP client
 */
export async function getAgent(req: Request): Promise<BaseAgent> {
  const log = cds.log('agent-manager');

  // Load configuration from environment variables
  const config = getAgentConfig();

  // Create LLM provider from configuration
  const llmProvider = await createLLMProvider(config);

  // Get cache key (based on configuration)
  const llmProviderType = llmProvider.constructor.name;
  const cacheKey = `${getCacheKey(config)}:${llmProviderType}`;

  // Check cache
  const cached = agentCache.get(cacheKey);
  if (cached) {
    const now = Date.now();
    if (!cached.expiresAt || now < cached.expiresAt) {
      log.debug('Using cached agent instance', { cacheKey });
      return cached.agent;
    }
    // Expired, remove from cache
    agentCache.delete(cacheKey);
  }

  // Build MCP configuration from agent configuration
  const mcpConfig = buildMCPConfig(config, req);

  log.info('Creating new agent instance', {
    cacheKey,
    mcpEndpoint: mcpConfig.url,
    mcpDestination: config.mcp.destination,
    llmProvider: llmProviderType,
    model: config.llm.model,
  });

  // Create MCP client with configuration
  // Agent doesn't know about SAP - it just works with MCP client
  const mcpClient = new MCPClientWrapper(mcpConfig);

  // Create agent instance
  const agent = await createAgentForProvider(llmProvider, mcpClient);

  // Connect agent to MCP
  // If connection fails, agent will work in LLM-only mode
  try {
    await agent.connect();
    log.debug('Agent connected to MCP successfully');
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // If error is about missing destination or connection issues, log warning but continue
    // Agent will work in LLM-only mode (no tools available)
    if (
      errorMessage.includes('Bad Gateway') ||
      errorMessage.includes('destination') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ENOTFOUND')
    ) {
      log.warn('MCP connection failed, agent will work in LLM-only mode', {
        error: errorMessage,
        cacheKey,
        mcpDestination: config.mcp.destination,
      });
      // Agent will still work, just without MCP tools
      // The tools list will be empty, so agent will only use LLM
    } else {
      // For other errors, rethrow
      log.error('MCP connection failed with unexpected error', {
        error: errorMessage,
      });
      throw error;
    }
  }

  // Cache instance
  const expiresAt = Date.now() + CACHE_TTL;
  agentCache.set(cacheKey, {
    agent,
    created: Date.now(),
    expiresAt,
    destinationName: config.mcp.destination,
  });

  log.info('Agent instance created and connected', {
    cacheKey,
    agentType: agent.constructor.name,
    mcpDestination: config.mcp.destination,
  });

  return agent;
}

/**
 * Clear agent cache (useful for testing or when configurations change)
 */
export function clearAgentCache(): void {
  agentCache.clear();
  cds.log('agent-manager').info('Agent cache cleared');
}
