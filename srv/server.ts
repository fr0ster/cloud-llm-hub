/**
 * Custom server.ts for CAP bootstrap.
 * This file is automatically loaded by CAP and registers streaming endpoints.
 *
 * CRITICAL: Environment variables must be set BEFORE imports
 * The mcp-abap-adt submodule has auto-start code that runs on import
 *
 * NOTE: cloud-llm-hub always gets SAP configuration from HTTP headers (X-SAP-Destination
 * or X-SAP-URL, X-SAP-JWT-TOKEN, etc.), not from .env files. The .env file is only needed
 * when running mcp-abap-adt standalone (not through cloud-llm-hub).
 */

// Import env setup FIRST to ensure MCP_SKIP_ENV_LOAD is set before any submodule imports
import './env-setup';

import cds from '@sap/cds';
import type { Application, Request, Response, NextFunction } from 'express';
// @ts-ignore - @sap/xsenv doesn't have types
import { loadEnv } from '@sap/xsenv';
// @ts-ignore - ESM import path with .js extension
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getMCPServer, extractSapContext } from './mcp-manager';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import type { SapConfig } from '@mcp-abap-adt/connection';
// sessionContext and getManagedConnection will be obtained from mcp-abap-adt's utils module via dynamic import
// This ensures we use the same instance that getManagedConnection() reads from

/**
 * Stream-HTTP endpoint handler - proxies to embedded MCP server
 *
 * ## Hybrid Architecture: sessionContext Integration
 *
 * This handler implements the **sessionContext** part of the hybrid architecture:
 *
 * 1. **Extract SAP config** from HTTP headers (destination or direct)
 * 2. **Set sessionContext** via `sessionContext.run({ sapConfig })`
 * 3. **Delegate to MCP server** which uses `getManagedConnection()` to read from sessionContext
 *
 * ### Flow for Direct Basic/JWT connections:
 *
 * ```
 * Request → Extract headers → Build sessionSapConfig
 *   ↓
 * sessionContext.run({ sapConfig: sessionSapConfig })
 *   ↓
 * getMCPServer() → Creates MCP server (NO connection passed)
 *   ↓
 * MCP handler calls getManagedConnection()
 *   ↓
 * getManagedConnection() reads from sessionContext → Creates connection
 *   ↓
 * Request processed with per-request authentication
 * ```
 *
 * ### Flow for Destination-based connections:
 *
 * ```
 * Request → Extract headers → Resolve destination
 *   ↓
 * getMCPServer() → Creates CloudSdkAbapConnection → Passes to MCP server
 *   ↓
 * MCP server uses pre-created connection (sessionContext not needed)
 *   ↓
 * Request processed with destination-based authentication
 * ```
 *
 * ### Key Points:
 *
 * - **sessionContext is request-scoped**: Each HTTP request gets its own SAP config
 * - **No global state**: Config doesn't leak between requests
 * - **Automatic cleanup**: AsyncLocalStorage cleans up after request completes
 * - **Compatible with mcp-abap-adt**: Uses standard getManagedConnection() pattern
 *
 * @param req - HTTP request
 * @param res - HTTP response
 */
