// Import env setup FIRST to ensure MCP_SKIP_ENV_LOAD is set before submodule imports
import './env-setup';

import cds from '@sap/cds';
// @ts-ignore - ESM import path with .js extension
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import type { SapConfig, AbapConnection } from '@mcp-abap-adt/connection';
import { validateAuthHeaders } from '@mcp-abap-adt/header-validator';
import {
  shouldUseConnectivity,
  extractConnectivityContext,
  clearConnectivityCaches,
} from './connections';
import {
  resolveDestinationSapConfig,
  type DestinationResolution,
  clearDestinationServiceCache,
} from './connections/destinationResolver';
import { createConnection } from './connections/connectionFactory';

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
      length,
    };
  }
  return {
    preview: `${token.substring(0, 20)}...${token.substring(length - 20)}`,
    length,
  };
}

/**
 * Extract SAP configuration from HTTP request headers
 *
 * This function centralizes SAP config extraction logic and uses:
 * - validateAuthHeaders() from @mcp-abap-adt/header-validator for direct connections
 * - resolveDestinationSapConfig() for BTP Destination connections
 *
 * This eliminates code duplication and ensures consistent config extraction
 * across cloud-llm-hub (used by both getMCPServer and handleStreamHTTP).
 *
 * @param req - HTTP request with SAP configuration in headers
 * @returns SAP context with config, source, and optional destination info
 */
export async function extractSapContext(req: Request): Promise<SapContext> {
  const log = cds.log('mcp-manager');
  const destinationName = (req.headers[DESTINATION_HEADER] as string | undefined)?.trim();
  const sapClientHeader = (req.headers['x-sap-client'] as string | undefined)?.trim();

  // Priority 1: BTP Destination (cloud-llm-hub specific)
  // This is NOT covered by validateAuthHeaders because it requires BTP Destination Service
  if (destinationName) {
    // Extract JWT from Authorization header if available
    // Note: JWT is only used for Principal Propagation destinations (OAuth2SAMLBearerAssertion)
    // For BasicAuthentication and OAuth2ClientCredentials, destination has its own credentials
    const authHeader = req.headers.authorization;
    const jwtToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
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
      tokenLength: length,
    });

    return {
      sapConfig,
      source: 'destination',
      destination: resolved,
      cacheExpiresAt: resolved.tokenExpiresAt,
    };
  }

  // Priority 2: Direct connection (Basic/JWT) - use validateAuthHeaders
  // This centralizes header validation logic from mcp-abap-adt
  const validationResult = validateAuthHeaders(req.headers);

  // Log validation warnings
  if (validationResult.warnings.length > 0) {
    log.debug('Header validation warnings', {
      warnings: validationResult.warnings,
    });
  }

  // Check validation errors
  if (!validationResult.isValid || !validationResult.config) {
    const errorMessages = validationResult.errors.join('; ');
    log.error('Header validation failed', {
      errors: validationResult.errors,
      availableHeaders: Object.keys(req.headers).filter((h) => h.toLowerCase().includes('sap')),
    });
    throw new Error(`Invalid authentication headers: ${errorMessages}`);
  }

  // Extract config from validation result
  const config = validationResult.config;

  // Build SapConfig from validated headers
  const sapConfig: SapConfig = {
    url: config.sapUrl || '',
    authType: (config.authType === 'xsuaa' ? 'jwt' : config.authType) as SapConfig['authType'],
  };

  // Add client if provided
  if (sapClientHeader) {
    sapConfig.client = sapClientHeader;
  } else if (config.sapClient) {
    sapConfig.client = config.sapClient;
  }

  // Add credentials based on auth type
  if (config.authType === 'basic') {
    if (!config.username || !config.password) {
      throw new Error('Basic auth requires username and password');
    }
    sapConfig.username = config.username;
    sapConfig.password = config.password;
  } else if (config.authType === 'jwt' || config.authType === 'xsuaa') {
    if (!config.jwtToken) {
      throw new Error('JWT auth requires JWT token');
    }
    sapConfig.jwtToken = config.jwtToken;

    // NOTE: cloud-llm-hub does NOT support token refresh
    // Clients must refresh tokens themselves and send new JWT token in each request
    // For BTP Destinations, token management is automatic via BTP
  }

  const { preview, length } = summarizeJwt(sapConfig.jwtToken);
  log.info('SAP config extracted from headers (via validateAuthHeaders)', {
    url: sapConfig.url,
    authType: sapConfig.authType,
    client: sapConfig.client || 'none',
    tokenPreview: preview,
    tokenLength: length,
  });

  return {
    sapConfig,
    source: 'headers',
  };
}

