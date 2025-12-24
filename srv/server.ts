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
// @ts-expect-error - @sap/xsenv doesn't have types
import { loadEnv } from '@sap/xsenv';
import type { Application, NextFunction, Request, Response } from 'express';
import { formatErrorMessage, logErrorSafely } from './lib/errorUtils';
import { createMCPServerForRequest } from './mcp-manager';

/**
 * Type guard for MCP request body
 */
function isMcpRequestBody(body: unknown): body is {
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
  id?: string | number;
} {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

/**
 * Stream-HTTP endpoint handler - proxies to embedded MCP server
 *
 * ## Per-Request Architecture
 *
 * Each POST request creates:
 * 1. **New connection** - Fresh AbapConnection (CloudSdkAbapConnection or direct)
 * 2. **New MCP server** - Fresh EmbeddableMcpServer with that connection
 * 3. **New transport** - StreamableHTTPServerTransport for this request
 *
 * This follows the standard MCP pattern where each request is independent.
 *
 * ### Connection Types:
 *
 * **With x-sap-destination header:**
 * - Uses CloudSdkAbapConnection
 * - BTP Destination Service manages authentication
 * - Supports Principal Propagation, OAuth2, Basic auth via BTP
 *
 * **Without x-sap-destination (direct connection):**
 * - Uses createAbapConnection from @mcp-abap-adt/connection
 * - Simple JWT or Basic auth directly to SAP
 * - NO token refresh - client must send valid token each request
 *
 * @param req - HTTP request
 * @param res - HTTP response
 */
async function handleStreamHTTP(req: Request, res: Response): Promise<void> {
  const log = cds.log('mcp-proxy/stream-http');
  let body: unknown = null;
  let cleanup: (() => Promise<void>) | null = null;

  // Only handle POST requests (like mcp-abap-adt)
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  try {
    // Read request body first (like mcp-abap-adt does)
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    if (chunks.length > 0) {
      const bodyString = Buffer.concat(chunks).toString('utf-8');
      log.debug('Raw body received', {
        bodyLength: bodyString.length,
      });
      try {
        body = JSON.parse(bodyString);
      } catch {
        body = bodyString || null;
      }
    }

    // Log request details for debugging
    if (isMcpRequestBody(body)) {
      const toolName =
        body.params?.name || body.method?.replace('tools/', '') || 'unknown';
      const toolArgs = body.params?.arguments || {};
      log.info('MCP request', {
        method: body.method,
        toolName,
        toolArgs:
          Object.keys(toolArgs).length > 0
            ? {
                class_name: toolArgs.class_name || toolArgs.className,
                object_name: toolArgs.object_name || toolArgs.objectName,
                table_name: toolArgs.table_name || toolArgs.tableName,
                allKeys: Object.keys(toolArgs),
              }
            : {},
        requestId: body.id || 'no-id',
      });
    }

    // Create NEW MCP server for this request (per-request architecture)
    const result = await createMCPServerForRequest(req);
    cleanup = result.cleanup;

    log.debug('MCP server created for request', {
      connectionType: result.connection.constructor.name,
    });

    // Close transport when response closes
    res.on('close', () => {
      if (cleanup) {
        cleanup().catch((err) => {
          log.warn('Cleanup failed on response close', { error: String(err) });
        });
      }
    });

    // Handle HTTP request through transport
    try {
      await result.transport.handleRequest(req, res, body);
    } catch (transportError: unknown) {
      const errorObj = transportError as {
        message?: string;
        constructor?: { name?: string };
      };
      const errorDetails: Record<string, unknown> = {
        error_type: errorObj?.constructor?.name || 'Unknown',
        error_message: errorObj?.message || String(transportError),
        toolName: isMcpRequestBody(body)
          ? body.params?.name || 'unknown'
          : 'unknown',
      };

      const transportErr = transportError as {
        response?: { status?: number; statusText?: string };
      };
      if (transportErr?.response) {
        errorDetails.http_status = transportErr.response.status;
        errorDetails.http_status_text = transportErr.response.statusText;
      }

      log.error('Transport request failed', errorDetails);
      throw transportError;
    }

    log.debug('Request completed');
  } catch (error: unknown) {
    const context: Record<string, unknown> = {
      path: req.path,
      method: req.method,
    };

    if (isMcpRequestBody(body)) {
      context.tool_name =
        body.params?.name || body.method?.replace('tools/', '') || 'unknown';
    }

    logErrorSafely(log, 'HTTP request handling', error, context);

    if (!res.headersSent) {
      const err = error as {
        response?: { status?: number };
        statusCode?: number;
      };
      const statusCode = err?.response?.status || err?.statusCode || 500;
      const userMessage = formatErrorMessage(error);
      res.writeHead(statusCode).end(`Internal Server Error: ${userMessage}`);
    } else {
      res.end();
    }
  } finally {
    // Ensure cleanup always runs
    if (cleanup) {
      try {
        await cleanup();
      } catch (err) {
        log.warn('Cleanup failed', { error: String(err) });
      }
    }
  }
}

// NOTE: Destination probe is implemented as CAP function ProbeDestination in mcp-proxy.ts
// It uses executeHttpRequest from SAP Cloud SDK for automatic destination handling

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
  app.use(
    '/mcp/stream/http',
    (req: Request, _res: Response, next: NextFunction) => {
      // Fix Content-Type: convert application/x-ndjson to application/json
      if (req.headers['content-type'] === 'application/x-ndjson') {
        req.headers['content-type'] = 'application/json';
      }

      // Ensure Accept header includes both required types (transport requirement)
      // Even with enableJsonResponse: true, transport requires both types in Accept header
      const accept = req.headers.accept || '';
      if (
        !accept.includes('application/json') ||
        !accept.includes('text/event-stream')
      ) {
        req.headers.accept = 'application/json, text/event-stream';
      }

      next();
    },
  );

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
        hasUser: !!(req as Request & { user?: { id?: string } }).user,
        userId: (req as Request & { user?: { id?: string } }).user?.id,
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
      let result: unknown;
      try {
        // Call CheckAuth function through service with request context
        // The request object is passed to propagate user/tenant/locale
        result = await srv.run('CheckAuth', req);
      } catch (authError: unknown) {
        // Handle CAP rejections (401, 403, etc.)
        const authErr = authError as {
          code?: number;
          statusCode?: number;
          message?: string;
        };
        if (authErr.code === 401 || authErr.statusCode === 401) {
          debugLog.warn('❌ CheckAuth: Unauthorized', {
            code: authErr.code || authErr.statusCode,
            message: authErr.message,
          });
          if (!res.headersSent) {
            res.status(401).json({
              error: 'Unauthorized',
              message: authErr.message || 'Authentication failed',
            });
          }
          return false;
        }
        throw authError;
      }

      // Type guard for CheckAuth result
      const checkAuthResult = result as {
        authenticated?: boolean;
        id?: string;
        roles?: string[];
      };

      debugLog.info('✅ CheckAuth succeeded', {
        authenticated: checkAuthResult?.authenticated,
        userId: checkAuthResult?.id,
        roles: checkAuthResult?.roles,
      });

      // Set req.user from CheckAuth result for subsequent handlers
      const reqWithUser = req as Request & {
        user?: { id?: string; roles?: string[]; _is_anonymous?: boolean };
      };
      const resultWithUser = checkAuthResult;
      if (resultWithUser && !reqWithUser.user) {
        reqWithUser.user = {
          id: resultWithUser.id,
          roles: resultWithUser.roles || [],
          _is_anonymous: false,
        };
      }

      return true;
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      const errWithStatus = err as Error & {
        statusCode?: number;
        code?: number;
      };
      debugLog.error('❌ requireAuth error', {
        error: err.message,
        statusCode: errWithStatus?.statusCode,
        code: errWithStatus?.code,
        name: err.name,
        stack: err.stack?.substring(0, 500),
      });

      const status =
        errWithStatus?.statusCode || (errWithStatus?.code === 401 ? 401 : 500);
      if (!res.headersSent) {
        res.status(status).json({
          error: status === 401 ? 'Unauthorized' : 'Internal Server Error',
          message: err.message || 'Authorization failed',
        });
      }
      return false;
    }
  }

  const ensureAuth = (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      const authLog = cds.log('mcp-proxy/auth-middleware');
      authLog.info('🔐 ensureAuth middleware called', {
        path: req.path,
        method: req.method,
        hasAuthHeader: !!req.headers.authorization,
      });

      try {
        // Check authentication via CAP AuthService.CheckAuth
        authLog.info('🔄 Calling requireAuth...');
        const ok = await requireAuth(req, res);
        if (!ok) {
          authLog.warn('❌ requireAuth failed', { path: req.path });
          return;
        }

        authLog.info('✅ requireAuth succeeded, calling handler', {
          path: req.path,
        });

        try {
          await handler(req, res);
          authLog.info('✅ Handler completed', { path: req.path });
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          authLog.error('❌ Handler error', {
            path: req.path,
            error: error.message,
            stack: error.stack?.substring(0, 300),
          });
          next(error);
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        authLog.error('❌ ensureAuth middleware error', {
          path: req.path,
          error: error.message,
          stack: error.stack?.substring(0, 300),
        });
        next(error);
      }
    };
  };

  // Error handler for /mcp routes
  app.use((err: unknown, req: Request, _res: Response, next: NextFunction) => {
    // Only handle errors for /mcp routes
    if (req.path?.startsWith('/mcp')) {
      const errorLog = cds.log('mcp-proxy/error-handler');
      const error = err instanceof Error ? err : new Error(String(err));
      errorLog.error('Error in /mcp route', {
        error: error.message,
        path: req.path,
        name: error.name,
      });
    }

    // For non-/mcp routes, pass to next error handler
    next(err);
  });

  // Register endpoints - auth is already handled by middleware above
  // NOTE: /mcp/destination/probe is now a CAP function: GET /mcp/ProbeDestination?destination=NAME

  // Log all requests to /mcp/stream/* for debugging
  app.use(
    '/mcp/stream/*',
    (req: Request, _res: Response, next: NextFunction) => {
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
    },
  );

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
    }),
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
    }),
  );

  log.info('Custom Express endpoints registered', {
    streamHttp: 'POST /mcp/stream/http',
    destinationProbe:
      'GET /mcp/ProbeDestination?destination=NAME (CAP function)',
  });
});
