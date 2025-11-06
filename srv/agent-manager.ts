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
  OpenAIAgent,
  AnthropicAgent,
  DeepSeekAgent,
  PromptBasedAgent,
  OpenAIProvider,
  AnthropicProvider,
  DeepSeekProvider,
  MCPClientWrapper,
  type BaseAgent,
} from '@cloud-llm-hub/llm-agent';
import type { MCPClientConfig } from '@cloud-llm-hub/llm-agent';
import { SapCoreAIProvider } from './llm-providers/SapCoreAIProvider';
import { SapCoreAIAgent } from './llm-providers/SapCoreAIAgent';

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
 * Create LLM provider based on request configuration
 * Priority: SAP Core AI (if destination) > Headers > Environment variables > Error
 * 
 * IMPORTANT: LLM provider must be explicitly specified via:
 * - HTTP header: X-LLM-Provider (openai, anthropic, deepseek)
 * - Environment variable: LLM_PROVIDER (openai, anthropic, deepseek)
 * 
 * API keys can be provided via:
 * - HTTP headers: X-OpenAI-API-Key, X-Anthropic-API-Key, X-DeepSeek-API-Key
 * - Environment variables: OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY
 */
async function createLLMProvider(req: Request) {
  const log = cds.log('agent-manager');
  
  // Check for SAP Core AI destination (highest priority)
  const sapCoreAIDestination = req.headers['x-sap-core-ai-destination'] as string | undefined;
  if (sapCoreAIDestination) {
    log.info('Using SAP Core AI provider', { destination: sapCoreAIDestination });
    return new SapCoreAIProvider({
      destinationName: sapCoreAIDestination,
      apiKey: '', // Not used for SAP Core AI
      model: (req.headers['x-sap-core-ai-model'] as string) || process.env.SAP_CORE_AI_MODEL || 'gpt-4o-mini',
      temperature: parseFloat((req.headers['x-sap-core-ai-temperature'] as string) || '0.7'),
      maxTokens: parseInt((req.headers['x-sap-core-ai-max-tokens'] as string) || '2000'),
    });
  }
  
  // Determine provider from header or environment variable (must be explicitly set)
  const provider = (req.headers['x-llm-provider'] as string) || process.env.LLM_PROVIDER;
  
  if (!provider) {
    throw new Error(
      'LLM provider must be explicitly specified. Provide either:\n' +
      '  - X-SAP-Core-AI-Destination header for SAP Core AI, or\n' +
      '  - X-LLM-Provider header (openai, anthropic, deepseek), or\n' +
      '  - LLM_PROVIDER environment variable (openai, anthropic, deepseek)\n\n' +
      'Example: Set LLM_PROVIDER=openai in .env file or pass X-LLM-Provider: openai header'
    );
  }
  
  const providerLower = provider.toLowerCase();
  
  // Check for Anthropic
  if (providerLower === 'anthropic') {
    const anthropicApiKey = (req.headers['x-anthropic-api-key'] as string) || process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is required when using Anthropic provider.\n' +
        'Provide either X-Anthropic-API-Key header or ANTHROPIC_API_KEY environment variable.'
      );
    }
    log.info('Using Anthropic provider');
    return new AnthropicProvider({
      apiKey: anthropicApiKey,
      model: (req.headers['x-anthropic-model'] as string) || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
    });
  }
  
  // Check for DeepSeek
  if (providerLower === 'deepseek') {
    const deepseekApiKey = (req.headers['x-deepseek-api-key'] as string) || process.env.DEEPSEEK_API_KEY;
    if (!deepseekApiKey) {
      throw new Error(
        'DEEPSEEK_API_KEY is required when using DeepSeek provider.\n' +
        'Provide either X-DeepSeek-API-Key header or DEEPSEEK_API_KEY environment variable.'
      );
    }
    log.info('Using DeepSeek provider');
    return new DeepSeekProvider({
      apiKey: deepseekApiKey,
      model: (req.headers['x-deepseek-model'] as string) || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    });
  }
  
  // Check for OpenAI
  if (providerLower === 'openai') {
    const openaiApiKey = (req.headers['x-openai-api-key'] as string) || process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error(
        'OPENAI_API_KEY is required when using OpenAI provider.\n' +
        'Provide either X-OpenAI-API-Key header or OPENAI_API_KEY environment variable.'
      );
    }
    log.info('Using OpenAI provider');
    return new OpenAIProvider({
      apiKey: openaiApiKey,
      model: (req.headers['x-openai-model'] as string) || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      organization: (req.headers['x-openai-org'] as string) || process.env.OPENAI_ORG,
      project: (req.headers['x-openai-project'] as string) || process.env.OPENAI_PROJECT || process.env.OPENAI_PRJ,
    });
  }
  
  // Unknown provider
  throw new Error(
    `Unknown LLM provider: "${provider}". Supported providers: openai, anthropic, deepseek\n` +
    `Set LLM_PROVIDER environment variable or X-LLM-Provider header to one of: openai, anthropic, deepseek`
  );
}

/**
 * Create agent instance based on LLM provider type
 */
async function createAgentForProvider(
  llmProvider: any,
  mcpClient: MCPClientWrapper
): Promise<BaseAgent> {
  const log = cds.log('agent-manager');
  
  // Determine agent type based on provider
  if (llmProvider instanceof SapCoreAIProvider) {
    log.debug('Creating SapCoreAIAgent');
    return new SapCoreAIAgent({
      llmProvider,
      mcpClient,
    });
  }
  
  if (llmProvider instanceof OpenAIProvider) {
    log.debug('Creating OpenAIAgent');
    return new OpenAIAgent({
      llmProvider,
      mcpClient,
    });
  }
  
  if (llmProvider instanceof AnthropicProvider) {
    log.debug('Creating AnthropicAgent');
    return new AnthropicAgent({
      llmProvider,
      mcpClient,
    });
  }
  
  if (llmProvider instanceof DeepSeekProvider) {
    log.debug('Creating DeepSeekAgent');
    return new DeepSeekAgent({
      llmProvider,
      mcpClient,
    });
  }
  
  // Fallback to prompt-based agent
  log.debug('Creating PromptBasedAgent (fallback)');
  return new PromptBasedAgent({
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

