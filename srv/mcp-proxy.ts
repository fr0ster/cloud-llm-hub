import cds, { Request, Service } from '@sap/cds';
import { probeDestinationConnection } from './server';

interface ProxyInvocation {
  toolId: string;
  mode?: 'sse' | 'stream-http';
  payload?: string;
}

const DEFAULT_MODE: 'sse' | 'stream-http' = 'stream-http';

/**
 * NOTE: This file contains CAP service handlers for OData endpoints.
 * Custom Express routes (non-CAP endpoints) with embedded MCP server
 * are implemented in server.ts
 */

/**
 * CAP service handler for McpProxyService.
 * CAP enforces the `@requires: 'MCP_Connector'` annotation defined in the CDS model.
 */
export default async function registerMcpProxyHandlers(srv: Service): Promise<void> {
  const log = cds.log('mcp-proxy');
  log.info('🔥🔥🔥 REGISTERING McpProxyService handlers', { 
    serviceName: srv.name,
    hasService: !!srv
  });

  // Health check endpoint
  srv.on('Health', async (req: Request) => {
    const now = new Date().toISOString();
    log.info('🔥 Health check handler CALLED', { 
      now, 
      hasUser: !!req.user, 
      userId: (req.user as any)?.id,
      userRoles: (req.user as any)?.roles
    });

    return {
      status: 'UP',
      timestamp: now,
    };
  });

  // Probe destination endpoint (CAP function)
  srv.on('ProbeDestination', async (req: Request) => {
    // CAP functions receive parameters via req.data
    const destination = (req.data as any)?.destination 
      || (req.query as any)?.destination 
      || (req.query as any)?.name;
    
    if (!destination || typeof destination !== 'string') {
      const error = new Error('Query parameter "destination" (or "name") is required.');
      (error as any).statusCode = 400;
      throw error;
    }

    const destinationName = destination.trim();
    const user = req.user;
    
    log.info('Probing destination via CAP service', { 
      destination: destinationName, 
      user: user?.id 
    });

    try {
      log.debug('Starting destination resolution', { destination: destinationName });
      const { summary, metadata } = await probeDestinationConnection(destinationName);
      log.debug('Destination probe successful', { 
        destination: destinationName, 
        status: summary.status 
      });

      return {
        destination: destinationName,
        connectivity: metadata.connectivityMode,
        proxyType: metadata.proxyType,
        authentication: metadata.authentication || '',
        sapClient: metadata.sapClient || '',
        cloudConnectorLocationId: metadata.cloudConnectorLocationId || '',
        tokenExpiresAt: metadata.tokenExpiresAt || 0,
        probe: {
          status: summary.status ?? 0,
          statusText: summary.statusText || '',
          contentType: summary.contentType || ''
        },
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Destination probe failed', { 
        destination: destinationName, 
        error: message,
        errorName: error?.name,
        errorCode: error?.code
      });
      throw error;
    }
  });

  // Legacy action for backward compatibility
  srv.on('InvokeTool', async (req: Request<ProxyInvocation>) => {
    const { toolId, mode = DEFAULT_MODE } = req.data;

    log.info('Proxy request received', { toolId, mode });

    return {
      status: 'DEPRECATED',
      mode,
      message: 'Use /mcp/stream/sse or /mcp/stream/http endpoints instead.',
      receivedAt: new Date().toISOString(),
    };
  });
}

// CommonJS compatibility for CAP
module.exports = registerMcpProxyHandlers;
