/**
 * Custom server.ts for CAP bootstrap.
 * This file is automatically loaded by CAP and registers streaming endpoints.
 * 
 * CRITICAL: Environment variables must be set BEFORE imports
 * The mcp-abap-adt submodule has auto-start code that runs on import
 */

// Set BEFORE any imports that might load the submodule
process.env.MCP_SKIP_AUTO_START = 'true';
process.env.MCP_SKIP_ENV_LOAD = 'true';
process.env.TLS_REJECT_UNAUTHORIZED = '0';

import cds from '@sap/cds';
import type { Application, Request, Response, NextFunction } from 'express';
// @ts-ignore - @sap/xsenv doesn't have types
import { loadEnv } from '@sap/xsenv';
import { getMCPServer } from './mcp-manager';
import { resolveDestinationSapConfig } from './connections/destinationResolver';
import { createBtpOnPremConnection } from './connections';
import { createAbapConnection } from '@fr0ster/mcp-abap-adt/dist/lib/connection/connectionFactory';
import { Readable } from 'stream';


/**
 * SSE endpoint handler - proxies to embedded MCP server
 */
async function handleSSE(req: Request, res: Response): Promise<any> {
  const log = cds.log('mcp-proxy/sse');
  // const user = (req as any).user;

  // Trust BTP authentication - if user exists, they're authorized
  // if (!user) {
  //   log.warn('Access denied - no authenticated user', { user: user?.id });
  //   return res.status(401).send('Unauthorized: No authenticated user');
  // }

  // log.info('SSE connection opened', { user: user.id });

  try {
    // Get embedded MCP server instance (created per-request with SAP config from headers)
    const mcpServer = await getMCPServer(req);
    
    if (!mcpServer || !mcpServer.server) {
      log.error('MCP server not initialized');
      return res.status(503).send('Service Unavailable: MCP server not ready');
    }

    // Send SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('retry: 15000\n\n');

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    // Handle MCP protocol through embedded server
    // For SSE, we need to handle the session initialization
    const sessionId = `sse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    // log.info('SSE session established', { user: user.id, sessionId });

    // Send endpoint event to establish connection
    res.write(`event: endpoint\n`);
    res.write(`data: /message\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      res.end();
      // log.info('SSE client disconnected', { user: user.id, sessionId });
    });

    // Keep connection alive
    res.on('error', (err: any) => {
      log.error('SSE stream error', err);
      clearInterval(heartbeat);
      res.end();
    });

  } catch (err: any) {
    log.error('SSE handler error', err);
    if (!res.headersSent) {
      return res.status(500).send(`Internal Server Error: ${err.message}`);
    }
    res.end();
  }
}

/**
 * Stream-HTTP endpoint handler - proxies to embedded MCP server
 */
async function handleStreamHTTP(req: Request, res: Response): Promise<any> {
  const log = cds.log('mcp-proxy/stream-http');
  log.info('🚀 handleStreamHTTP called', { 
    path: req.path,
    method: req.method,
    hasAuthHeader: !!req.headers.authorization,
    hasDestination: !!req.headers['x-sap-destination'],
    destination: req.headers['x-sap-destination']
  });
  
  const user = (req as any).user;
  log.debug('User context', { 
    hasUser: !!user,
    userId: user?.id,
    isAnonymous: user?._is_anonymous,
    roles: user?.roles
  });

  try {
    log.info('📥 Getting MCP server instance...');
    // Get embedded MCP server instance (created per-request with SAP config from headers)
    const mcpServer = await getMCPServer(req);
    log.info('✅ MCP server obtained', { 
      hasServer: !!mcpServer?.server,
      hasWithTransport: !!mcpServer?.withTransport
    });
    
    if (!mcpServer || !mcpServer.withTransport) {
      log.error('❌ MCP transport factory not available', {
        hasMcpServer: !!mcpServer,
        hasWithTransport: !!mcpServer?.withTransport
      });
      return res.status(503).send('Service Unavailable: MCP transport not ready');
    }

    log.info('🔄 Calling transport.handleRequest...');
    await mcpServer.withTransport(async transport => {
      log.debug('📡 Transport ready, handling request');
      await transport.handleRequest(req, res);
      log.debug('✅ Transport request handled');
    });
    
    log.info('✅ Stream-HTTP request completed successfully');

  } catch (err: any) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    const errorDetails = {
      error: errorMessage,
      name: err?.name,
      code: err?.code,
      stack: errorStack
    };
    
    log.error('Stream-HTTP handler error', errorDetails);
    
    if (!res.headersSent) {
      // Return 502 Bad Gateway for destination/connection errors
      // This helps Cline understand the request failed at the gateway level
      const statusCode = err?.statusCode || (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' ? 502 : 500);
      return res.status(statusCode).json({
        error: 'Bad Gateway',
        message: errorMessage,
        code: err?.code || err?.name,
        destination: (req.headers['x-sap-destination'] as string) || undefined
      });
    }
  }
}

