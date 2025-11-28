/**
 * MCP Manager - Embedded MCP server instance
 * Runs mcp-abap-adt directly in the CAP process
 * Creates per-request instances with SAP config from headers
 */

// Import env setup FIRST to ensure MCP_SKIP_ENV_LOAD is set before submodule imports
import './env-setup';

import cds from '@sap/cds';
// @ts-ignore - ESM import path with .js extension
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import type { SapConfig, AbapConnection } from '@mcp-abap-adt/connection';
import {
  shouldUseConnectivity,
  extractConnectivityContext,
  clearConnectivityCaches
} from './connections';
import {
  resolveDestinationSapConfig,
  type DestinationResolution,
  clearDestinationServiceCache
} from './connections/destinationResolver';
import { CloudSdkAbapConnection } from './connections/CloudSdkAbapConnection';

// MCP server class will be imported dynamically to avoid executing top-level code
// The submodule's index.ts has top-level code that loads .env file, which we want to skip
// We'll use dynamic import when we actually need to create a server instance

// Cache of MCP server instances by SAP URL or destination
interface CachedInstance {
  server: any;
  created: number;
  connection?: AbapConnection;
  transport?: StreamableHTTPServerTransport;
  expiresAt?: number;
  destinationName?: string;
}

interface SapContext {
  sapConfig: SapConfig;
  source: 'headers' | 'destination';
  destination?: DestinationResolution;
  cacheExpiresAt?: number;
}

const instanceCache = new Map<string, CachedInstance>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const DESTINATION_HEADER = 'x-sap-destination';

function summarizeJwt(token?: string): { preview: string; length: number } {
  if (!token) {
    return { preview: 'none', length: 0 };
  }
  const length = token.length;
  if (length <= 40) {
    return {
      preview: `${token.substring(0, Math.min(20, length))}...`,
      length
    };
  }
  return {
    preview: `${token.substring(0, 20)}...${token.substring(length - 20)}`,
    length
  };
}

function normalizeAuthType(rawAuthType: string | undefined): SapConfig['authType'] {
  const normalized = (rawAuthType ?? 'jwt').toLowerCase();
  return (normalized === 'xsuaa' ? 'jwt' : normalized) as SapConfig['authType'];
}

async function extractSapContext(req: Request): Promise<SapContext> {
  const log = cds.log('mcp-manager');
  const destinationName = (req.headers[DESTINATION_HEADER] as string | undefined)?.trim();
  const sapClientHeader = (req.headers['x-sap-client'] as string | undefined)?.trim();

  if (destinationName) {
    // Extract JWT from Authorization header if available
    // Note: JWT is only used for Principal Propagation destinations (OAuth2SAMLBearerAssertion)
    // For BasicAuthentication and OAuth2ClientCredentials, destination has its own credentials
    const authHeader = req.headers.authorization;
    const jwtToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : undefined;
    
    const resolved = await resolveDestinationSapConfig(destinationName, jwtToken);
    const sapConfig: SapConfig = { ...resolved.sapConfig };

    if (sapClientHeader) {
      sapConfig.client = sapClientHeader;
    }

    const { preview, length } = summarizeJwt(sapConfig.jwtToken);
    log.info('SAP config resolved from destination', {
      destination: resolved.destinationName,
      proxyType: resolved.proxyType ?? 'Internet',
      authType: sapConfig.authType,
      client: sapConfig.client || 'none',
      tokenPreview: preview,
      tokenLength: length
    });

    return {
      sapConfig,
      source: 'destination',
      destination: resolved,
      cacheExpiresAt: resolved.tokenExpiresAt
    };
  }

  const sapUrl = (req.headers['x-sap-url'] as string | undefined)?.trim();
  const sapAuthTypeRaw = (req.headers['x-sap-auth-type'] as string | undefined)?.trim();
  const sapJwtToken = (req.headers['x-sap-jwt-token'] as string | undefined)?.trim();
  const sapUsername = (req.headers['x-sap-username'] as string | undefined)?.trim();
  const sapPassword = (req.headers['x-sap-password'] as string | undefined)?.trim();

  if (!sapUrl) {
    throw new Error('Missing X-SAP-URL header');
  }

  const authType = normalizeAuthType(sapAuthTypeRaw);
  const sapConfig: SapConfig = {
    url: sapUrl,
    authType
  };

  if (sapClientHeader) {
    sapConfig.client = sapClientHeader;
  }

  if (authType === 'basic') {
    if (!sapUsername || !sapPassword) {
      throw new Error('Basic auth requires X-SAP-USERNAME and X-SAP-PASSWORD headers');
    }
    sapConfig.username = sapUsername;
    sapConfig.password = sapPassword;
  } else {
    if (!sapJwtToken) {
      throw new Error('JWT auth requires X-SAP-JWT-TOKEN header');
    }
    sapConfig.jwtToken = sapJwtToken;
  }

  const { preview, length } = summarizeJwt(sapConfig.jwtToken);
  log.info('SAP config extracted from headers', {
    url: sapConfig.url,
    authType: sapConfig.authType,
    client: sapConfig.client || 'none',
    tokenPreview: preview,
    tokenLength: length
  });

  return {
    sapConfig,
    source: 'headers'
  };
}

