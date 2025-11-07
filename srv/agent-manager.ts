/**
 * Agent Manager - Wrapper for LLM Agent
 * 
 * This wrapper handles all MCP configuration at cloud-llm-hub level.
 * The agent itself doesn't know about SAP destinations or MCP specifics.
 * 
 * Architecture:
 * - Request → Agent Manager → extracts SAP config from headers → creates MCP client with proper headers → passes to Agent
 * - Agent → works with MCP client (doesn't know about SAP)
 * - MCP Client → connects to MCP proxy with headers
 * - MCP Proxy → handles headers and creates MCP server with SAP config
 */

import cds, { type Request } from '@sap/cds';
import {
  SapCoreAIAgent,
  SapCoreAIProvider,
  MCPClientWrapper,
  type BaseAgent,
  type SapCoreAIConfig,
} from '@cloud-llm-hub/llm-agent';
import type { MCPClientConfig } from '@cloud-llm-hub/llm-agent';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- xsenv has no type definitions
const xsenv = require('@sap/xsenv');

interface AgentInstance {
  agent: BaseAgent;
  created: number;
  expiresAt?: number;
  destinationName?: string;
}

const agentCache = new Map<string, AgentInstance>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Build MCP client configuration from request headers
 * This is where cloud-llm-hub determines which MCP to use and how to configure it
 */
function buildMCPConfig(req: Request): MCPClientConfig {
  const log = cds.log('agent-manager');
  
  // MCP endpoint - always use the local MCP proxy
  const mcpEndpoint = process.env.MCP_ENDPOINT || 'http://localhost:4004/mcp/stream/http';
  
  // Extract authentication from request
  const authHeader = req.headers.authorization as string || 'Basic YWxpY2U6';
  
  // Build headers for MCP proxy
  // These headers will be processed by MCP proxy to determine SAP configuration
  const headers: Record<string, string> = {
    'Authorization': authHeader,
  };
  
  // Copy SAP-related headers from request to MCP client headers
  // MCP proxy will use these to configure the embedded MCP server
  const destination = req.headers['x-sap-destination'] as string | undefined;
  if (destination) {
    headers['X-SAP-Destination'] = destination;
  }
  
  const sapUrl = req.headers['x-sap-url'] as string | undefined;
  if (sapUrl) {
    headers['X-SAP-URL'] = sapUrl;
  }
  
  const sapAuthType = req.headers['x-sap-auth-type'] as string | undefined;
  if (sapAuthType) {
    headers['X-SAP-Auth-Type'] = sapAuthType;
  }
  
  const sapJwtToken = req.headers['x-sap-jwt-token'] as string | undefined;
  if (sapJwtToken) {
    headers['X-SAP-JWT-Token'] = sapJwtToken;
  }
  
  const sapUsername = req.headers['x-sap-username'] as string | undefined;
  if (sapUsername) {
    headers['X-SAP-Username'] = sapUsername;
  }
  
  const sapPassword = req.headers['x-sap-password'] as string | undefined;
  if (sapPassword) {
    headers['X-SAP-Password'] = sapPassword;
  }
  
  const sapClient = req.headers['x-sap-client'] as string | undefined;
  if (sapClient) {
    headers['X-SAP-Client'] = sapClient;
  }
  
  log.debug('Building MCP config', {
    mcpEndpoint,
    hasDestination: !!destination,
    hasDirectConfig: !!sapUrl,
  });
  
  return {
    url: mcpEndpoint,
    headers,
  };
}

/**
 * Get cache key for agent instance
 */
function getCacheKey(req: Request): string {
  const destination = req.headers['x-sap-destination'] as string | undefined;
  const sapUrl = req.headers['x-sap-url'] as string | undefined;
  
  // Cache by destination or SAP URL
  if (destination) {
    return `agent:destination:${destination}`;
  }
  if (sapUrl) {
    return `agent:direct:${sapUrl}`;
  }
  return 'agent:default';
}

/**
 * Get SAP AI Core service binding from VCAP_SERVICES
 * Returns service credentials if bound, null otherwise
 */
function getAICoreServiceBinding(): any | null {
  try {
    xsenv.loadEnv();
    const services = xsenv.getServices({ 'ai-core': { tag: 'ai-core' } });
    return services['ai-core'] || null;
  } catch (error) {
    // Service not bound or not found
    return null;
  }
}

/**
 * Create LLM provider based on request configuration
 * 
 * IMPORTANT: All LLM providers are accessed through SAP AI Core.
 * - OpenAI models → SAP AI Core → OpenAI
 * - Anthropic models → SAP AI Core → Anthropic
 * - DeepSeek models → SAP AI Core → DeepSeek
 * 
 * Architecture:
 * - mta.yaml binds the app to SAP AI Core service (cloud-llm-hub-ai-core resource)
 * - Service binding provides access to AI Core via VCAP_SERVICES
 * - If destination is provided, it's used (allows pointing to different AI Core instances)
 * - If no destination, service binding is used directly
 * - All model/provider configuration is done in SAP AI Core Launchpad
 * 
 * Configuration:
 * - X-SAP-Core-AI-Destination: SAP destination name for AI Core service (optional)
 *   If not provided, service binding from mta.yaml is used
 * - X-SAP-Core-AI-Model: Model name (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet', 'deepseek-chat')
 *   Model must be configured in SAP AI Core Launchpad
 * - X-SAP-Core-AI-Temperature: Temperature (optional, default: 0.7)
 * - X-SAP-Core-AI-Max-Tokens: Max tokens (optional, default: 2000)
 */