async function handleStreamHTTP(req: Request, res: Response): Promise<any> {
  const log = cds.log('mcp-proxy/stream-http');
  let body: any = null; // Declare body at function scope for error handling

  // Only handle POST requests (like mcp-abap-adt)
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  try {
    /**
     * PHASE 2.3: Use extractSapContext from mcp-manager.ts
     *
     * This eliminates code duplication by reusing the same extraction logic
     * that getMCPServer() uses. This ensures sessionSapConfig matches exactly
     * what getMCPServer creates, preventing inconsistencies.
     *
     * extractSapContext uses:
     * - validateAuthHeaders() from @mcp-abap-adt/header-validator for direct connections
     * - resolveDestinationSapConfig() for BTP Destination connections
     */
    const sapContext = await extractSapContext(req);
    const sessionSapConfig = sapContext.sapConfig;

    // Generate session ID for this request
    // CRITICAL: Include JWT token hash in sessionId to invalidate cache when token changes
    // This ensures that when token changes, sessionId changes, cache miss, new connection created
    let sessionId = randomUUID().substring(0, 8); // Short random prefix
    if (sessionSapConfig.jwtToken) {
      // Add hash of JWT token to sessionId - when token changes, sessionId changes, cache invalidates
      const crypto = await import('crypto');
      const tokenHash = crypto
        .createHash('sha256')
        .update(sessionSapConfig.jwtToken)
        .digest('hex')
        .substring(0, 8);
      sessionId = `${sessionId}-${tokenHash}`;
    }

    log.info('Extracted SAP config for sessionContext', {
      source: sapContext.source,
      destination: sapContext.destination?.destinationName,
      authType: sessionSapConfig.authType,
      hasJwtToken: !!sessionSapConfig.jwtToken,
      jwtTokenLength: sessionSapConfig.jwtToken?.length || 0,
      hasClient: !!sessionSapConfig.client,
    });

    // Get embedded MCP server instance (created per-request with SAP config from headers)
    const mcpServer = await getMCPServer(req);

    if (!mcpServer || !mcpServer.server) {
      log.error('MCP server not initialized');
      return res.status(503).send('Service Unavailable: MCP server not ready');
    }

    // Read request body (like mcp-abap-adt does)
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    if (chunks.length > 0) {
      const bodyString = Buffer.concat(chunks).toString('utf-8');
      try {
        body = JSON.parse(bodyString);
      } catch (parseError) {
        // If body is not JSON, pass as string or null
        body = bodyString || null;
      }
    }

    // Log request details for debugging (especially for tools/call requests)
    if (body && typeof body === 'object') {
      const method = body.method || body.jsonrpc ? 'JSON-RPC' : 'unknown';
      const toolName = body.params?.name || body.method?.replace('tools/', '') || 'unknown';
      const toolArgs = body.params?.arguments || body.arguments || {};

      log.info('MCP request details', {
        method,
        toolName,
        toolArgs:
          Object.keys(toolArgs).length > 0
            ? {
                // Log key parameters for common tools
                class_name: toolArgs.class_name || toolArgs.className,
                object_name: toolArgs.object_name || toolArgs.objectName,
                table_name: toolArgs.table_name || toolArgs.tableName,
                program_name: toolArgs.program_name || toolArgs.programName,
                // Log all keys for debugging (but not values to avoid sensitive data)
                allKeys: Object.keys(toolArgs),
              }
            : {},
        requestId: body.id || 'no-id',
      });
    }

    // Create new StreamableHTTP transport for each request (like mcp-abap-adt)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode (like mcp-abap-adt)
      enableJsonResponse: true, // Use JSON response format, not SSE
      allowedOrigins: undefined,
      allowedHosts: undefined,
      enableDnsRebindingProtection: false,
    });

    // Close transport when response closes (like mcp-abap-adt)
    res.on('close', () => {
      transport.close();
    });

    // Connect transport to MCP server (like mcp-abap-adt)
    // In mcp-abap-adt: await this.mcpServer.connect(transport);
    // Our mcpServer.server is mcp_abap_adt_server, need to access private mcpServer property
    if (!mcpServer.server) {
      log.error('MCP server instance not available', {
        hasServer: !!mcpServer.server,
      });
      return res.status(503).send('Service Unavailable: MCP server not ready');
    }

    // Access private mcpServer property via type assertion
    // mcpServer.server is mcp_abap_adt_server instance
    // (mcpServer.server as any).mcpServer is the private McpServer instance
    const mcpServerInstance = (mcpServer.server as any).mcpServer;
    if (!mcpServerInstance) {
      log.error('MCP server McpServer instance not available', {
        hasServer: !!mcpServer.server,
        hasMcpServer: !!(mcpServer.server as any).mcpServer,
      });
      return res.status(503).send('Service Unavailable: MCP server structure invalid');
    }

    await mcpServerInstance.connect(transport);

    log.debug('Transport connected', {
      hasServer: !!mcpServer.server,
      sessionId: sessionId.substring(0, 8),
    });

    // Run handlers in AsyncLocalStorage context with session info (like mcp-abap-adt)
    // This allows getManagedConnection() to access sessionId and config
    // We need to use the same sessionContext instance that mcp-abap-adt uses
    // getManagedConnection() reads from sessionContext.getStore(), so we must use the same instance
    let mcpSessionContext: any;
    try {
      // Get sessionContext from mcp-abap-adt's utils module
      // sessionContext is exported from lib/utils.ts but not from main index
      // Use require to access the same instance that mcp-abap-adt uses internally
      // This must be done after mcp-abap-adt is loaded (which happens in getMCPServer above)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mcpUtils = require('@fr0ster/mcp-abap-adt/dist/lib/utils.js');

      if (mcpUtils && mcpUtils.sessionContext) {
        mcpSessionContext = mcpUtils.sessionContext;
        log.debug('Using mcp-abap-adt sessionContext from utils', {
          hasSessionContext: !!mcpSessionContext,
          hasRun: typeof mcpSessionContext?.run === 'function',
        });
      } else {
        // Fallback: try dynamic import
        const mcpUtilsModule = await import('@fr0ster/mcp-abap-adt/dist/lib/utils.js');
        const mcpUtilsAny = mcpUtilsModule as any;
        if (mcpUtilsAny && mcpUtilsAny.sessionContext) {
          mcpSessionContext = mcpUtilsAny.sessionContext;
          log.debug('Using mcp-abap-adt sessionContext from utils (dynamic import)', {
            hasSessionContext: !!mcpSessionContext,
            hasRun: typeof mcpSessionContext?.run === 'function',
          });
        } else {
          throw new Error(
            `sessionContext not found in mcp-abap-adt utils. Available keys: ${Object.keys(
              mcpUtils || mcpUtilsAny || {}
            )
              .slice(0, 20)
              .join(', ')}`
          );
        }
      }

      if (!mcpSessionContext || typeof mcpSessionContext.run !== 'function') {
        throw new Error('sessionContext found but does not have run method');
      }
    } catch (err) {
      log.error('Failed to access mcp-abap-adt sessionContext', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.substring(0, 500) : undefined,
      });
      return res.status(500).send('Internal Server Error: sessionContext not available');
    }

    // Verify sessionSapConfig has JWT token before running
    if (sessionSapConfig && sessionSapConfig.authType === 'jwt' && !sessionSapConfig.jwtToken) {
      log.error('JWT auth type but no token in sessionSapConfig', {
        hasConfig: !!sessionSapConfig,
        authType: sessionSapConfig.authType,
        hasJwtToken: !!sessionSapConfig.jwtToken,
      });
      return res.status(400).send('Bad Request: JWT token required for JWT authentication');
    }

    log.info('Running in sessionContext', {
      sessionId: sessionId.substring(0, 8),
      hasSapConfig: !!sessionSapConfig,
      authType: sessionSapConfig?.authType,
      hasJwtToken: !!sessionSapConfig?.jwtToken,
      jwtTokenLength: sessionSapConfig?.jwtToken?.length || 0,
    });

    // CRITICAL: Log sessionSapConfig BEFORE passing to sessionContext
    log.info('🔥 sessionSapConfig BEFORE sessionContext.run', {
      hasJwtToken: !!sessionSapConfig?.jwtToken,
      jwtTokenLength: sessionSapConfig?.jwtToken?.length || 0,
      allKeys: Object.keys(sessionSapConfig || {}),
    });

    /**
     * HYBRID ARCHITECTURE: Set sessionContext for this request
     *
     * This is the critical part of the hybrid architecture:
     * - sessionContext.run() sets request-scoped SAP config in AsyncLocalStorage
     * - mcp-abap-adt's getManagedConnection() reads from this context
     * - This allows per-request authentication without global connection state
     *
     * For Direct Basic/JWT connections:
     * - getMCPServer() does NOT pass connection to MCP server constructor
     * - MCP handlers call getManagedConnection() which reads from sessionContext
     * - Each request gets its own connection with its own JWT token
     *
     * For Destination-based connections:
     * - getMCPServer() creates CloudSdkAbapConnection and passes it to constructor
     * - sessionContext is still set (for consistency) but not used
     * - Connection is pre-created and reused from instanceCache
     */
    await mcpSessionContext.run(
      {
        sessionId,
        sapConfig: sessionSapConfig,
      },
      async () => {
        // Verify context is set correctly
        const context = mcpSessionContext.getStore();

        // CRITICAL: Log what ACTUALLY got into sessionContext
        log.info('🔥 sapConfig INSIDE sessionContext.run', {
          hasJwtToken: !!context?.sapConfig?.jwtToken,
          jwtTokenLength: context?.sapConfig?.jwtToken?.length || 0,
          allKeys: Object.keys(context?.sapConfig || {}),
        });

        log.info('Inside sessionContext.run - context check', {
          hasContext: !!context,
          hasSessionId: !!context?.sessionId,
          hasSapConfig: !!context?.sapConfig,
          authType: context?.sapConfig?.authType,
          hasJwtToken: !!context?.sapConfig?.jwtToken,
          jwtTokenLength: context?.sapConfig?.jwtToken?.length || 0,
        });

        // NOTE: cloud-llm-hub does NOT support token refresh
        // For BTP Destinations: Token management is automatic via BTP
        // Clients must refresh tokens themselves and send new JWT token in each request

        // Handle HTTP request through transport (like mcp-abap-adt)
        // Pass body as third parameter (like mcp-abap-adt does)
        try {
          await transport.handleRequest(req, res, body);
        } catch (transportError: any) {
          // Enhanced error logging for transport errors
          const errorDetails: any = {
            error_type: transportError?.constructor?.name || 'Unknown',
            error_message: transportError?.message || String(transportError),
            toolName: body?.params?.name || body?.method?.replace('tools/', '') || 'unknown',
            toolArgs: body?.params?.arguments ? Object.keys(body.params.arguments) : [],
          };

          // Extract HTTP error details if available
          if (transportError?.response) {
            errorDetails.http_status = transportError.response.status;
            errorDetails.http_status_text = transportError.response.statusText;
            errorDetails.http_url =
              transportError.config?.url || transportError.response.config?.url;
            errorDetails.http_method =
              transportError.config?.method || transportError.response.config?.method;
          }

          // Extract specific tool arguments for better error context
          if (body?.params?.arguments) {
            const args = body.params.arguments;
            errorDetails.object_name =
              args.class_name ||
              args.className ||
              args.object_name ||
              args.objectName ||
              args.table_name ||
              args.tableName ||
              args.program_name ||
              args.programName ||
              'unknown';
            errorDetails.is_standard_object =
              errorDetails.object_name &&
              (errorDetails.object_name.startsWith('CL_') ||
                errorDetails.object_name.startsWith('IF_') ||
                errorDetails.object_name.startsWith('CX_') ||
                errorDetails.object_name.startsWith('Z') === false);
          }

          log.error('Transport request failed', errorDetails);
          throw transportError;
        }
      }
    );

    log.debug('Request completed', {
      sessionId: sessionId.substring(0, 8),
    });
  } catch (error: any) {
    // Use synchronized error handling from errorUtils
    // In development (cds watch), TypeScript files are executed directly, so use .ts extension
    // In production (compiled), files are .js
    // Try .ts first (development), fallback to .js (production)
    let errorUtils: any;
    let logErrorSafely: any;
    let formatErrorMessage: any;

    try {
      try {
        // @ts-ignore - Dynamic import with .ts extension for development mode
        errorUtils = await import('./lib/errorUtils.ts');
      } catch {
        // @ts-ignore - Dynamic import with .js extension for production mode
        errorUtils = await import('./lib/errorUtils.js');
      }
      logErrorSafely = errorUtils.logErrorSafely;
      formatErrorMessage = errorUtils.formatErrorMessage;
    } catch (importError) {
      // Fallback if errorUtils cannot be imported
      log.error('Failed to import errorUtils, using fallback error handling', {
        error: importError instanceof Error ? importError.message : String(importError),
        originalError: error instanceof Error ? error.message : String(error),
      });
      // Fallback implementations
      logErrorSafely = (logger: any, operation: string, err: any, context?: any) => {
        logger.error(`${operation} failed`, {
          error: err instanceof Error ? err.message : String(err),
          context,
        });
      };
      formatErrorMessage = (err: any) => {
        return err instanceof Error ? err.message : String(err);
      };
    }

    // Build context for error logging
    const context: Record<string, any> = {
      path: req.path,
      method: req.method,
    };

    // Add request body context if available
    if (body && typeof body === 'object') {
      context.tool_name = body.params?.name || body.method?.replace('tools/', '') || 'unknown';
      if (body.params?.arguments) {
        const args = body.params.arguments;
        context.object_name =
          args.class_name ||
          args.className ||
          args.object_name ||
          args.objectName ||
          args.table_name ||
          args.tableName ||
          args.program_name ||
          args.programName ||
          'unknown';
        context.is_standard_object =
          context.object_name &&
          (context.object_name.startsWith('CL_') ||
            context.object_name.startsWith('IF_') ||
            context.object_name.startsWith('CX_') ||
            context.object_name.startsWith('Z') === false);
      }
    }

    // Log error with synchronized format
    logErrorSafely(log, 'HTTP request handling', error, context);

    if (!res.headersSent) {
      const statusCode = error?.response?.status || error?.statusCode || 500;
      const userMessage = formatErrorMessage(error);
      res.writeHead(statusCode).end(`Internal Server Error: ${userMessage}`);
    } else {
      res.end();
    }
  }
}

