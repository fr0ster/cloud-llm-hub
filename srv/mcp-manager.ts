/**
 * MCP Manager - Embedded MCP server instance
 * Runs mcp-abap-adt directly in the CAP process
 * Creates per-request instances with SAP config from headers
 */

import cds from '@sap/cds';
// @ts-ignore - ESM import path with .js extension
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import type { BaseAbapConnection } from '@fr0ster/mcp-abap-adt/dist/lib/connection/BaseAbapConnection';
import type { SapConfig } from '@fr0ster/mcp-abap-adt/dist/lib/sapConfig';
import {
  BtpOnPremDestinationConnection,
  shouldUseConnectivity,
  extractConnectivityContext,
  createBtpOnPremConnection,
  refreshBtpOnPremConnection,
  clearConnectivityCaches
} from './connections';
import {
  resolveDestinationSapConfig,
  type DestinationResolution,
  clearDestinationServiceCache
} from './connections/destinationResolver';

// Import MCP server class
// @ts-ignore - no types in mcp-abap-adt
import { mcp_abap_adt_server } from '@fr0ster/mcp-abap-adt';

type AbapConnection = BaseAbapConnection;

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
    // Extract JWT from Authorization header if available (for principal propagation)
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
        if (useConnectivity && cached.connection instanceof BtpOnPremDestinationConnection) {
          await refreshBtpOnPremConnection(cached.connection as BtpOnPremDestinationConnection, connectivityContext);
        }
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

    let connection: BtpOnPremDestinationConnection | undefined;
    if (useConnectivity) {
      if (sapConfig.authType !== 'basic') {
        throw new Error('On-premise connectivity requires basic authentication (username/password).');
      }
      connection = await createBtpOnPremConnection(sapConfig, connectivityContext);
    }
    
  // IMPORTANT: clear env vars before instantiating the submodule server
  // The submodule may still read cached configuration from its .env file,
  // so we always pass the explicit sapConfig via options instead
    const oldEnv = {
      SAP_URL: process.env.SAP_URL,
      SAP_CLIENT: process.env.SAP_CLIENT,
      SAP_AUTH_TYPE: process.env.SAP_AUTH_TYPE,
      SAP_JWT_TOKEN: process.env.SAP_JWT_TOKEN,
      SAP_USERNAME: process.env.SAP_USERNAME,
      SAP_PASSWORD: process.env.SAP_PASSWORD
    };
    
    // Clear env vars to prevent submodule from using them
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

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false,
      allowedOrigins: undefined,
      allowedHosts: undefined,
      enableDnsRebindingProtection: false
    });

    await entry.server.server.connect(transport);
    entry.transport = transport;
  }

  if (!entry.transport) {
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
