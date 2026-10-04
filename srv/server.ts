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

import { ensureAiCoreCredentials, getAgentConfig } from './agent-config';
import {
  getCollectionRegistry,
  getDestinationMappings,
  initProviders,
  initSmartAgents,
  isProvidersReady,
  refreshDestinations,
  resolveSystemDestination,
} from './agent-manager';
import { createAgentMcpServerForRequest } from './agent-mcp';
import { handleAnthropicMessages } from './anthropic-handler';
import { createBasicToBearerMiddleware } from './lib/basic-to-bearer';
import {
  formatErrorMessage,
  httpErrorText,
  logErrorSafely,
} from './lib/errorUtils';
import {
  deleteSession,
  forgetEmptySessions,
  maySweepSession,
  sessionIsLive,
  shutdownGatekeeper,
} from './lib/gatekeeper';
import { gatekeeperConfig } from './lib/gatekeeper-config';
import { installThrottleObserver } from './lib/gatekeeper-metrics';
import { guardedTask } from './lib/guarded-task';
import { needsSapConnection } from './lib/mcp-request';
import { startProviders } from './lib/providers';
import { sessionMiddleware } from './lib/session-middleware';
import { createMCPServerForRequest } from './mcp-manager';
import {
  handleChatCompletions,
  handleModels,
  handleUsage,
} from './openai-handler';
import { registerRagRoutes } from './rag-handler';
import { sessionIdOf } from './session-id';

/**
 * RAG collection management routes (/v1/rag/*). Mounted in `bootstrap`, filled
 * once the async provider startup has finished (spec §4.1); until then it is
 * empty and a gate in front of it answers 503 for those paths.
 */
const ragRouter = express.Router();

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
 * - Uses AdtOnPremConnector (Basic) or AdtCloudConnector (JWT) from @mcp-abap-adt/connection
 * - Simple JWT or Basic auth directly to SAP
 * - NO token refresh - client must send valid token each request
 *
 * @param req - HTTP request
 * @param res - HTTP response
 */