export interface DestinationProbeSummary {
  status: number | undefined;
  statusText: string | undefined;
  contentType: string | undefined;
}

export async function probeDestinationConnection(destinationName: string): Promise<{
  summary: DestinationProbeSummary;
  metadata: {
    proxyType: string;
    authentication: string | undefined;
    sapClient: string | undefined;
    tokenExpiresAt?: number;
    connectivityMode: 'internet' | 'onprem';
    cloudConnectorLocationId?: string;
  };
}> {
  const resolution = await resolveDestinationSapConfig(destinationName);
  const proxyType = (resolution.proxyType ?? 'Internet').toLowerCase();
  const connectivityMode = proxyType === 'onpremise' ? 'onprem' : 'internet';
  const metadata = {
    proxyType: resolution.proxyType ?? 'Internet',
    authentication: resolution.authenticationType,
    sapClient: resolution.sapConfig.client,
    tokenExpiresAt: resolution.tokenExpiresAt,
    connectivityMode,
    cloudConnectorLocationId: resolution.cloudConnectorLocationId
  } as const;

  let status: number | undefined;
  let statusText: string | undefined;
  let contentType: string | undefined;

  if (connectivityMode === 'onprem') {
    if (resolution.sapConfig.authType !== 'basic') {
      throw new Error(`Destination "${destinationName}" uses proxy type OnPremise but is not configured for basic authentication.`);
    }

    const connection = await createBtpOnPremConnection(resolution.sapConfig, {
      locationId: resolution.cloudConnectorLocationId,
      principalToken: undefined
    });

    try {
      const baseUrl = await connection.getBaseUrl();
      const response = await connection.makeAdtRequest({
        url: baseUrl,
        method: 'GET',
        timeout: 15000
      });
      status = response.status;
      statusText = response.statusText;
      contentType = response.headers['content-type'];
    } finally {
      connection.reset();
    }
  } else {
    const connection = createAbapConnection(resolution.sapConfig);
    try {
      const baseUrl = await connection.getBaseUrl();
      const response = await connection.makeAdtRequest({
        url: baseUrl,
        method: 'GET',
        timeout: 15000
      });
      status = response.status;
      statusText = response.statusText;
      contentType = response.headers['content-type'];
    } finally {
      connection.reset();
    }
  }

  return {
    summary: {
      status,
      statusText,
      contentType
    },
    metadata
  };
}

