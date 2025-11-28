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
import { getMCPServer } from './mcp-manager';
import { resolveDestinationSapConfig } from './connections/destinationResolver';
import { Readable } from 'stream';


/**
 * Stream-HTTP endpoint handler - proxies to embedded MCP server
 */
async function handleStreamHTTP(req: Request, res: Response): Promise<any> {
  const log = cds.log('mcp-proxy/stream-http');
  
  // Only handle POST requests (like mcp-abap-adt)
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  try {
    // Get embedded MCP server instance (created per-request with SAP config from headers)
    const mcpServer = await getMCPServer(req);
    
    if (!mcpServer || !mcpServer.server) {
      log.error('MCP server not initialized');
      return res.status(503).send('Service Unavailable: MCP server not ready');
    }

    // Read request body (like mcp-abap-adt does)
    let body: any = null;
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

    // Create new StreamableHTTP transport for each request (like mcp-abap-adt)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode (like mcp-abap-adt)
      enableJsonResponse: true, // Use JSON response format, not SSE
      allowedOrigins: undefined,
      allowedHosts: undefined,
      enableDnsRebindingProtection: false
    });

    // Close transport when response closes (like mcp-abap-adt)
    res.on('close', () => {
      transport.close();
    });

    // Connect transport to MCP server (like mcp-abap-adt)
    // In mcp-abap-adt: await this.mcpServer.connect(transport);
    // Our mcpServer.server is mcp_abap_adt_server, mcpServer.server.server is McpServer
    await mcpServer.server.server.connect(transport);

    log.debug('Transport connected', {
      hasServer: !!mcpServer.server
    });

    // Handle HTTP request through transport (like mcp-abap-adt)
    // Pass body as third parameter (like mcp-abap-adt does)
    await transport.handleRequest(req, res, body);

    log.debug('Request completed');

  } catch (error: any) {
    log.error('Failed to handle HTTP request', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    if (!res.headersSent) {
      res.writeHead(500).end('Internal Server Error');
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
async function getOAuthToken(clientId: string, clientSecret: string, tokenUrl: string): Promise<string> {
  const fetch = (await import('node-fetch')).default;
  const log = cds.log('oauth-token');
  
  try {
    log.debug('Requesting OAuth token', { clientId: clientId.substring(0, 20) + '...', tokenUrl });
    
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials'
      }).toString()
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      log.error('OAuth token request failed', { status: response.status, error: errorText });
      throw new Error(`OAuth token request failed: ${response.status} ${errorText}`);
    }
    
    const data = await response.json() as { access_token: string };
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
      authType: authHeader?.substring(0, 10) || 'none'
    });
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      convertLog.info('⏭️ Not Basic auth, skipping conversion');
      return; // Not Basic auth, skip
    }
    
    const isDevelopment = cds.env.profiles?.includes('development') || 
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
        : (loadEnv()?.VCAP_SERVICES || {});
      
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
        tokenLength: token.length 
      });
    } catch (error: any) {
      convertLog.error('❌ Failed to convert Basic auth to Bearer', { 
        error: error.message,
        stack: error.stack?.substring(0, 300)
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
        userId: (req as any).user?.id
      });
      
      // Get AuthService (internal CAP service, same process)
      // cds.connect.to() works for both internal and external services
      const srv = await cds.connect.to('AuthService');
      if (!srv) {
        debugLog.error('❌ AuthService not found');
        throw new Error('AuthService not available');
      }
      
      debugLog.info('📡 Calling CheckAuth via in-process (srv.run)', { 
        hasAuthHeader: !!req.headers.authorization
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
            message: authError.message
          });
          if (!res.headersSent) {
            res.status(401).json({ 
              error: 'Unauthorized', 
              message: authError.message || 'Authentication failed' 
            });
          }
          return false;
        }
        throw authError;
      }
      
      debugLog.info('✅ CheckAuth succeeded', {
        authenticated: result?.authenticated,
        userId: result?.id,
        roles: result?.roles
      });
      
      // Set req.user from CheckAuth result for subsequent handlers
      if (result && !(req as any).user) {
        (req as any).user = {
          id: result.id,
          roles: result.roles || [],
          _is_anonymous: false
        };
      }
      
      return true;
    } catch (e: any) {
      debugLog.error('❌ requireAuth error', {
        error: e.message,
        statusCode: e?.statusCode,
        code: e?.code,
        name: e?.name,
        stack: e?.stack?.substring(0, 500)
      });
      
      const status = e?.statusCode || (e?.code === 401 ? 401 : 500);
      if (!res.headersSent) {
        res.status(status).json({ 
          error: status === 401 ? 'Unauthorized' : 'Internal Server Error', 
          message: e?.message || 'Authorization failed' 
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
        hasAuthHeader: !!req.headers.authorization 
      });
      
      try {
        // Convert Basic auth to Bearer token in production if needed
        authLog.info('🔄 Calling convertBasicToBearer...');
        await convertBasicToBearer(req);
        authLog.info('✅ convertBasicToBearer completed', { 
          hasAuthHeader: !!req.headers.authorization,
          authType: req.headers.authorization?.substring(0, 10) || 'none'
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
            stack: err.stack?.substring(0, 300)
          });
          next(err);
        }
      } catch (err: any) {
        authLog.error('❌ ensureAuth middleware error', {
          path: req.path,
          error: err.message,
          stack: err.stack?.substring(0, 300)
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
        'accept': req.headers.accept,
        'mcp-session-id': req.headers['mcp-session-id'],
        'authorization': req.headers.authorization ? 'present' : 'missing'
      }
    });
    next();
  });
  
  // StreamableHTTP endpoint: POST only (bidirectional NDJSON streaming)
  // This is the only transport we support - SSE is not needed
  app.post('/mcp/stream/http', ensureAuth(handleStreamHTTP));
  
  // Handle GET requests to /mcp/stream/http (should be POST)
  app.get('/mcp/stream/http', ensureAuth(async (req: Request, res: Response) => {
    const log = cds.log('mcp-proxy/bootstrap');
    log.warn('GET request to StreamableHTTP endpoint (should be POST)', {
      path: req.path,
      url: req.url
    });
    res.status(405).json({
      error: 'Method Not Allowed',
      message: 'StreamableHTTP endpoint requires POST method, not GET',
      supportedMethod: 'POST',
      endpoint: '/mcp/stream/http'
    });
  }));
  
  // Handle any requests to /mcp/stream/sse (not supported)
  app.all('/mcp/stream/sse', ensureAuth(async (req: Request, res: Response) => {
    const log = cds.log('mcp-proxy/bootstrap');
    log.warn('SSE endpoint requested (not supported)', {
      method: req.method,
      path: req.path,
      url: req.url
    });
    res.status(404).json({
      error: 'SSE endpoint not available',
      message: 'This server only supports StreamableHTTP transport. Use POST /mcp/stream/http instead.',
      supportedEndpoint: '/mcp/stream/http',
      method: 'POST'
    });
  }));

  log.info('Custom Express endpoints registered', {
    streamHttp: 'POST /mcp/stream/http',
    destinationProbe: 'GET /mcp/ProbeDestination?destination=NAME (CAP function)'
  });
});
