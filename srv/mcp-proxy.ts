import cds, { type Request, type Service } from '@sap/cds';
import { getDestination } from '@sap-cloud-sdk/connectivity';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';

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
export default async function registerMcpProxyHandlers(
  srv: Service,
): Promise<void> {
  const log = cds.log('mcp-proxy');
  log.info('🔥🔥🔥 REGISTERING McpProxyService handlers', {
    serviceName: srv.name,
    hasService: !!srv,
  });

  // Health check endpoint
  srv.on('Health', async (req: Request) => {
    const now = new Date().toISOString();
    const user = req.user as { id?: string; roles?: string[] } | undefined;
    log.info('🔥 Health check handler CALLED', {
      now,
      hasUser: !!req.user,
      userId: user?.id,
      userRoles: user?.roles,
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
    const reqData = req.data as { destination?: string } | undefined;
    const reqQuery = req.query as
      | { destination?: string; name?: string }
      | undefined;
    const destination =
      reqData?.destination || reqQuery?.destination || reqQuery?.name;

    if (!destination || typeof destination !== 'string') {
      const error = new Error(
        'Query parameter "destination" (or "name") is required.',
      );
      (error as Error & { statusCode?: number }).statusCode = 400;
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
      const connectivityMode =
        proxyType.toLowerCase() === 'onpremise' ? 'onprem' : 'internet';
      const authentication = destinationConfig.authentication || 'Unknown';

      // Get sap-client from destination if available
      const originalProps = destinationConfig.originalProperties as
        | Record<string, unknown>
        | undefined;
      const sapClient =
        (originalProps?.['sap-client'] as string) ||
        (originalProps?.['SAP-Client'] as string) ||
        '';
      const cloudConnectorLocationId =
        (originalProps?.CloudConnectorLocationId as string) || '';

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
          },
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
        // biome-ignore lint/suspicious/noExplicitAny: SAP Cloud SDK error type is not fully typed
      } catch (error: any) {
        // executeHttpRequest throws errors with response object for HTTP errors
        // Extract status from error response
        if (error.response) {
          // HTTP error response (4xx, 5xx) - this is actually OK for probe
          status = error.response.status;
          statusText = error.response.statusText || error.message || 'Error';
          const errorHeaders = error.response.headers || {};
          contentType =
            errorHeaders['content-type'] || errorHeaders['Content-Type'] || '';

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
      // biome-ignore lint/suspicious/noExplicitAny: Error type from executeHttpRequest is not fully typed
    } catch (error: any) {
      // Use synchronized error handling from errorUtils
      // In development (cds watch), TypeScript files are executed directly, so use .ts extension
      // In production (compiled), files are .js
      // Try .ts first (development), fallback to .js (production)
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic import result type is not fully typed
      let errorUtils: any;
      try {
        errorUtils = await import('./lib/errorUtils');
      } catch {
        errorUtils = await import('./lib/errorUtils.js');
      }
      const { logErrorSafely } = errorUtils;
      logErrorSafely(log, 'Destination probe', error, {
        destination: destinationName,
      });
      throw error;
    }
  });

  // List all SAP destinations with reachability status
  srv.on('ListDestinations', async (_req: Request) => {
    const { getAvailableDestinations } = await import('./lib/btp-destinations');

    const destinations = await getAvailableDestinations();
    const now = new Date().toISOString();

    // Probe all destinations in parallel
    const results = await Promise.all(
      destinations.map(async (dest) => {
        try {
          const destConfig = await getDestination({
            destinationName: dest.name,
          });
          if (!destConfig) {
            return {
              name: dest.name,
              url: dest.url,
              authentication: dest.authentication,
              proxyType: dest.proxyType,
              reachable: false,
              error: 'Destination not found in Destination service',
              probeStatus: 0,
              probeStatusText: '',
              timestamp: now,
            };
          }

          const originalProps = destConfig.originalProperties as
            | Record<string, unknown>
            | undefined;
          const sapClient =
            (originalProps?.['sap-client'] as string) ||
            (originalProps?.['SAP-Client'] as string) ||
            '';

          try {
            const response = await executeHttpRequest(
              { destinationName: dest.name },
              {
                method: 'GET',
                url: '/',
                headers: sapClient ? { 'X-SAP-Client': sapClient } : {},
              },
            );
            return {
              name: dest.name,
              url: dest.url,
              authentication: dest.authentication,
              proxyType: dest.proxyType,
              reachable: true,
              error: '',
              probeStatus: response.status || 200,
              probeStatusText: response.statusText || 'OK',
              timestamp: now,
            };
            // biome-ignore lint/suspicious/noExplicitAny: SAP Cloud SDK error type
          } catch (probeErr: any) {
            const status =
              probeErr.response?.status || probeErr.statusCode || 0;
            // HTTP 401/403/404 means destination is reachable but auth/path issue
            const reachable = status >= 200 && status < 500;
            return {
              name: dest.name,
              url: dest.url,
              authentication: dest.authentication,
              proxyType: dest.proxyType,
              reachable,
              error: reachable ? '' : probeErr.message || 'Connection failed',
              probeStatus: status,
              probeStatusText:
                probeErr.response?.statusText || probeErr.message || 'Error',
              timestamp: now,
            };
          }
          // biome-ignore lint/suspicious/noExplicitAny: Error type
        } catch (err: any) {
          return {
            name: dest.name,
            url: dest.url,
            authentication: dest.authentication,
            proxyType: dest.proxyType,
            reachable: false,
            error: err.message || 'Unknown error',
            probeStatus: 0,
            probeStatusText: '',
            timestamp: now,
          };
        }
      }),
    );

    log.info('ListDestinations completed', {
      total: results.length,
      reachable: results.filter((r) => r.reachable).length,
      unreachable: results.filter((r) => !r.reachable).length,
    });

    return results;
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
