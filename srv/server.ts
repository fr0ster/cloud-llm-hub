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
import { getMCPServer } from './mcp-manager';
import { Readable } from 'stream';

/**
 * AuthShim - Universal middleware for Basic (dev) and Bearer (prod) authorization
 */
async function authShim(req: Request, res: Response, next: NextFunction): Promise<void> {
  const log = cds.log('mcp-proxy/authShim');
  const hdr = req.headers.authorization || '';

  try {
    // Basic auth for development
    if (hdr.startsWith('Basic ')) {
      const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
      const [user] = decoded.split(':');
      const username = user || 'anonymous';
      
      log.debug('Basic auth detected', { username });
      
      let roles = ['MCP_Connector'];
      if (username === 'alice') {
        roles = ['MCP_Connector', 'MCP_Admin'];
      }
      
      (req as any).user = new cds.User({ id: username, roles, attr: {} });
      return next();
    }

    // Bearer JWT for production
    if (hdr.startsWith('Bearer ')) {
      const token = hdr.slice(7);
      
      let xsuaa;
      try {
        const xsenv = require('@sap/xsenv');
        xsuaa = xsenv.getServices({ uaa: { tag: 'xsuaa' } }).uaa;
      } catch (err) {
        log.warn('No XSUAA binding found');
        throw new Error('Missing XSUAA binding in production mode');
      }

      const xssec = require('@sap/xssec');
      const sc: any = await new Promise((resolve, reject) => {
        xssec.createSecurityContext(token, xsuaa, (err: Error, ctx: any) => {
          if (err) reject(err);
          else resolve(ctx);
        });
      });

      const scopes = new Set(sc.getScopes() || []);
      const xsappname = xsuaa.xsappname;
      const roles: string[] = [];

      if (scopes.has(`${xsappname}.MCP_Connect`)) roles.push('MCP_Connector');
      if (scopes.has(`${xsappname}.MCP_Read`)) roles.push('MCP_Connector');
      if (scopes.has(`${xsappname}.MCP_Admin`)) roles.push('MCP_Admin');

      (req as any).user = new cds.User({ id: sc.getLogonName(), roles, attr: {} });
      return next();
    }

    log.warn('Unauthorized - no valid auth header');
    res.status(401).send('Unauthorized: Missing or invalid Authorization header');
  } catch (err: any) {
    log.error('Authorization failed', err);
    res.status(401).send(`Unauthorized: ${err.message}`);
  }
}

/**
 * SSE endpoint handler - proxies to embedded MCP server
 */
async function handleSSE(req: Request, res: Response): Promise<any> {
  const log = cds.log('mcp-proxy/sse');
  const user = (req as any).user;

  if (!user || !user.is('MCP_Connector')) {
    log.warn('Access denied - missing MCP_Connector role', { user: user?.id });
    return res.status(403).send('Forbidden: MCP_Connector role required');
  }

  log.info('SSE connection opened', { user: user.id });

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
    
    log.info('SSE session established', { user: user.id, sessionId });

    // Send endpoint event to establish connection
    res.write(`event: endpoint\n`);
    res.write(`data: /message\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      res.end();
      log.info('SSE client disconnected', { user: user.id, sessionId });
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
  const user = (req as any).user;

  if (!user || !user.is('MCP_Connector')) {
    log.warn('Access denied', { user: user?.id });
    return res.status(403).send('Forbidden: MCP_Connector role required');
  }

  log.info('Stream-HTTP connection opened', { user: user.id });

  try {
    // Get embedded MCP server instance (created per-request with SAP config from headers)
    const mcpServer = await getMCPServer(req);
    
    if (!mcpServer || !mcpServer.transport) {
      log.error('MCP transport not initialized');
      return res.status(503).send('Service Unavailable: MCP transport not ready');
    }

    // Delegate to MCP SDK transport - це робить всю роботу за нас!
    await mcpServer.transport.handleRequest(req, res);
    
    log.info('Stream-HTTP request handled', { user: user.id });

  } catch (err: any) {
    log.error('Stream-HTTP handler error', err);
    if (!res.headersSent) {
      return res.status(500).send(`Internal Server Error: ${err.message}`);
    }
  }
}

/**
 * Bootstrap: Register custom streaming endpoints
 */
cds.on('bootstrap', (app: Application) => {
  const log = cds.log('mcp-proxy/bootstrap');
  log.info('Registering custom streaming endpoints');

  app.get('/mcp/stream/sse', authShim, handleSSE);
  app.post('/mcp/stream/http', authShim, handleStreamHTTP);

  log.info('Streaming endpoints registered', {
    sse: 'GET /mcp/stream/sse',
    streamHttp: 'POST /mcp/stream/http'
  });
});