/**
 * Get cache key for MCP instance
 */
function getCacheKey(sapConfig: SapConfig, destinationName?: string): string {
  // Normalize client: use empty string instead of undefined to ensure consistent cache keys
  // This prevents different cache keys when client header is sometimes present and sometimes not
  const normalizedClient = sapConfig.client || '';
  const clientSegment = normalizedClient ? `:client=${normalizedClient}` : '';
  const userSegment =
    sapConfig.authType === 'basic' && sapConfig.username ? `:user=${sapConfig.username}` : '';
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
        reason: tokenExpired ? 'tokenExpired' : 'ttlExpired',
      });

      if (value.transport) {
        void value.transport.close().catch((err: Error) => {
          cds.log('mcp-manager').warn('Failed to close MCP transport during cache cleanup', {
            cacheKey: key,
            error: err.message,
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
 *
 * ## Hybrid Architecture: instanceCache + sessionContext
 *
 * This function implements a **hybrid caching approach** that combines:
 *
 * 1. **instanceCache** (cloud-llm-hub): Caches MCP server instances and connections
 *    - Key: Based on SAP config + destination name
 *    - Value: CachedInstance (server, connection, transport, expiry)
 *    - Purpose: Reuse MCP server instances across requests with same config
 *    - Lifecycle: Managed by cloud-llm-hub, cleaned up on token expiry
 *
 * 2. **sessionContext** (mcp-abap-adt): Passes SAP config per-request via AsyncLocalStorage
 *    - Set in: `srv/server.ts` via `sessionContext.run()`
 *    - Used by: `getManagedConnection()` from mcp-abap-adt
 *    - Purpose: Per-request SAP config (JWT tokens, credentials) without global state
 *    - Lifecycle: Request-scoped, automatically cleaned up after request
 *
 * ### How It Works:
 *
 * **For Destination-based connections:**
 * - `instanceCache` caches `CloudSdkAbapConnection` + MCP server
 * - Connection is created here and passed to MCP server constructor
 * - `sessionContext` is NOT used (connection is pre-created)
 *
 * **For Direct Basic/JWT connections:**
 * - `instanceCache` caches MCP server instance (NO connection passed)
 * - Connection is created by mcp-abap-adt via `getManagedConnection()`
 * - `getManagedConnection()` reads SAP config from `sessionContext` (set in server.ts)
 * - This allows per-request JWT tokens without global connection state
 *
 * ### Why This Design?
 *
 * - **Separation of concerns**: MCP server lifecycle (instanceCache) vs per-request config (sessionContext)
 * - **Flexibility**: Support both destination-based (pre-created) and direct (per-request) connections
 * - **Performance**: Reuse MCP server instances while allowing per-request authentication
 * - **No global state pollution**: Per-request config doesn't leak between requests
 *
 * @param req - HTTP request with SAP configuration in headers
 * @returns MCP server instance and transport handler
 */
export async function getMCPServer(req: Request): Promise<{
  server: any;
  withTransport: <T>(
    handler: (transport: StreamableHTTPServerTransport) => Promise<T>
  ) => Promise<T>;
}> {
  const log = cds.log('mcp-manager');

  try {
    const sapContext = await extractSapContext(req);
    const { sapConfig, destination, cacheExpiresAt } = sapContext;

    const cacheKey = getCacheKey(sapConfig, destination?.destinationName);
    const connectivityFromHeader = shouldUseConnectivity(req);
    const destinationRequiresConnectivity =
      (destination?.proxyType ?? '').toLowerCase() === 'onpremise';
    const useConnectivity = connectivityFromHeader || destinationRequiresConnectivity;
    const connectivityContext = extractConnectivityContext(req);

    if (!connectivityContext.locationId && destination?.cloudConnectorLocationId) {
      connectivityContext.locationId = destination.cloudConnectorLocationId;
    }

    // Clean old instances periodically
    cleanCache();

    /**
     * HYBRID ARCHITECTURE: Check instanceCache
     *
     * instanceCache stores MCP server instances + connections for reuse.
     * This is the "hub-level" cache that works alongside sessionContext.
     *
     * Cache key includes:
     * - SAP URL
     * - Auth type
     * - Destination name (if applicable)
     * - Client (if applicable)
     *
     * This allows reusing MCP server instances across requests with same config,
     * while sessionContext provides per-request authentication details.
     */
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
              error: err instanceof Error ? err.message : String(err),
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
          withTransport: async <T>(
            handler: (transport: StreamableHTTPServerTransport) => Promise<T>
          ): Promise<T> => {
            return handleWithTransport(cacheKey, cached, req, handler);
          },
        };
      }
    }

    log.info('Creating new MCP server instance', {
      sapUrl: sapConfig.url,
      authType: sapConfig.authType,
      destination: destination?.destinationName ?? 'none',
      useConnectivity,
    });

    let connection: AbapConnection | undefined;

    /**
     * PHASE 2.4: Use Connection Factory Pattern
     *
     * For destination-based connections, use factory to create CloudSdkAbapConnection.
     * For direct Basic/JWT connections, don't create connection here - let mcp-abap-adt
     * create it via getManagedConnection() from session context.
     */
    if (destination?.destinationName) {
      log.debug('Using Connection Factory for destination-based connection', {
        destinationName: destination.destinationName,
        proxyType: destination.proxyType,
        useConnectivity,
      });
      // Use factory to create CloudSdkAbapConnection
      // Factory handles all connection type selection logic
      connection = createConnection({
        sapConfig,
        destinationName: destination.destinationName,
      });
    } else {
      // For basic/jwt (not destination), don't create connection here
      // Let mcp-abap-adt create connection via getManagedConnection() from session context
      // This ensures connection is created with the same config that's in session context
      log.debug(
        'For basic/jwt auth, connection will be created by mcp-abap-adt from session context',
        {
          authType: sapConfig.authType,
          hasJwtToken: !!sapConfig.jwtToken,
          hasUsername: !!sapConfig.username,
          source: sapContext.source,
        }
      );
      // Don't create connection here - mcp-abap-adt will create it via getManagedConnection()
      // when session context is set in handleStreamHTTP
    }

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
      SAP_PASSWORD: process.env.SAP_PASSWORD,
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
      registerSignalHandlers: false,
    };

    if (connection) {
      // For destination-based connections, pass connection directly
      log.info('Using pre-created connection (destination-based)', {
        connectionType: connection.constructor.name,
        destinationName: destination?.destinationName,
        authType: sapConfig.authType,
      });
      serverOptions.connection = connection;
    } else {
      /**
       * HYBRID ARCHITECTURE: Direct Basic/JWT connections
       *
       * For non-destination connections (Basic/JWT auth), we use a different approach:
       *
       * 1. **DO NOT create connection here** - let mcp-abap-adt create it
       * 2. **DO NOT pass sapConfig to MCP server constructor** - this would create global overrideConnection
       * 3. **Rely on sessionContext** - set in server.ts, read by getManagedConnection()
       *
       * Flow:
       * - server.ts: Extracts SAP config from headers → sets sessionContext.run({ sapConfig })
       * - mcp-abap-adt: getManagedConnection() reads from sessionContext → creates connection
       * - This allows per-request JWT tokens without global connection state
       *
       * Why not pass sapConfig to constructor?
       * - If we pass sapConfig, mcp-abap-adt creates global overrideConnection
       * - Global overrideConnection IGNORES sessionContext (early return in getManagedConnection)
       * - This breaks per-request authentication (all requests use same token)
       *
       * Why use sessionContext?
       * - Request-scoped: Each HTTP request gets its own SAP config
       * - No global state: Config doesn't leak between requests
       * - Automatic cleanup: AsyncLocalStorage cleans up after request
       * - Compatible with mcp-abap-adt: Uses standard getManagedConnection() pattern
       *
       * NOTE: cloud-llm-hub does NOT support token refresh
       * Clients must refresh tokens themselves and send new JWT token in each request
       */
      log.info('Using session context for connection (NO sapConfig override)', {
        url: sapConfig.url,
        authType: sapConfig.authType,
        hasJwtToken: !!sapConfig.jwtToken,
        jwtTokenLength: sapConfig.jwtToken?.length || 0,
        jwtTokenPreview: sapConfig.jwtToken
          ? `${sapConfig.jwtToken.substring(0, 20)}...${sapConfig.jwtToken.substring(sapConfig.jwtToken.length - 20)}`
          : 'none',
        hasClient: !!sapConfig.client,
        client: sapConfig.client || 'NOT SET - requests may fail if SAP system requires client',
        clientWarning: !sapConfig.client
          ? '⚠️ Client not set - CDS views and other objects may not be found'
          : undefined,
        cacheKey: getCacheKey(sapConfig),
        source: sapContext.source,
        note: '⚠️ sapConfig NOT passed to constructor - will use session context from AsyncLocalStorage',
      });

      // Verify JWT token is present for JWT auth
      if (sapConfig.authType === 'jwt' && !sapConfig.jwtToken) {
        log.error('CRITICAL: JWT auth type but no JWT token in sapConfig!', {
          authType: sapConfig.authType,
          hasJwtToken: !!sapConfig.jwtToken,
          sapConfigKeys: Object.keys(sapConfig),
        });
        throw new Error('JWT authentication requires JWT token in sapConfig');
      }

      // DO NOT set serverOptions.sapConfig here!
      // Connection will be created from session context in each HTTP request
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
      destinationName: destination?.destinationName,
    };

    // Cache instance
    instanceCache.set(cacheKey, instance);

    log.info('MCP server instance created and cached', { cacheKey });

    return {
      server: instance.server,
      withTransport: async <T>(
        handler: (transport: StreamableHTTPServerTransport) => Promise<T>
      ): Promise<T> => {
        return handleWithTransport(cacheKey, instance, req, handler);
      },
    };
  } catch (err: any) {
    // Use synchronized error handling from errorUtils
    const { logErrorSafely } = await import('./lib/errorUtils');

    // Build context - sapContext might not be available if error occurred before extraction
    const context: Record<string, any> = {
      destination: (req.headers[DESTINATION_HEADER] as string) || undefined,
    };

    // Try to get cache key if sapContext was extracted
    try {
      const sapContext = await extractSapContext(req);
      context.cacheKey = getCacheKey(sapContext.sapConfig, sapContext.destination?.destinationName);
    } catch {
      // Ignore - sapContext extraction might have failed
    }

    logErrorSafely(log, 'MCP server instance creation', err, context);

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
        log.warn('Failed to close existing MCP transport during reset', {
          cacheKey,
          error: err.message,
        });
      }
      entry.transport = undefined;
    }

    // Verify server is ready
    if (!entry.server || !entry.server.server) {
      log.error('MCP server instance is not ready', {
        cacheKey,
        hasServer: !!entry.server,
        hasServerServer: !!entry.server?.server,
      });
      throw new Error('MCP server instance is not initialized');
    }

    log.info('Creating new MCP transport', {
      cacheKey,
      isInitializationRequest,
      hasSessionId: !!requestSessionIdHeader,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode (like mcp-abap-adt)
      enableJsonResponse: true, // Use JSON response format, not SSE
      allowedOrigins: undefined,
      allowedHosts: undefined,
      enableDnsRebindingProtection: false,
    });

    try {
      log.debug('Connecting transport to MCP server', { cacheKey });
      await entry.server.server.connect(transport);
      log.info('Transport connected to MCP server successfully', { cacheKey });

      // In hybrid debug mode, add a small delay to ensure transport is fully ready
      // The debugger can sometimes cause timing issues with async initialization
      const isDebugMode =
        process.env.NODE_OPTIONS?.includes('--inspect') ||
        process.env.NODE_OPTIONS?.includes('--inspect-brk');
      if (isDebugMode) {
        log.debug('Waiting for transport to be fully ready (debug mode)', { cacheKey });
        // Small delay to allow any internal async initialization to complete
        await new Promise((resolve) => setImmediate(resolve));
        log.debug('Transport ready check complete', { cacheKey });
      }
    } catch (connectError: any) {
      log.error('Failed to connect transport to MCP server', {
        cacheKey,
        error: connectError instanceof Error ? connectError.message : String(connectError),
        stack: connectError instanceof Error ? connectError.stack : undefined,
      });
      throw new Error(
        `MCP transport connection failed: ${connectError instanceof Error ? connectError.message : String(connectError)}`
      );
    }

    entry.transport = transport;
    log.debug('Transport cached and ready', { cacheKey });
  } else {
    log.debug('Reusing existing MCP transport', {
      cacheKey,
      hasSessionId: !!requestSessionIdHeader,
    });
  }

  if (!entry.transport) {
    log.error('MCP transport is not available after initialization', { cacheKey });
    throw new Error('MCP transport failed to initialize');
  }

  return handler(entry.transport);
}

/**
 * Clear all cached MCP instances and connections
 *
 * This function:
 * - Closes all active MCP transports
 * - Resets all cached connections
 * - Clears connectivity and destination service caches
 *
 * Useful for:
 * - Graceful shutdown (SIGTERM/SIGINT handlers)
 * - Testing (reset state between tests)
 * - Memory management (periodic cleanup)
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