export async function handleStreamHTTP(
  req: Request,
  res: Response,
): Promise<void> {
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

    // Create NEW MCP server for this request (per-request architecture).
    // The ABAP connection is opened only when the message actually reaches SAP.
    const establish = needsSapConnection(body);
    const result = await createMCPServerForRequest(req, { establish });
    cleanup = result.cleanup;
    if (!establish) {
      log.debug('MCP request answered without opening a SAP session', {
        method: isMcpRequestBody(body) ? body.method : 'batch',
      });
    }

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

    // Handle HTTP request through transport, inside this request's system
    // scope (responsible / login / master system) like the agent channels.
    try {
      await result.handle(req, res, body);
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
      res.writeHead(statusCode).end(httpErrorText(statusCode, userMessage));
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
  // First, and synchronously. CAP emits `bootstrap` inside `cds_server` with a
  // plain EventEmitter emit, so a throw here rejects what `cds serve` awaits and
  // no server ever listens. On `served` the same throw was caught and logged as
  // "will retry on first request", and the service came up answering 500.
  gatekeeperConfig();
  ensureAiCoreCredentials();
  // Configuration shape errors stop the server here, before it listens. The
  // instances are built from it later, in `served`.
  getAgentConfig();

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

  const MCP_ROLES = ['MCP_Reader', 'MCP_Analyst', 'MCP_Developer', 'MCP_Full'];

  /** Auth + role check middleware: user must be authenticated AND have at least one MCP_* role */
  const requireMcpRole = (_req: Request, res: Response, next: NextFunction) => {
    const user = cds.context?.user;
    if (!user || user.is('anonymous')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header',
      });
      return;
    }
    const hasRole = MCP_ROLES.some((role) => user.is(role));
    if (!hasRole) {
      // A technical token gets a different message on purpose. Telling the
      // operator of a client_credentials client to "assign a role collection"
      // sends them to their own BTP user, where the roles already are and
      // where changing them cannot help — the token carries the CLIENT's
      // scopes, not theirs.
      const technical = user.is('system-user');
      res.status(403).json({
        error: 'Forbidden',
        message: technical
          ? `Access denied: authenticated as technical client "${user.id}" (client_credentials). Its xsuaa client holds no MCP scope; a human's role collections do not apply. Grant the scope to the client, or authenticate as a user.`
          : 'Access denied: user has no MCP roles. Assign MCP_Reader, MCP_Analyst, MCP_Developer, or MCP_Full role collection.',
      });
      return;
    }
    next();
  };

  // CAP's jwt-auth middleware calls next(401) / next(403) (passing the
  // numeric status as the error argument) on missing/invalid/expired JWT.
  // Without an Express error-handling middleware in the chain, the default
  // handler turns that into "500 Internal Server Error" with an HTML body
  // — opaque to MCP/OpenAI clients and easily mistaken for a server bug
  // (the dump-monitor 502 Bad Gateway incident in PR #75 was exactly this).
  // Map the auth error codes to a small JSON body so clients can react
  // (refresh token, surface auth UI, etc.) instead of guessing.
  const authJsonErrorHandler = (
    err: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    let status: number | undefined;
    if (typeof err === 'number' && err >= 400 && err < 600) status = err;
    else if (err && typeof err === 'object' && 'status' in err) {
      const s = (err as { status: unknown }).status;
      if (typeof s === 'number') status = s;
    }
    if (status === 401 || status === 403) {
      res.status(status).json({
        error: status === 401 ? 'Unauthorized' : 'Forbidden',
        message:
          status === 401
            ? 'Authentication failed: token missing, invalid, or expired'
            : 'Access denied',
      });
      return;
    }
    next(err);
  };

  app.use('/mcp', context, wrappedAuth, requireMcpRole, authJsonErrorHandler);

  // Request logger for debugging
  app.use('/mcp/stream', (req: Request, _res: Response, next: NextFunction) => {
    const debugLog = cds.log('mcp-proxy/request-logger');
    debugLog.info('Request received', {
      method: req.method,
      path: req.originalUrl,
      userId: cds.context?.user?.id,
      authorization: req.headers.authorization ? 'present' : 'missing',
    });
    next();
  });

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

  // MCP health check
  app.get('/mcp/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: 'StreamableHTTP',
      endpoint: '/mcp/stream/http',
      timestamp: new Date().toISOString(),
    });
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

  // Planner/controller surface — exposes `list_destinations` + `execute_step`
  // (the executor agent behind it). Same /mcp auth as above. See srv/agent-mcp.ts.
  app.post('/mcp/agent/stream/http', async (req: Request, res: Response) => {
    const alog = cds.log('mcp-proxy/agent-stream');
    let cleanup: (() => Promise<void>) | null = null;
    try {
      // Read the JSON-RPC body first (same as handleStreamHTTP).
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: unknown = null;
      if (chunks.length > 0) {
        const s = Buffer.concat(chunks).toString('utf-8');
        try {
          body = JSON.parse(s);
        } catch {
          body = s || null;
        }
      }

      const result = await createAgentMcpServerForRequest(req);
      cleanup = result.cleanup;
      res.on('close', () => {
        cleanup?.().catch((err) =>
          alog.warn('cleanup on close failed', { error: String(err) }),
        );
      });
      await result.transport.handleRequest(req, res, body);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      alog.error('agent-stream handler error', { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch (err) {
          alog.warn('cleanup failed', { error: String(err) });
        }
      }
    }
  });

  app.get('/mcp/agent/stream/http', (_req: Request, res: Response) => {
    res.status(405).json({
      error: 'Method Not Allowed',
      message: 'StreamableHTTP endpoint requires POST method, not GET',
      supportedMethod: 'POST',
      endpoint: '/mcp/agent/stream/http',
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

  // Reuse CAP auth + role check for /v1 routes (same auth-error JSON handler
  // as /mcp so OpenAI/Anthropic clients get 401 JSON instead of 500 HTML).
  app.use('/v1', context, wrappedAuth, requireMcpRole, authJsonErrorHandler);

  // Every /v1 request runs under a session this service issued. The cookie is
  // the only thing read; a header naming a session is not.
  app.use(
    '/v1',
    sessionMiddleware({
      userIdOf: () => cds.context?.user?.id ?? 'anonymous',
      isLive: sessionIsLive,
    }),
  );

  // CORS preflight for /v1/* routes
  app.options('/v1/{*path}', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      // No X-Session-Id: the service issues the session in its cookie and no
      // route reads a header naming one.
      'Content-Type, Authorization, X-Rag-Collections',
    );
    res.writeHead(204);
    res.end();
  });

  // Parse JSON body for /v1/* routes
  app.use('/v1', express.json({ limit: '10mb' }));

  // RAG collection management routes (/v1/rag/*): registered into `ragRouter`
  // once the providers are ready; until then those paths answer 503.
  app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
    if (!isProvidersReady() && req.path.startsWith('/rag')) {
      res.status(503).json({ error: { message: 'RAG not ready yet' } });
      return;
    }
    next();
  });
  app.use('/v1', ragRouter);

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

  // GET /v1/destinations/resolve?system=DEV.100 — resolve system code to BTP destination
  app.get('/v1/destinations/resolve', ((req: Request, res: Response) => {
    const system = req.query.system as string;
    if (!system) {
      res.status(400).json({
        error: {
          message: 'system query parameter required (e.g., ?system=DEV.100)',
        },
      });
      return;
    }
    const result = resolveSystemDestination(system);
    if (!result.ok) {
      res.status(404).json({ error: { message: result.error } });
      return;
    }
    res.json({ system, destination: result.destination });
  }) as never);

  // GET /v1/destinations/mappings — list all system-to-destination mappings
  app.get('/v1/destinations/mappings', ((_req: Request, res: Response) => {
    res.json({ mappings: getDestinationMappings() });
  }) as never);

  // GET /v1/token — return the caller's JWT token (for API access from external tools)
  app.get('/v1/token', ((req: Request, res: Response) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      res.json({ token: auth.slice(7) });
    } else {
      res
        .status(401)
        .json({ error: { message: 'No Bearer token found in request' } });
    }
  }) as never);

  // DELETE /v1/session — clear server-side conversation history
  app.delete('/v1/session', ((req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'no session (the clh_session cookie is required)' },
        }),
      );
      return;
    }
    const userId = cds.context?.user?.id ?? 'anonymous';
    // Answered at the mark. The session is unreachable from this moment; its
    // bytes go when the last operation against them has stopped — a pipeline
    // runs to its own end, a RAG upload is cancelled and then waited for.
    void deleteSession(userId, sessionId).catch((err) =>
      cds.log('session').warn('session removal failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    res.writeHead(204);
    res.end();
  }) as never);

  log.info('Custom Express endpoints registered', {
    streamHttp: 'POST /mcp/stream/http',
    chatCompletions: 'POST /v1/chat/completions',
    anthropicMessages: 'POST /v1/messages',
    models: 'GET /v1/models',
    usage: 'GET /v1/usage',
    sessionClear: 'DELETE /v1/session',
    ragCollections: '/v1/rag/collections (CRUD + upload + query)',
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
  installThrottleObserver();
  const log = cds.log('agent-manager/init');
  // Both sweeps start here, whatever initialisation does next. Inside its
  // success path, a failed first init left neither running until restart. Each tick is guarded: a throw inside a timer
  // is an uncaught exception, and CAP would shut the process down on it.
  // Hourly: expired session collections, skipping any session with an
  // operation still running against it — the next pass collects those.
  // The registry exists only once the providers are built; until then there
  // is no session collection to sweep.
  setInterval(
    guardedTask('Session collection sweep', log, () => {
      if (isProvidersReady())
        getCollectionRegistry().sweepExpiredSessions(maySweepSession);
    }),
    60 * 60 * 1000,
  ).unref();
  // Every five minutes, beside the history sweep: a session whose turns have
  // expired and which owns no collection stops counting.
  setInterval(
    guardedTask('Empty session forget', log, () => forgetEmptySessions()),
    5 * 60 * 1000,
  ).unref();
  log.info(
    'Starting providers, then pre-initializing SmartAgent (MCP connect + tool vectorization) — non-blocking',
  );
  // Providers first (short: embedder prefetch + instances), then the registry
  // and its routes, then the long agent warm-up. Nothing before this point
  // builds an embedder, a store or a registry.
  //
  // Two failure classes, handled apart. A provider failure is a deployment or
  // configuration mistake (a missing embedder package, a constructor refusing
  // its settings), never an outage: the process exits non-zero so the platform
  // reports it instead of a healthy instance answering 503 forever. An agent
  // warm-up failure can be an outage (AI Core, a destination) and is retried.
  startProviders(getAgentConfig())
    .then((p) => {
      initProviders(p);
      registerRagRoutes(ragRouter, getCollectionRegistry());
      log.info('Providers ready');
    })
    .then(
      () =>
        initSmartAgents().then(
          () => {
            log.info('SmartAgents initialized and ready');
          },
          (err) => {
            log.warn(
              'SmartAgent initialization failed, will retry on first request',
              { error: err instanceof Error ? err.message : String(err) },
            );
          },
        ),
      (err) => {
        log.error('Provider startup failed, exiting', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Not cds.shutdown(): it closes the server without an exit code (the
        // force-exit that follows is process.exit() with 0), and before
        // `cds serve` has listened it is still the library default, which
        // exits 0 too. A failed start must end non-zero.
        process.exit(1);
      },
    );
});

// Only shutdown ends an admitted session.
cds.on('shutdown', () => shutdownGatekeeper());