// NOTE: Destination probe is now a CAP function in mcp-proxy.ts (ProbeDestination)
// This allows CAP to handle authentication correctly via @requires: 'MCP_Connector'



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
   * Express routes don't go through CAP middleware, so we need to call CheckAuth
   * via HTTP to the CAP service endpoint (which will go through CAP middleware)
   */
  async function requireAuth(req: Request, res: Response): Promise<boolean> {
    const debugLog = cds.log('auth-check');
    try {
      debugLog.info('🔍 Checking auth via CAP CheckAuth (HTTP call)', { 
        hasAuthHeader: !!req.headers.authorization,
        hasUser: !!(req as any).user,
        userId: (req as any).user?.id
      });
      
      // Build URL to call CheckAuth via CAP service
      // For internal requests, always use localhost to avoid routing issues and timeouts
      // On Cloud Foundry: use PORT environment variable (usually 8080)
      // On localhost: use CAP configured port (usually 4004 for development)
      const isCloud = !!process.env.VCAP_APPLICATION;
      const port = isCloud 
        ? (process.env.PORT || '8080')  // On cloud, PORT is always set by Cloud Foundry
        : (cds.env.requires?.server?.port || cds.env.server?.port || 4004);  // On local, use CAP port
      const protocol = 'http'; // Always use http for internal requests
      const baseUrl = `http://localhost:${port}`;
      const url = `${baseUrl}/odata/v4/auth/CheckAuth()`;
      
      debugLog.info('📡 Calling CheckAuth via HTTP (internal)', { 
        url,
        baseUrl,
        port,
        isCloud,
        portSource: isCloud ? 'process.env.PORT' : 'cds.env.server.port'
      });
      
      // Make HTTP request to CAP service endpoint
      // This will go through CAP middleware and authentication
      const fetch = (await import('node-fetch')).default;
      
      // Copy headers, but exclude ones that shouldn't be forwarded
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (!['host', 'content-length', 'connection'].includes(lowerKey) && value !== undefined) {
          headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      }
      
      // Set a reasonable timeout to avoid hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal as any
        });
        
        clearTimeout(timeoutId);
        
        debugLog.info('📥 CheckAuth response received', { 
          status: response.status, 
          statusText: response.statusText
        });
        
        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          debugLog.error('❌ CheckAuth failed', {
            status: response.status,
            statusText: response.statusText,
            errorText: errorText.substring(0, 200)
          });
          
          if (!res.headersSent) {
            res.status(response.status).json({ 
              error: response.status === 401 ? 'Unauthorized' : 'Authentication failed',
              message: errorText || response.statusText
            });
          }
          return false;
        }
        
        const result = await response.json() as { authenticated?: boolean; id?: string; roles?: string[] };
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
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e: any) {
      debugLog.error('❌ requireAuth error', {
        error: e.message,
        statusCode: e?.statusCode,
        code: e?.code,
        name: e?.name,
        stack: e?.stack?.substring(0, 500)
      });
      
      // Handle timeout
      if (e.name === 'AbortError' || e.code === 'ETIMEDOUT') {
        if (!res.headersSent) {
          res.status(504).json({ 
            error: 'Gateway Timeout', 
            message: 'Authentication check timed out' 
          });
        }
        return false;
      }
      
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
  
  // SSE endpoint: GET (standard) or POST (some clients may use POST)
  app.get('/mcp/stream/sse', ensureAuth(handleSSE));
  app.post('/mcp/stream/sse', ensureAuth((req, res) => {
    // If POST to SSE endpoint, redirect to StreamableHTTP (correct endpoint)
    const log = cds.log('mcp-proxy/bootstrap');
    log.warn('POST request to SSE endpoint, redirecting to StreamableHTTP', {
      path: req.path,
      originalPath: req.url
    });
    // Rewrite to correct endpoint
    req.url = '/mcp/stream/http';
    return handleStreamHTTP(req, res);
  }));
  
  // StreamableHTTP endpoint: POST only (bidirectional NDJSON streaming)
  app.post('/mcp/stream/http', ensureAuth(handleStreamHTTP));

  log.info('Custom Express endpoints registered', {
    sse: 'GET /mcp/stream/sse',
    streamHttp: 'POST /mcp/stream/http',
    destinationProbe: 'GET /mcp/ProbeDestination?destination=NAME (CAP function)'
  });
});
