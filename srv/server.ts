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
import type { Application, NextFunction, Request, Response } from 'express';
import express from 'express';

import { ensureAiCoreCredentials } from './agent-config';
import {
  clearSessionTopic,
  initSmartAgents,
  refreshDestinations,
} from './agent-manager';
import { handleAnthropicMessages } from './anthropic-handler';
import { createBasicToBearerMiddleware } from './lib/basic-to-bearer';
import { formatErrorMessage, logErrorSafely } from './lib/errorUtils';
import { createMCPServerForRequest } from './mcp-manager';
import {
  clearSession,
  handleChatCompletions,
  handleModels,
  handleUsage,
} from './openai-handler';

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
 * Register middleware and endpoints for /mcp and /v1 routes.
 *
 * Authentication uses CAP's built-in middleware (cds.middlewares.before)
 * applied to custom Express routes. This handles both:
 * - Development: mocked auth via Basic header (users from package.json cds config)
 * - Production: XSUAA JWT validation via @sap/xssec
 *
 * Custom Express routes registered in cds.on('bootstrap') don't go through
 * CAP's middleware chain automatically, so we apply context + auth manually.
 * See: https://cap.cloud.sap/docs/node.js/cds-serve#cds-middlewares
 * See: docs/development/CAP_EXPRESS_AUTH.md
 *
 * Role-based authorization for MCP tools is handled in mcp-manager.ts
 * by checking cds.context.user roles.
 */
cds.on('bootstrap', (app: Application) => {
  ensureAiCoreCredentials();

  const log = cds.log('mcp-proxy/bootstrap');
  log.info('Registering /mcp endpoints');

  // Serve chat UI static files (app/chat/webapp is copied to gen/srv/app/chat/webapp during build)
  const chatPath = require('node:path').join(
    __dirname,
    'app',
    'chat',
    'webapp',
  );
  app.use('/chat/webapp', express.static(chatPath));

  /**
   * Fix Content-Type and Accept headers for Cline compatibility
   */
  app.use(
    '/mcp/stream/http',
    (req: Request, _res: Response, next: NextFunction) => {
      if (req.headers['content-type'] === 'application/x-ndjson') {
        req.headers['content-type'] = 'application/json';
      }
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

  // Reuse CAP's built-in auth middleware for custom Express routes.
  // Custom routes registered via cds.on('bootstrap') don't go through CAP's
  // middleware chain automatically. We apply context + auth middleware manually
  // so that cds.context.user is populated for both mocked (dev) and XSUAA JWT (prod).
  // See: docs/development/CAP_EXPRESS_AUTH.md
  const [context, , auth] = cds.middlewares.before;
  const wrappedAuth = createBasicToBearerMiddleware(auth);

  app.use(
    '/mcp',
    context,
    wrappedAuth,
    (_req: Request, res: Response, next: NextFunction) => {
      if (!cds.context?.user || cds.context?.user?.is('anonymous')) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing or invalid Authorization header',
        });
        return;
      }
      next();
    },
  );

  // Request logger for debugging
  app.use(
    '/mcp/stream/*',
    (req: Request, _res: Response, next: NextFunction) => {
      const debugLog = cds.log('mcp-proxy/request-logger');
      debugLog.info('Request received', {
        method: req.method,
        path: req.originalUrl,
        userId: cds.context?.user?.id,
        authorization: req.headers.authorization ? 'present' : 'missing',
      });
      next();
    },
  );

  // StreamableHTTP endpoint: POST only
  app.post('/mcp/stream/http', async (req: Request, res: Response) => {
    try {
      await handleStreamHTTP(req, res);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Handler error', {
        path: req.path,
        error: error.message,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  });

  // Handle GET requests to /mcp/stream/http (should be POST)
  app.get('/mcp/stream/http', (_req: Request, res: Response) => {
    res.status(405).json({
      error: 'Method Not Allowed',
      message: 'StreamableHTTP endpoint requires POST method, not GET',
      supportedMethod: 'POST',
      endpoint: '/mcp/stream/http',
    });
  });

  // Handle requests to /mcp/stream/sse (not supported)
  app.all('/mcp/stream/sse', (_req: Request, res: Response) => {
    res.status(404).json({
      error: 'SSE endpoint not available',
      message:
        'This server only supports StreamableHTTP transport. Use POST /mcp/stream/http instead.',
      supportedEndpoint: '/mcp/stream/http',
      method: 'POST',
    });
  });

  // -------------------------------------------------------------------
  // OpenAI-compatible endpoints (/v1/*)
  // -------------------------------------------------------------------

  // Reuse CAP auth middleware for /v1 routes (same as /mcp above)
  app.use(
    '/v1',
    context,
    wrappedAuth,
    (_req: Request, res: Response, next: NextFunction) => {
      if (!cds.context?.user || cds.context?.user?.is('anonymous')) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing or invalid Authorization header',
        });
        return;
      }
      next();
    },
  );

  // CORS preflight for /v1/* routes
  app.options('/v1/*', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Session-Id',
    );
    res.writeHead(204);
    res.end();
  });

  // Parse JSON body for /v1/* routes
  app.use('/v1', express.json({ limit: '10mb' }));

  // POST /v1/chat/completions — main chat (streaming + non-streaming)
  app.post('/v1/chat/completions', handleChatCompletions as never);

  // POST /v1/messages — Anthropic Messages API (streaming + non-streaming)
  app.post('/v1/messages', handleAnthropicMessages as never);

  // GET /v1/models — model list (no auth required via /v1 middleware above)
  app.get('/v1/models', handleModels as never);

  // GET /v1/usage — token usage
  app.get('/v1/usage', handleUsage as never);

  // POST /v1/destinations/refresh — re-init unreachable destinations
  app.post('/v1/destinations/refresh', (async (
    _req: Request,
    res: Response,
  ) => {
    try {
      const states = await refreshDestinations();
      res.json({ destinations: states });
    } catch (err) {
      res.status(500).json({
        error: { message: (err as Error).message },
      });
    }
  }) as never);

  // DELETE /v1/session — clear server-side conversation history
  app.delete('/v1/session', ((req: Request, res: Response) => {
    const sessionId = req.headers['x-session-id'] as string | undefined;
    if (sessionId) {
      clearSession(sessionId);
      clearSessionTopic(sessionId);
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'x-session-id header required' } }),
      );
    }
  }) as never);

  log.info('Custom Express endpoints registered', {
    streamHttp: 'POST /mcp/stream/http',
    chatCompletions: 'POST /v1/chat/completions',
    anthropicMessages: 'POST /v1/messages',
    models: 'GET /v1/models',
    usage: 'GET /v1/usage',
    sessionClear: 'DELETE /v1/session',
    destinationProbe:
      'GET /mcp-proxy/ProbeDestination?destination=NAME (CAP function)',
  });
});

// Pre-initialize SmartAgent at server startup (after all CAP services are served).
// This runs MCP connection + tool vectorization so the first user request is fast.
// IMPORTANT: Do NOT await — vectorization takes 60+ seconds and would block the
// server from listening on port 8080, causing CF health check timeout (60s).
// The 503 readiness guard in openai-handler.ts protects against requests before ready.
cds.on('served', () => {
  const log = cds.log('agent-manager/init');
  log.info(
    'Pre-initializing SmartAgent (MCP connect + tool vectorization) — non-blocking',
  );
  initSmartAgents()
    .then(() => log.info('SmartAgents initialized and ready'))
    .catch((err) => {
      log.warn(
        'SmartAgent initialization failed, will retry on first request',
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    });
});