/**
 * Get cache key for MCP instance
 */
function getCacheKey(sapConfig: SapConfig, destinationName?: string): string {
  const clientSegment = sapConfig.client ? `:client=${sapConfig.client}` : '';
  const userSegment = sapConfig.authType === 'basic' && sapConfig.username ? `:user=${sapConfig.username}` : '';
  if (destinationName) {
    return `destination:${destinationName}:${sapConfig.authType}${clientSegment}${userSegment}`;
  }
  return `${sapConfig.url}:${sapConfig.authType}${clientSegment}${userSegment}`;
}

/**
 * Clean expired instances from cache
 */
function cleanCache(): void {
  const now = Date.now();
  for (const [key, value] of instanceCache.entries()) {
    const ttlExpired = now - value.created > CACHE_TTL;
    const tokenExpired = typeof value.expiresAt === 'number' && value.expiresAt <= now;

    if (ttlExpired || tokenExpired) {
      cds.log('mcp-manager').debug('Removing cached MCP instance', {
        cacheKey: key,
        reason: tokenExpired ? 'tokenExpired' : 'ttlExpired'
      });

      if (value.transport) {
        void value.transport.close().catch((err: Error) => {
          cds.log('mcp-manager').warn('Failed to close MCP transport during cache cleanup', {
            cacheKey: key,
            error: err.message
          });
        });
        value.transport = undefined;
      }
      value.connection?.reset();
      instanceCache.delete(key);
    }
  }
}

/**
 * Get or create MCP server instance with transport for given SAP config
 */
