import cds, { Request, Service } from '@sap/cds';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { getDestination } from '@sap-cloud-sdk/connectivity';

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
    hasService: !!srv,
  });

  // Health check endpoint
  srv.on('Health', async (req: Request) => {
    const now = new Date().toISOString();
    log.info('🔥 Health check handler CALLED', {
      now,
      hasUser: !!req.user,
      userId: (req.user as any)?.id,
      userRoles: (req.user as any)?.roles,
    });

    return {
      status: 'UP',
      timestamp: now,
    };
  });

  // Probe destination endpoint (CAP function)
  // Uses executeHttpRequest from SAP Cloud SDK - direct destination handling
  srv.on('ProbeDestination', async (req: Request) => {
    // CAP functions receive parameters via req.data or req.query
    const destination =
      (req.data as any)?.destination || (req.query as any)?.destination || (req.query as any)?.name;

    if (!destination || typeof destination !== 'string') {
      const error = new Error('Query parameter "destination" (or "name") is required.');
      (error as any).statusCode = 400;
      throw error;
    }

    const destinationName = destination.trim();
    const user = req.user;

    log.info('Probing destination via executeHttpRequest', {
      destination: destinationName,
      user: user?.id,
    });

    try {
      // Get destination metadata first (for proxyType, authentication, etc.)
      const destinationConfig = await getDestination({ destinationName });
      if (!destinationConfig) {
        throw new Error(`Destination "${destinationName}" not found.`);
      }

      const proxyType = destinationConfig.proxyType
        ? String(destinationConfig.proxyType)
        : 'Internet';
      const connectivityMode = proxyType.toLowerCase() === 'onpremise' ? 'onprem' : 'internet';
      const authentication = destinationConfig.authentication || 'Unknown';

      // Get sap-client from destination if available
      const sapClient =
        (destinationConfig.originalProperties as any)?.['sap-client'] ||
        (destinationConfig.originalProperties as any)?.['SAP-Client'] ||
        '';
      const cloudConnectorLocationId =
        (destinationConfig.originalProperties as any)?.['CloudConnectorLocationId'] || '';

      let status: number | undefined;
      let statusText: string | undefined;
      let contentType: string | undefined;

      // Use executeHttpRequest directly - it handles everything automatically:
      // - Destination resolution (URL, credentials)
      // - Authentication (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
      // - Proxy configuration (including Cloud Connector for on-premise)
      // - Token refresh
      try {
        log.debug('Calling executeHttpRequest with destination', {
          destinationName,
          proxyType,
          authentication,
        });

        // Use a simple endpoint to test connectivity
        // For ABAP systems, we can use root path or a simple OData endpoint
        const response = await executeHttpRequest(
          { destinationName },
          {
            method: 'GET',
            url: '/',
            headers: sapClient ? { 'X-SAP-Client': sapClient } : {},
          }
        );

        // executeHttpRequest returns response with status, statusText, headers, data
        status = response.status || 200;
        statusText = response.statusText || 'OK';

        const headers = response.headers || {};
        contentType = headers['content-type'] || headers['Content-Type'] || '';

        log.debug('Destination probe successful', {
          destinationName,
          status,
          contentType,
        });
      } catch (error: any) {
        // executeHttpRequest throws errors with response object for HTTP errors
        // Extract status from error response
        if (error.response) {
          // HTTP error response (4xx, 5xx) - this is actually OK for probe
          status = error.response.status;
          statusText = error.response.statusText || error.message || 'Error';
          const errorHeaders = error.response.headers || {};
          contentType = errorHeaders['content-type'] || errorHeaders['Content-Type'] || '';

          log.debug('Destination probe returned status (expected for probe)', {
            destinationName,
            status,
            statusText,
          });
        } else if (error.statusCode || error.code) {
          // Other error with status code
          status = error.statusCode || (error.code === 'ENOTFOUND' ? 404 : 500);
          statusText = error.message || 'Error';
          contentType = '';

          log.warn('Destination probe failed with status code', {
            destinationName,
            status,
            statusText,
            errorName: error.name,
            errorCode: error.code,
          });
        } else {
          // Unexpected error - re-throw
          log.error('Destination probe failed with unexpected error', {
            destinationName,
            error: error.message,
            errorName: error.name,
            errorCode: error.code,
            stack: error.stack?.substring(0, 500),
          });
          throw error;
        }
      }

      log.debug('Destination probe completed', {
        destination: destinationName,
        status,
      });

      return {
        destination: destinationName,
        connectivity: connectivityMode,
        proxyType: proxyType,
        authentication: authentication || '',
        sapClient: sapClient || '',
        cloudConnectorLocationId: cloudConnectorLocationId || '',
        tokenExpiresAt: 0, // Cloud SDK manages token lifecycle internally
        probe: {
          status: status ?? 0,
          statusText: statusText || '',
          contentType: contentType || '',
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      // Use synchronized error handling from errorUtils
      const { logErrorSafely } = await import('./lib/errorUtils.js');
      logErrorSafely(log, 'Destination probe', error, {
        destination: destinationName,
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
