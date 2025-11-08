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
  
  // MCP endpoint - use environment variable or construct from request
  let mcpEndpoint = process.env.MCP_ENDPOINT;
  if (!mcpEndpoint) {
    // On BTP, construct URL from request
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host || req.headers['x-forwarded-host'] || 'localhost:4004';
    mcpEndpoint = `${protocol}://${host}/mcp/stream/http`;
  }
  
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
    // Always use VCAP_SERVICES directly - it's the most reliable method
    // xsenv.getServices() might return a different structure
    const vcapServices = process.env.VCAP_SERVICES 
      ? JSON.parse(process.env.VCAP_SERVICES)
      : {};
    
    // Try different possible service names
    if (vcapServices['aicore'] && vcapServices['aicore'].length > 0) {
      // Return the full service object from VCAP_SERVICES (includes credentials)
      return vcapServices['aicore'][0];
    }
    
    // Also try 'ai-core' (with hyphen)
    if (vcapServices['ai-core'] && vcapServices['ai-core'].length > 0) {
      return vcapServices['ai-core'][0];
    }
    
    // Fallback to xsenv if VCAP_SERVICES doesn't work
    try {
      xsenv.loadEnv();
      const services = xsenv.getServices({ 'aicore': {} });
      if (services['aicore']) {
        return services['aicore'];
      }
    } catch (e) {
      // xsenv failed, return null
    }
    
    return null;
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
  
  // If service binding is available, use it directly (no destination needed)
  // If destination is provided, use it (allows pointing to different AI Core instances)
  let destinationName: string | undefined;
  let serviceUrl: string | undefined;
  let serviceCredentials: any = undefined;
  
  if (sapCoreAIDestination) {
    // Use destination if explicitly provided
    destinationName = sapCoreAIDestination;
    log.info('Using SAP Core AI provider via destination', { destination: sapCoreAIDestination });
  } else if (aiCoreService) {
    // Use service binding directly - get URL from service credentials
    // Since getAICoreServiceBinding() now reads directly from VCAP_SERVICES,
    // aiCoreService should have the full structure with credentials
    serviceCredentials = aiCoreService.credentials;
    serviceUrl = serviceCredentials?.serviceurls?.AI_API_URL || 
                 serviceCredentials?.url ||
                 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com';
    
    // Log detailed structure for debugging
    log.info('Using SAP Core AI provider via service binding', { 
      serviceName: aiCoreService.name,
      serviceUrl: serviceUrl,
      hasCredentials: !!serviceCredentials,
      credentialsKeys: serviceCredentials ? Object.keys(serviceCredentials) : [],
      aiCoreServiceKeys: Object.keys(aiCoreService || {}),
      hasCredentialsProp: !!aiCoreService.credentials,
    });
    
    // If credentials is still empty/undefined, this is an error
    if (!serviceCredentials || (typeof serviceCredentials === 'object' && Object.keys(serviceCredentials).length === 0)) {
      log.error('Service credentials not found in aiCoreService! This should not happen if VCAP_SERVICES is correct.', {
        serviceCredentialsType: typeof serviceCredentials,
        serviceCredentialsIsNull: serviceCredentials === null,
        serviceCredentialsIsUndefined: serviceCredentials === undefined,
        aiCoreServiceStructure: JSON.stringify(aiCoreService, null, 2).substring(0, 500),
      });
    }
  }
  
  // Create SAP Core AI provider with HTTP client
  // Capture serviceUrl and serviceCredentials in closure for httpClient
  const capturedServiceUrl = serviceUrl;
  const capturedServiceCredentials = serviceCredentials;
  const capturedDestinationName = destinationName;
  
  return new SapCoreAIProvider({
    destinationName: capturedDestinationName || 'cloud-llm-hub-ai-core', // Fallback name (not used if serviceUrl is set)
    apiKey: '', // Not used for SAP AI Core
    model: (req.headers['x-sap-core-ai-model'] as string) || process.env.SAP_CORE_AI_MODEL || 'gpt-4o-mini',
    temperature: parseFloat((req.headers['x-sap-core-ai-temperature'] as string) || process.env.SAP_CORE_AI_TEMPERATURE || '0.7'),
    maxTokens: parseInt((req.headers['x-sap-core-ai-max-tokens'] as string) || process.env.SAP_CORE_AI_MAX_TOKENS || '2000'),
    httpClient: async (config) => {
      log.info('httpClient called', {
        hasServiceUrl: !!capturedServiceUrl,
        hasServiceCredentials: !!capturedServiceCredentials,
        serviceUrl: capturedServiceUrl,
        destinationName: capturedDestinationName,
      });
      
      if (capturedServiceUrl && capturedServiceCredentials) {
        log.info('Using service binding directly (no destination)');
        // Use service binding directly - make HTTP request to service URL
        const axios = await import('axios');
        const fullUrl = `${capturedServiceUrl}${config.url}`;
        
        // Get OAuth2 token from service binding credentials
        // SAP AI Core uses OAuth2ClientCredentials flow
        let accessToken: string | undefined;
        if (capturedServiceCredentials.clientid && capturedServiceCredentials.clientsecret) {
          try {
            const tokenUrl = capturedServiceCredentials.url || 
                            capturedServiceCredentials.tokenurl ||
                            'https://acme-subaccount.authentication.eu10.hana.ondemand.com/oauth/token';
            
            const tokenResponse = await axios.default.post(
              tokenUrl,
              new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: capturedServiceCredentials.clientid,
                client_secret: capturedServiceCredentials.clientsecret,
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
              }
            );
            
            accessToken = tokenResponse.data.access_token;
            log.debug('Obtained OAuth2 token from service binding');
          } catch (tokenError: any) {
            log.warn('Failed to get OAuth2 token from service binding', { 
              error: tokenError.message 
            });
            // Fallback to Basic auth if OAuth2 fails
          }
        }
        
        // Use OAuth2 token if available, otherwise try Basic auth
        const authHeader = accessToken
          ? `Bearer ${accessToken}`
          : (capturedServiceCredentials.clientid && capturedServiceCredentials.clientsecret
              ? `Basic ${Buffer.from(`${capturedServiceCredentials.clientid}:${capturedServiceCredentials.clientsecret}`).toString('base64')}`
              : undefined);
        
        log.debug('Making request to SAP AI Core', {
          url: fullUrl,
          method: config.method,
          hasAuth: !!authHeader,
        });
        
        const response = await axios.default.request({
          method: config.method as any,
          url: fullUrl,
          headers: {
            ...config.headers,
            ...(authHeader ? { 'Authorization': authHeader } : {}),
          },
          data: config.data,
        });
        
        return { data: response.data };
      } else {
        log.info('Using destination via SAP Cloud SDK (fallback)');
        // Use destination via SAP Cloud SDK
        return await executeHttpRequest(
          { destinationName: config.destinationName },
          {
            method: config.method as any,
            url: config.url,
            headers: config.headers,
            data: config.data,
          },
          {
            fetchCsrfToken: false, // SAP AI Core doesn't support CSRF tokens
          }
        );
      }
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