export async function getMCPServer(req: Request): Promise<{
  server: any;
  withTransport: <T>(handler: (transport: StreamableHTTPServerTransport) => Promise<T>) => Promise<T>;
}> {
  const log = cds.log('mcp-manager');

  try {
    const sapContext = await extractSapContext(req);
    const { sapConfig, destination, cacheExpiresAt } = sapContext;

    const cacheKey = getCacheKey(sapConfig, destination?.destinationName);
    const connectivityFromHeader = shouldUseConnectivity(req);
    const destinationRequiresConnectivity = (destination?.proxyType ?? '').toLowerCase() === 'onpremise';
    const useConnectivity = connectivityFromHeader || destinationRequiresConnectivity;
    const connectivityContext = extractConnectivityContext(req);

    if (!connectivityContext.locationId && destination?.cloudConnectorLocationId) {
      connectivityContext.locationId = destination.cloudConnectorLocationId;
    }

    // Clean old instances periodically
    cleanCache();

    // Check cache
    const cached = instanceCache.get(cacheKey);
    if (cached) {
      const now = Date.now();
      if (cached.expiresAt && cached.expiresAt <= now) {
        log.debug('Discarding cached MCP instance due to token expiry', { cacheKey });
        if (cached.transport) {
          try {
            await cached.transport.close();
          } catch (err: any) {
            log.warn('Failed to close MCP transport during token expiry cleanup', {
              cacheKey,
              error: err instanceof Error ? err.message : String(err)
            });
          }
          cached.transport = undefined;
        }
        cached.connection?.reset();
        instanceCache.delete(cacheKey);
      } else {
        // If connection is from mcp-abap-adt, it manages its own lifecycle
        // No need to refresh for standard connections
        log.debug('Using cached MCP instance', { cacheKey });
        return {
          server: cached.server,
          withTransport: async <T>(handler: (transport: StreamableHTTPServerTransport) => Promise<T>): Promise<T> => {
            return handleWithTransport(cacheKey, cached, req, handler);
          }
        };
      }
    }

    log.info('Creating new MCP server instance', {
      sapUrl: sapConfig.url,
      authType: sapConfig.authType,
      destination: destination?.destinationName ?? 'none',
      useConnectivity
    });

    let connection: AbapConnection | undefined;
    
    // Use Cloud SDK connection if destination name is available
    // executeHttpRequest automatically handles both internet and on-premise destinations
    // including Cloud Connector proxy configuration
    if (destination?.destinationName) {
      log.debug('Using Cloud SDK AbapConnection for destination', {
        destinationName: destination.destinationName,
        proxyType: destination.proxyType,
        useConnectivity
      });
      // CloudSdkAbapConnection uses executeHttpRequest which automatically handles:
      // - Internet destinations
      // - On-premise destinations via Cloud Connector (if ProxyType=OnPremise in destination)
      // - All authentication types (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
      connection = new CloudSdkAbapConnection(sapConfig, destination.destinationName);
    }
    // If destination is not used, mcp-abap-adt will create connection using its standard classes
    // (OnPremAbapConnection or CloudAbapConnection) based on sapConfig
    
  // IMPORTANT: Clear env vars before instantiating the submodule server
  // cloud-llm-hub always passes SAP configuration via headers -> extractSapContext -> serverOptions.sapConfig
  // We must prevent the submodule from reading any .env files or cached env vars
  // The submodule should ONLY use the explicit sapConfig passed in serverOptions
    const oldEnv = {
      SAP_URL: process.env.SAP_URL,
      SAP_CLIENT: process.env.SAP_CLIENT,
      SAP_AUTH_TYPE: process.env.SAP_AUTH_TYPE,
      SAP_JWT_TOKEN: process.env.SAP_JWT_TOKEN,
      SAP_USERNAME: process.env.SAP_USERNAME,
      SAP_PASSWORD: process.env.SAP_PASSWORD
    };
    
    // Clear env vars to prevent submodule from using them
    // All configuration comes from HTTP headers, not from .env files
    delete process.env.SAP_URL;
    delete process.env.SAP_CLIENT;
    delete process.env.SAP_AUTH_TYPE;
    delete process.env.SAP_JWT_TOKEN;
    delete process.env.SAP_USERNAME;
    delete process.env.SAP_PASSWORD;
    
    // Create MCP server instance with SAP config
    const serverOptions: {
      sapConfig?: SapConfig;
      connection?: AbapConnection;
      allowProcessExit: boolean;
      registerSignalHandlers: boolean;
    } = {
      allowProcessExit: false,
      registerSignalHandlers: false
    };

    if (connection) {
      serverOptions.connection = connection;
    } else {
      serverOptions.sapConfig = sapConfig;
    }

    // Dynamic import to avoid executing top-level code in submodule's index.ts
    // By this point, MCP_SKIP_ENV_LOAD is already set, so .env loading will be skipped
    const { mcp_abap_adt_server } = await import('@fr0ster/mcp-abap-adt');
    const mcpServerInstance = new mcp_abap_adt_server(serverOptions);
    
    // Restore env vars (for other code that might need them)
    Object.assign(process.env, oldEnv);
    
    const instance: CachedInstance = {
      server: mcpServerInstance,
      created: Date.now(),
      connection,
      expiresAt: cacheExpiresAt,
      destinationName: destination?.destinationName
    };
    
    // Cache instance
    instanceCache.set(cacheKey, instance);
    
    log.info('MCP server instance created and cached', { cacheKey });
    
    return {
      server: instance.server,
      withTransport: async <T>(handler: (transport: StreamableHTTPServerTransport) => Promise<T>): Promise<T> => {
        return handleWithTransport(cacheKey, instance, req, handler);
      }
    };
  } catch (err: any) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    const errorDetails = {
      error: errorMessage,
      name: err?.name,
      code: err?.code,
      stack: errorStack,
      destination: (req.headers[DESTINATION_HEADER] as string) || undefined
    };
    
    log.error('Failed to create MCP server instance', errorDetails);
    
    // Ensure error has proper properties for downstream handling
    if (err instanceof Error) {
      (err as any).statusCode = (err as any).statusCode || 502;
      (err as any).code = (err as any).code || err?.name || 'MCP_SERVER_CREATION_FAILED';
    }
    
    throw err;
  }
}

