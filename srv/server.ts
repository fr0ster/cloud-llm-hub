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
import { createMCPServerForRequest } from './mcp-manager';
import { logErrorSafely, formatErrorMessage } from './lib/errorUtils';

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
async function handleStreamHTTP(req: Request, res: Response): Promise<any> {
  const log = cds.log('mcp-proxy/stream-http');
  let body: any = null;
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
    if (body && typeof body === 'object') {
      const toolName = body.params?.name || body.method?.replace('tools/', '') || 'unknown';
      const toolArgs = body.params?.arguments || {};
      log.info('MCP request', {
        method: body.method,
        toolName,
        toolArgs: Object.keys(toolArgs).length > 0
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
    } catch (transportError: any) {
      const errorDetails: any = {
        error_type: transportError?.constructor?.name || 'Unknown',
        error_message: transportError?.message || String(transportError),
        toolName: body?.params?.name || 'unknown',
      };

      if (transportError?.response) {
        errorDetails.http_status = transportError.response.status;
        errorDetails.http_status_text = transportError.response.statusText;
      }

      log.error('Transport request failed', errorDetails);
      throw transportError;
    }

    log.debug('Request completed');
  } catch (error: any) {
    const context: Record<string, any> = {
      path: req.path,
      method: req.method,
    };

    if (body && typeof body === 'object') {
      context.tool_name = body.params?.name || body.method?.replace('tools/', '') || 'unknown';
    }

    logErrorSafely(log, 'HTTP request handling', error, context);

    if (!res.headersSent) {
      const statusCode = error?.response?.status || error?.statusCode || 500;
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