// NOTE: Destination probe is implemented as CAP function ProbeDestination in mcp-proxy.ts
// It uses executeHttpRequest from SAP Cloud SDK for automatic destination handling

/**
 * Get OAuth token using client_credentials flow
 */
async function getOAuthToken(
  clientId: string,
  clientSecret: string,
  tokenUrl: string
): Promise<string> {
  const fetch = (await import('node-fetch')).default;
  const log = cds.log('oauth-token');

  try {
    log.debug('Requesting OAuth token', { clientId: clientId.substring(0, 20) + '...', tokenUrl });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
      }).toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('OAuth token request failed', { status: response.status, error: errorText });
      throw new Error(`OAuth token request failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as { access_token: string };
    log.debug('OAuth token obtained successfully');
    return data.access_token;
  } catch (error: any) {
    log.error('Failed to get OAuth token', { error: error.message });
    throw error;
  }
}

/**
 * Register middleware for /mcp routes
 * All authentication/authorization is handled via CAP AuthService.CheckAuth
 */
cds.on('bootstrap', (app: Application) => {
  const log = cds.log('mcp-proxy/bootstrap');
  log.info('Registering /mcp endpoints - authentication via CAP AuthService');

  /**
   * Fix Content-Type and Accept headers for Cline compatibility
   * StreamableHTTPServerTransport requires:
   * - Content-Type: application/json (not application/x-ndjson)
   * - Accept: application/json, text/event-stream (required by transport even with enableJsonResponse: true)
   * Note: enableJsonResponse: true means we use JSON format, not SSE, but transport still requires both in Accept
   */
  app.use('/mcp/stream/http', (req: Request, res: Response, next: NextFunction) => {
    // Fix Content-Type: convert application/x-ndjson to application/json
    if (req.headers['content-type'] === 'application/x-ndjson') {
      req.headers['content-type'] = 'application/json';
    }

    // Ensure Accept header includes both required types (transport requirement)
    // Even with enableJsonResponse: true, transport requires both types in Accept header
    const accept = req.headers.accept || '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      req.headers.accept = 'application/json, text/event-stream';
    }

    next();
  });

  /**
   * Convert Basic auth to Bearer token in production mode
   */
  async function convertBasicToBearer(req: Request): Promise<void> {
    const convertLog = cds.log('auth-convert');
    const authHeader = req.headers.authorization;

    convertLog.info('🔄 convertBasicToBearer called', {
      hasAuthHeader: !!authHeader,
      authType: authHeader?.substring(0, 10) || 'none',
    });

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      convertLog.info('⏭️ Not Basic auth, skipping conversion');
      return; // Not Basic auth, skip
    }

    const isDevelopment =
      cds.env.profiles?.includes('development') ||
      process.env.CDS_ENV === 'development' ||
      cds.env.requires?.auth?.['[development]']?.kind === 'mocked';

    if (isDevelopment) {
      convertLog.info('⏭️ Development mode, keeping Basic auth');
      return; // Keep Basic auth in development
    }

    // Production mode - convert Basic to Bearer
    convertLog.info('🔄 Converting Basic auth to Bearer token in production');

    try {
      // Get XSUAA credentials from VCAP_SERVICES
      const vcapServices = process.env.VCAP_SERVICES
        ? JSON.parse(process.env.VCAP_SERVICES)
        : loadEnv()?.VCAP_SERVICES || {};

      const xsuaa = vcapServices?.xsuaa?.[0]?.credentials;
      if (!xsuaa) {
        convertLog.warn('⚠️ XSUAA credentials not found, cannot convert Basic to Bearer');
        return;
      }

      // Build token URL
      const tokenUrl = `${xsuaa.url}/oauth/token`;
      convertLog.info('📡 Requesting OAuth token', { tokenUrl });

      // Get token using client_credentials flow
      const token = await getOAuthToken(xsuaa.clientid, xsuaa.clientsecret, tokenUrl);

      // Replace Basic auth with Bearer token
      req.headers.authorization = `Bearer ${token}`;
      convertLog.info('✅ Successfully converted Basic auth to Bearer token', {
        tokenLength: token.length,
      });
    } catch (error: any) {
      convertLog.error('❌ Failed to convert Basic auth to Bearer', {
        error: error.message,
        stack: error.stack?.substring(0, 300),
      });
      // Don't throw - let auth check fail later
    }
  }

  /**
   * Check authentication via CAP AuthService.CheckAuth
   * Uses in-process call via cds.connect.to() for proper user propagation
   * This is faster, network-free, and correctly propagates user/tenant/locale
   */
  async function requireAuth(req: Request, res: Response): Promise<boolean> {
    const debugLog = cds.log('auth-check');
    try {
      debugLog.info('🔍 Checking auth via CAP CheckAuth (in-process)', {
        hasAuthHeader: !!req.headers.authorization,
        hasUser: !!(req as any).user,
        userId: (req as any).user?.id,
      });

      // Get AuthService (internal CAP service, same process)
      // cds.connect.to() works for both internal and external services
      const srv = await cds.connect.to('AuthService');
      if (!srv) {
        debugLog.error('❌ AuthService not found');
        throw new Error('AuthService not available');
      }

      debugLog.info('📡 Calling CheckAuth via in-process (srv.run)', {
        hasAuthHeader: !!req.headers.authorization,
      });

      // Call CheckAuth function using modern CAP API (srv.run with req)
      // This automatically picks up the request context (user/tenant/locale)
      // CAP will authenticate based on req.headers.authorization and set req.user
      let result;
      try {
        // Call CheckAuth function through service with request context
        // The request object is passed to propagate user/tenant/locale
        result = await srv.run('CheckAuth', req);
      } catch (authError: any) {
        // Handle CAP rejections (401, 403, etc.)
        if (authError.code === 401 || authError.statusCode === 401) {
          debugLog.warn('❌ CheckAuth: Unauthorized', {
            code: authError.code || authError.statusCode,
            message: authError.message,
          });
          if (!res.headersSent) {
            res.status(401).json({
              error: 'Unauthorized',
              message: authError.message || 'Authentication failed',
            });
          }
          return false;
        }
        throw authError;
      }

      debugLog.info('✅ CheckAuth succeeded', {
        authenticated: result?.authenticated,
        userId: result?.id,
        roles: result?.roles,
      });

      // Set req.user from CheckAuth result for subsequent handlers
      if (result && !(req as any).user) {
        (req as any).user = {
          id: result.id,
          roles: result.roles || [],
          _is_anonymous: false,
        };
      }

      return true;
    } catch (e: any) {
      debugLog.error('❌ requireAuth error', {
        error: e.message,
        statusCode: e?.statusCode,
        code: e?.code,
        name: e?.name,
        stack: e?.stack?.substring(0, 500),
      });

      const status = e?.statusCode || (e?.code === 401 ? 401 : 500);
      if (!res.headersSent) {
        res.status(status).json({
          error: status === 401 ? 'Unauthorized' : 'Internal Server Error',
          message: e?.message || 'Authorization failed',
        });
      }
      return false;
    }
  }

  const ensureAuth = (handler: (req: Request, res: Response) => Promise<any>) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      const authLog = cds.log('mcp-proxy/auth-middleware');
      authLog.info('🔐 ensureAuth middleware called', {
        path: req.path,
        method: req.method,
        hasAuthHeader: !!req.headers.authorization,
      });

      try {
        // Convert Basic auth to Bearer token in production if needed
        authLog.info('🔄 Calling convertBasicToBearer...');
        await convertBasicToBearer(req);
        authLog.info('✅ convertBasicToBearer completed', {
          hasAuthHeader: !!req.headers.authorization,
          authType: req.headers.authorization?.substring(0, 10) || 'none',
        });

        // Check authentication via CAP AuthService.CheckAuth
        authLog.info('🔄 Calling requireAuth...');
        const ok = await requireAuth(req, res);
        if (!ok) {
          authLog.warn('❌ requireAuth failed', { path: req.path });
          return;
        }

        authLog.info('✅ requireAuth succeeded, calling handler', { path: req.path });

        try {
          await handler(req, res);
          authLog.info('✅ Handler completed', { path: req.path });
        } catch (err: any) {
          authLog.error('❌ Handler error', {
            path: req.path,
            error: err.message,
            stack: err.stack?.substring(0, 300),
          });
          next(err);
        }
      } catch (err: any) {
        authLog.error('❌ ensureAuth middleware error', {
          path: req.path,
          error: err.message,
          stack: err.stack?.substring(0, 300),
        });
        next(err);
      }
    };
  };

  // Error handler for /mcp routes
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    // Only handle errors for /mcp routes
    if (req.path?.startsWith('/mcp')) {
      const errorLog = cds.log('mcp-proxy/error-handler');
      errorLog.error('Error in /mcp route', { error: err.message, path: req.path, name: err.name });
    }

    // For non-/mcp routes, pass to next error handler
    next(err);
  });

  // Register endpoints - auth is already handled by middleware above
  // NOTE: /mcp/destination/probe is now a CAP function: GET /mcp/ProbeDestination?destination=NAME

  // Log all requests to /mcp/stream/* for debugging
  app.use('/mcp/stream/*', (req: Request, res: Response, next: NextFunction) => {
    const debugLog = cds.log('mcp-proxy/request-logger');
    debugLog.info('📥 Request received', {
      method: req.method,
      path: req.path,
      url: req.url,
      originalUrl: req.originalUrl,
      headers: {
        'content-type': req.headers['content-type'],
        accept: req.headers.accept,
        'mcp-session-id': req.headers['mcp-session-id'],
        authorization: req.headers.authorization ? 'present' : 'missing',
      },
    });
    next();
  });

  // StreamableHTTP endpoint: POST only (bidirectional NDJSON streaming)
  // This is the only transport we support - SSE is not needed
  app.post('/mcp/stream/http', ensureAuth(handleStreamHTTP));

  // Handle GET requests to /mcp/stream/http (should be POST)
  app.get(
    '/mcp/stream/http',
    ensureAuth(async (req: Request, res: Response) => {
      const log = cds.log('mcp-proxy/bootstrap');
      log.warn('GET request to StreamableHTTP endpoint (should be POST)', {
        path: req.path,
        url: req.url,
      });
      res.status(405).json({
        error: 'Method Not Allowed',
        message: 'StreamableHTTP endpoint requires POST method, not GET',
        supportedMethod: 'POST',
        endpoint: '/mcp/stream/http',
      });
    })
  );

  // Handle any requests to /mcp/stream/sse (not supported)
  app.all(
    '/mcp/stream/sse',
    ensureAuth(async (req: Request, res: Response) => {
      const log = cds.log('mcp-proxy/bootstrap');
      log.warn('SSE endpoint requested (not supported)', {
        method: req.method,
        path: req.path,
        url: req.url,
      });
      res.status(404).json({
        error: 'SSE endpoint not available',
        message:
          'This server only supports StreamableHTTP transport. Use POST /mcp/stream/http instead.',
        supportedEndpoint: '/mcp/stream/http',
        method: 'POST',
      });
    })
  );

  log.info('Custom Express endpoints registered', {
    streamHttp: 'POST /mcp/stream/http',
    destinationProbe: 'GET /mcp/ProbeDestination?destination=NAME (CAP function)',
  });
});