async function createLLMProvider(req: Request): Promise<SapCoreAIProvider> {
  const log = cds.log('agent-manager');
  
  // Check if destination is provided (optional - can use service binding instead)
  const sapCoreAIDestination = 
    (req.headers['x-sap-core-ai-destination'] as string) || 
    process.env.SAP_CORE_AI_DESTINATION;
  
  // Check if service binding is available
  const aiCoreService = getAICoreServiceBinding();
  
  // If no destination and no service binding, throw error
  if (!sapCoreAIDestination && !aiCoreService) {
    throw new Error(
      'SAP AI Core access is required. All LLM providers are accessed through SAP AI Core.\n' +
      'Provide either:\n' +
      '  - X-SAP-Core-AI-Destination header (destination name), or\n' +
      '  - SAP_CORE_AI_DESTINATION environment variable, or\n' +
      '  - Ensure SAP AI Core service is bound via mta.yaml (cloud-llm-hub-ai-core resource)\n\n' +
      'If using destination: configure it in Destination service (BTP Cockpit).\n' +
      'If using service binding: mta.yaml automatically binds the service.\n' +
      'All model/provider configuration is done in SAP AI Core Launchpad.'
    );
  }
  
  // Use destination if provided, otherwise use service binding name
  // executeHttpRequest will automatically use service binding if destination doesn't exist
  const destinationName = sapCoreAIDestination || 'cloud-llm-hub-ai-core';
  
  if (sapCoreAIDestination) {
    log.info('Using SAP Core AI provider via destination', { destination: sapCoreAIDestination });
  } else if (aiCoreService) {
    log.info('Using SAP Core AI provider via service binding', { serviceName: aiCoreService.name });
  }
  
  // Create SAP Core AI provider with HTTP client using SAP Cloud SDK
  return new SapCoreAIProvider({
    destinationName: destinationName,
    apiKey: '', // Not used for SAP AI Core
    model: (req.headers['x-sap-core-ai-model'] as string) || process.env.SAP_CORE_AI_MODEL || 'gpt-4o-mini',
    temperature: parseFloat((req.headers['x-sap-core-ai-temperature'] as string) || process.env.SAP_CORE_AI_TEMPERATURE || '0.7'),
    maxTokens: parseInt((req.headers['x-sap-core-ai-max-tokens'] as string) || process.env.SAP_CORE_AI_MAX_TOKENS || '2000'),
    httpClient: async (config) => {
      // Use SAP Cloud SDK executeHttpRequest
      // If destination exists, it will be used
      // If not, executeHttpRequest will try to use service binding with matching name
      return await executeHttpRequest(
        { destinationName: config.destinationName },
        {
          method: config.method as any,
          url: config.url,
          headers: config.headers,
          data: config.data,
        }
      );
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
  mcpClient: MCPClientWrapper
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
 * Get or create agent instance for a request
 * This is the main entry point - agent doesn't know about SAP, only about MCP client
 */
export async function getAgent(req: Request): Promise<BaseAgent> {
  const log = cds.log('agent-manager');
  
  // Determine which LLM provider to use
  const llmProvider = await createLLMProvider(req);
  
  // Get cache key (include LLM provider type in cache key)
  const llmProviderType = llmProvider.constructor.name;
  const cacheKey = `${getCacheKey(req)}:${llmProviderType}`;
  
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
  
  // Build MCP configuration from request headers
  // This is where cloud-llm-hub determines MCP configuration
  const mcpConfig = buildMCPConfig(req);
  
  log.info('Creating new agent instance', {
    cacheKey,
    mcpEndpoint: mcpConfig.url,
    llmProvider: llmProviderType,
  });
  
  // Create MCP client with configuration
  // Agent doesn't know about SAP - it just works with MCP client
  const mcpClient = new MCPClientWrapper(mcpConfig);
  
  // Create agent instance based on LLM provider type
  // Each agent implementation knows how to properly integrate MCP tools with its LLM
  const agent = await createAgentForProvider(llmProvider, mcpClient);
  
  // Connect agent to MCP
  // If connection fails (e.g., missing SAP config), agent will work in LLM-only mode
  try {
    await agent.connect();
    log.debug('Agent connected to MCP successfully');
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    // If error is about missing SAP config, log warning but continue
    // Agent will work in LLM-only mode (no tools available)
    if (errorMessage.includes('Missing X-SAP-URL') || 
        errorMessage.includes('Missing X-SAP-Destination') ||
        errorMessage.includes('Bad Gateway')) {
      log.warn('MCP connection failed (missing SAP config), agent will work in LLM-only mode', {
        error: errorMessage,
        cacheKey
      });
      // Agent will still work, just without MCP tools
      // The tools list will be empty, so agent will only use LLM
    } else {
      // For other errors, rethrow
      log.error('MCP connection failed with unexpected error', { error: errorMessage });
      throw error;
    }
  }
  
  // Cache instance
  const expiresAt = Date.now() + CACHE_TTL;
  const destination = req.headers['x-sap-destination'] as string | undefined;
  agentCache.set(cacheKey, {
    agent,
    created: Date.now(),
    expiresAt,
    destinationName: destination,
  });
  
  log.info('Agent instance created and connected', { cacheKey, agentType: agent.constructor.name });
  
  return agent;
}

/**
 * Clear agent cache (useful for testing or when configurations change)
 */
export function clearAgentCache(): void {
  agentCache.clear();
  cds.log('agent-manager').info('Agent cache cleared');
}

