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
import type { BaseAbapConnection } from '@fr0ster/mcp-abap-adt/lib/connection/BaseAbapConnection';
import type { SapConfig } from '@fr0ster/mcp-abap-adt/lib/sapConfig';
import {
  BtpOnPremDestinationConnection,
  shouldUseConnectivity,
  extractConnectivityContext,
  createBtpOnPremConnection,
  refreshBtpOnPremConnection,
  clearConnectivityCaches
} from './connections';

// Import MCP server class
// @ts-ignore - no types in mcp-abap-adt
import { mcp_abap_adt_server } from '@fr0ster/mcp-abap-adt';

type AbapConnection = BaseAbapConnection;

// Cache of MCP server instances by SAP URL
interface CachedInstance {
  server: any;
  created: number;
  connection?: AbapConnection;
  transport?: StreamableHTTPServerTransport;
}

const instanceCache = new Map<string, CachedInstance>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Extract SAP configuration from request headers
 */
function extractSapConfig(req: Request): SapConfig {
  const log = cds.log('mcp-manager');
  
  const sapUrl = req.headers['x-sap-url'] as string;
  const sapAuthType = (req.headers['x-sap-auth-type'] as string) || 'jwt';
  const sapJwtToken = req.headers['x-sap-jwt-token'] as string;
  const sapClient = req.headers['x-sap-client'] as string;
  const sapUsername = req.headers['x-sap-username'] as string;
  const sapPassword = req.headers['x-sap-password'] as string;

  if (!sapUrl) {
    throw new Error('Missing X-SAP-URL header');
  }

  const config: SapConfig = {
    url: sapUrl,
    authType: (sapAuthType === 'xsuaa' ? 'jwt' : sapAuthType) as SapConfig['authType']
  };

  if (sapClient) {
    config.client = sapClient;
  }

  if (sapAuthType === 'basic') {
    if (!sapUsername || !sapPassword) {
      throw new Error('Basic auth requires X-SAP-USERNAME and X-SAP-PASSWORD headers');
    }
    config.username = sapUsername;
    config.password = sapPassword;
  } else if (sapAuthType === 'jwt' || sapAuthType === 'xsuaa') {
    if (!sapJwtToken) {
      throw new Error('JWT auth requires X-SAP-JWT-TOKEN header');
    }
    config.jwtToken = sapJwtToken;
  }

  // Log config with token preview
  const tokenPreview = config.jwtToken 
    ? `${config.jwtToken.substring(0, 20)}...${config.jwtToken.substring(config.jwtToken.length - 20)}`
    : 'none';
  
  log.info('SAP config extracted from headers', { 
    url: config.url, 
    authType: config.authType,
    client: config.client || 'none',
    tokenPreview,
    tokenLength: config.jwtToken?.length || 0
  });

  return config;
}

/**
 * Get cache key for MCP instance
 */
function getCacheKey(sapConfig: SapConfig): string {
  return `${sapConfig.url}:${sapConfig.authType}`;
}

/**
 * Clean expired instances from cache
 */
function cleanCache(): void {
  const now = Date.now();
  for (const [key, value] of instanceCache.entries()) {
    if (now - value.created > CACHE_TTL) {
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
    const sapConfig = extractSapConfig(req);
    const cacheKey = getCacheKey(sapConfig);
    const useConnectivity = shouldUseConnectivity(req);
    const connectivityContext = extractConnectivityContext(req);

    // Clean old instances periodically
    cleanCache();

    // Check cache
    const cached = instanceCache.get(cacheKey);
    if (cached) {
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

    log.info('Creating new MCP server instance', { 
      sapUrl: sapConfig.url, 
      authType: sapConfig.authType 
    });

    let connection: BtpOnPremDestinationConnection | undefined;
    if (useConnectivity) {
      if (sapConfig.authType !== 'basic') {
        throw new Error('On-premise connectivity requires basic authentication (username/password).');
      }
      connection = await createBtpOnPremConnection(sapConfig, connectivityContext);
    }
    
    // ВАЖЛИВО: Очищаємо env перед створенням інстансу
    // Субмодуль може все ще мати cached config з .env файлу
    // Тому ми явно передаємо sapConfig через options
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
      connection
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
    log.error('Failed to create MCP server instance', err);
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
}

// Cleanup cache on shutdown
process.on('SIGTERM', clearCache);
process.on('SIGINT', clearCache);