async function handleWithTransport<T>(
  cacheKey: string,
  entry: CachedInstance,
  req: Request,
  handler: (transport: StreamableHTTPServerTransport) => Promise<T>
): Promise<T> {
  const log = cds.log('mcp-manager');

  const requestSessionIdHeader = req.headers['mcp-session-id'];
  const isInitializationRequest = !requestSessionIdHeader;

  if (!entry.transport || isInitializationRequest) {
    if (entry.transport) {
      log.info('Resetting MCP transport before new initialization', { cacheKey });
      try {
        await entry.transport.close();
      } catch (err: any) {
        log.warn('Failed to close existing MCP transport during reset', { cacheKey, error: err.message });
      }
      entry.transport = undefined;
    }

    // Verify server is ready
    if (!entry.server || !entry.server.server) {
      log.error('MCP server instance is not ready', { 
        cacheKey,
        hasServer: !!entry.server,
        hasServerServer: !!entry.server?.server
      });
      throw new Error('MCP server instance is not initialized');
    }

    log.info('Creating new MCP transport', { 
      cacheKey, 
      isInitializationRequest,
      hasSessionId: !!requestSessionIdHeader
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode (like mcp-abap-adt)
      enableJsonResponse: true, // Use JSON response format, not SSE
      allowedOrigins: undefined,
      allowedHosts: undefined,
      enableDnsRebindingProtection: false
    });

    try {
      log.debug('Connecting transport to MCP server', { cacheKey });
      await entry.server.server.connect(transport);
      log.info('Transport connected to MCP server successfully', { cacheKey });
      
      // In hybrid debug mode, add a small delay to ensure transport is fully ready
      // The debugger can sometimes cause timing issues with async initialization
      const isDebugMode = process.env.NODE_OPTIONS?.includes('--inspect') || 
                          process.env.NODE_OPTIONS?.includes('--inspect-brk');
      if (isDebugMode) {
        log.debug('Waiting for transport to be fully ready (debug mode)', { cacheKey });
        // Small delay to allow any internal async initialization to complete
        await new Promise(resolve => setImmediate(resolve));
        log.debug('Transport ready check complete', { cacheKey });
      }
    } catch (connectError: any) {
      log.error('Failed to connect transport to MCP server', {
        cacheKey,
        error: connectError instanceof Error ? connectError.message : String(connectError),
        stack: connectError instanceof Error ? connectError.stack : undefined
      });
      throw new Error(`MCP transport connection failed: ${connectError instanceof Error ? connectError.message : String(connectError)}`);
    }

    entry.transport = transport;
    log.debug('Transport cached and ready', { cacheKey });
  } else {
    log.debug('Reusing existing MCP transport', { 
      cacheKey,
      hasSessionId: !!requestSessionIdHeader
    });
  }

  if (!entry.transport) {
    log.error('MCP transport is not available after initialization', { cacheKey });
    throw new Error('MCP transport failed to initialize');
  }

  return handler(entry.transport);
}

/**
 * Clear all cached MCP instances
 */
export function clearCache(): void {
  const log = cds.log('mcp-manager');
  log.info('Clearing MCP instance cache', { count: instanceCache.size });
  for (const instance of instanceCache.values()) {
    if (instance.transport) {
      void instance.transport.close().catch((err: Error) => {
        log.warn('Failed to close MCP transport during cache clear', { error: err.message });
      });
      instance.transport = undefined;
    }
    instance.connection?.reset();
  }
  instanceCache.clear();
  clearConnectivityCaches();
  clearDestinationServiceCache();
}

// Cleanup cache on shutdown
process.on('SIGTERM', clearCache);
process.on('SIGINT', clearCache);
