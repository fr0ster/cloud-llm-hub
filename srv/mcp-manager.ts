// Import env setup FIRST to ensure MCP_SKIP_ENV_LOAD is set before submodule imports
import './env-setup';

import type { AbapConnection, SapConfig } from '@mcp-abap-adt/connection';
import { validateAuthHeaders } from '@mcp-abap-adt/header-validator';
import {
  HEADER_AUTHORIZATION,
  HEADER_SAP_CLIENT,
  HEADER_SAP_DESTINATION,
  HEADER_SAP_LOGIN,
  HEADER_SAP_PASSWORD,
} from '@mcp-abap-adt/interfaces';
import { EmbeddableMcpServer } from '@mcp-abap-adt/lib/embeddable';
import { ReadVsGetDedupStrategy } from '@mcp-abap-adt/lib/handlers';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cds from '@sap/cds';
import type { Request } from 'express';
import {
  extractConnectivityContext,
  shouldUseConnectivity,
} from './connections';
import { createConnection } from './connections/connectionFactory';
import {
  type DestinationResolution,
  resolveDestinationSapConfig,
} from './connections/destinationResolver';
import { logErrorSafely } from './lib/errorUtils';
import { describeCaller } from './lib/exposition';
import { maskLoginForLog } from './lib/log-mask';
import { loggerAdapter } from './lib/logger';

interface SapContext {
  sapConfig: SapConfig;
  source: 'headers' | 'destination';
  destination?: DestinationResolution;
}

function summarizeJwt(token?: string): { preview: string; length: number } {
  if (!token) {
    return { preview: 'none', length: 0 };
  }
  const length = token.length;
  if (length <= 40) {
    return {
      preview: `${token.substring(0, Math.min(20, length))}...`,
      length,
    };
  }
  return {
    preview: `${token.substring(0, 20)}...${token.substring(length - 20)}`,
    length,
  };
}

/**
 * Extract SAP configuration from HTTP request headers
 *
 * This function centralizes SAP config extraction logic and uses:
 * - validateAuthHeaders() from @mcp-abap-adt/header-validator for direct connections
 * - resolveDestinationSapConfig() for BTP Destination connections
 *
 * @param req - HTTP request with SAP configuration in headers
 * @returns SAP context with config, source, and optional destination info
 */
export async function extractSapContext(req: Request): Promise<SapContext> {
  const log = cds.log('mcp-manager');
  const destinationName = (
    req.headers[HEADER_SAP_DESTINATION] as string | undefined
  )?.trim();
  const sapClientHeader = (
    req.headers[HEADER_SAP_CLIENT] as string | undefined
  )?.trim();

  // Priority 1: BTP Destination (cloud-llm-hub specific)
  // This is NOT covered by validateAuthHeaders because it requires BTP Destination Service
  if (destinationName) {
    // Extract JWT from Authorization header if available
    // Note: JWT is only used for Principal Propagation destinations (OAuth2SAMLBearerAssertion)
    // For BasicAuthentication and OAuth2ClientCredentials, destination has its own credentials
    const authHeader = req.headers[HEADER_AUTHORIZATION.toLowerCase()] as
      | string
      | undefined;
    const jwtToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : undefined;

    // Check for x-sap-login / x-sap-password for destination with Basic override
    const sapLogin = (
      req.headers[HEADER_SAP_LOGIN] as string | undefined
    )?.trim();
    const sapPassword = (
      req.headers[HEADER_SAP_PASSWORD] as string | undefined
    )?.trim();

    const resolved = await resolveDestinationSapConfig(
      destinationName,
      jwtToken,
    );
    const sapConfig: SapConfig = { ...resolved.sapConfig };

    const destinationRequiresUserCredentials =
      (resolved.proxyType ?? '').toLowerCase() === 'onpremise' ||
      resolved.authenticationType === 'NoAuthentication';

    if (destinationRequiresUserCredentials && (!sapLogin || !sapPassword)) {
      const error = new Error(
        `Destination "${destinationName}" requires SAP username and password. ` +
          'Provide x-sap-login and x-sap-password headers.',
      ) as Error & { statusCode?: number; code?: string };
      error.statusCode = 401;
      error.code = 'SAP_CREDENTIALS_REQUIRED';
      throw error;
    }

    // Override with Basic auth from headers if provided
    if (sapLogin && sapPassword) {
      sapConfig.authType = 'basic';
      sapConfig.username = sapLogin;
      sapConfig.password = sapPassword;
      delete sapConfig.jwtToken;
      log.info('Destination auth overridden with x-sap-login/x-sap-password', {
        destination: destinationName,
        username: maskLoginForLog(sapLogin),
      });
    }

    if (sapClientHeader) {
      sapConfig.client = sapClientHeader;
    }

    const { preview, length } = summarizeJwt(sapConfig.jwtToken);
    log.info('SAP config resolved from destination', {
      destination: resolved.destinationName,
      proxyType: resolved.proxyType ?? 'Internet',
      authType: sapConfig.authType,
      client: sapConfig.client || 'none',
      tokenPreview: preview,
      tokenLength: length,
    });

    return {
      sapConfig,
      source: 'destination',
      destination: resolved,
    };
  }

  // Priority 2: Direct connection (Basic/JWT) - use validateAuthHeaders
  // This centralizes header validation logic from mcp-abap-adt
  const validationResult = validateAuthHeaders(req.headers);

  // Log validation warnings
  if (validationResult.warnings.length > 0) {
    log.debug('Header validation warnings', {
      warnings: validationResult.warnings,
    });
  }

  // Check validation errors
  if (!validationResult.isValid || !validationResult.config) {
    const errorMessages = validationResult.errors.join('; ');
    log.error('Header validation failed', {
      errors: validationResult.errors,
      availableHeaders: Object.keys(req.headers).filter((h) =>
        h.toLowerCase().includes('sap'),
      ),
    });
    throw new Error(`Invalid authentication headers: ${errorMessages}`);
  }

  // Extract config from validation result
  const config = validationResult.config;

  // Build SapConfig from validated headers
  const sapConfig: SapConfig = {
    url: config.sapUrl || '',
    authType: (config.authType === 'xsuaa'
      ? 'jwt'
      : config.authType) as SapConfig['authType'],
  };

  // Add client if provided
  if (sapClientHeader) {
    sapConfig.client = sapClientHeader;
  } else if (config.sapClient) {
    sapConfig.client = config.sapClient;
  }

  // Add credentials based on auth type
  if (config.authType === 'basic') {
    if (!config.username || !config.password) {
      throw new Error('Basic auth requires username and password');
    }
    sapConfig.username = config.username;
    sapConfig.password = config.password;
  } else if (config.authType === 'jwt' || config.authType === 'xsuaa') {
    if (!config.jwtToken) {
      throw new Error('JWT auth requires JWT token');
    }
    sapConfig.jwtToken = config.jwtToken;

    // NOTE: cloud-llm-hub does NOT support token refresh for direct connections
    // Clients must refresh tokens themselves and send new JWT token in each request
    // For BTP Destinations, token management is automatic via BTP
  }

  const { preview, length } = summarizeJwt(sapConfig.jwtToken);
  log.info('SAP config extracted from headers (via validateAuthHeaders)', {
    url: sapConfig.url,
    authType: sapConfig.authType,
    client: sapConfig.client || 'none',
    tokenPreview: preview,
    tokenLength: length,
  });

  return {
    sapConfig,
    source: 'headers',
  };
}

/**
 * Result of creating MCP server for a single request
 */
export interface McpServerResult {
  /** EmbeddableMcpServer instance */
  server: EmbeddableMcpServer;
  /** Connection used by this server */
  connection: AbapConnection;
  /** Transport for handling the request */
  transport: StreamableHTTPServerTransport;
  /** Cleanup function - MUST be called after request completes */
  cleanup: () => Promise<void>;
}

/**
 * Create MCP server instance for a single HTTP request
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
 * @param req - HTTP request with SAP configuration in headers
 * @param opts.establish - Whether to open the ABAP connection now. `connect()`
 *   is the establishing call, so it COSTS ONE SAP SESSION — pass false for
 *   JSON-RPC methods that never reach SAP (`initialize`, `tools/list`, `ping`,
 *   notifications). An MCP client that pings every 10s would otherwise log on
 *   and off every 10s. Defaults to true so any caller that does not classify
 *   its request keeps the old, always-connect behaviour.
 * @returns MCP server, connection, transport, and cleanup function
 */
export async function createMCPServerForRequest(
  req: Request,
  opts: { establish?: boolean } = {},
): Promise<McpServerResult> {
  const establish = opts.establish !== false;
  const log = cds.log('mcp-manager');

  try {
    const sapContext = await extractSapContext(req);
    const { sapConfig, destination } = sapContext;

    const connectivityFromHeader = shouldUseConnectivity(req);
    const destinationRequiresConnectivity =
      (destination?.proxyType ?? '').toLowerCase() === 'onpremise';
    const useConnectivity =
      connectivityFromHeader || destinationRequiresConnectivity;
    const connectivityContext = extractConnectivityContext(req);

    if (
      !connectivityContext.locationId &&
      destination?.cloudConnectorLocationId
    ) {
      connectivityContext.locationId = destination.cloudConnectorLocationId;
    }

    log.info('Creating new MCP server for request', {
      sapUrl: sapConfig.url,
      authType: sapConfig.authType,
      destination: destination?.destinationName ?? 'none',
      useConnectivity,
    });

    // Create NEW connection for this request
    const connection = createConnection({
      sapConfig,
      destinationName: destination?.destinationName,
    });
    try {
      // Only when this request actually reaches SAP. EmbeddableMcpServer's
      // constructor merely stores the connection (its handler registry is built
      // from a null-connection context), and the wrapper lambdas call
      // getConnection() lazily — so an unconnected connection is safe to inject
      // and costs nothing on the ABAP side.
      if (establish) await connection.connect();
    } catch (connectErr) {
      const error = new Error(
        `SAP connection failed for destination "${destination?.destinationName ?? 'none'}": ${
          connectErr instanceof Error ? connectErr.message : String(connectErr)
        }`,
      ) as Error & { statusCode?: number; code?: string };
      error.statusCode = 401;
      error.code = 'SAP_CREDENTIALS_FAILED';
      throw error;
    }

    log.debug('Connection created', {
      connectionType: connection.constructor.name,
      destinationName: destination?.destinationName,
      authType: sapConfig.authType,
    });

    // Resolve exposition from CAP auth (cds.context.user). `describeCaller`
    // reports WHO as well as WHAT, because the two are routinely confused: a
    // technical token runs as `system` with the client's own scopes, so a human
    // holding every role collection can still arrive here as reader-only.
    const caller = describeCaller(cds.context?.user);
    const exposition = caller.exposition;

    if (exposition.length === 0) {
      throw new Error(
        caller.technical
          ? `Access denied: authenticated as technical client "${caller.id}" (client_credentials), which holds no MCP scope. A human's role collections do not apply to a technical token.`
          : 'Access denied: user has no MCP roles assigned',
      );
    }

    log.info('Resolved MCP exposition for caller', caller);

    // Create NEW EmbeddableMcpServer with injected connection.
    // systemType derived from destination.proxyType so onprem-only tools
    // (e.g., CreateProgram) are exposed when the destination is a Cloud
    // Connector link, without mutating the global SAP_SYSTEM_TYPE env var.
    const systemType: 'onprem' | 'cloud' =
      (destination?.proxyType ?? '').toLowerCase() === 'onpremise'
        ? 'onprem'
        : 'cloud';
    const mcpServer = new EmbeddableMcpServer({
      connection,
      logger: loggerAdapter,
      exposition,
      systemType,
      readOnlyDedupStrategy: new ReadVsGetDedupStrategy(),
    });

    // Create NEW transport for this request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true,
      allowedOrigins: undefined,
      allowedHosts: undefined,
      enableDnsRebindingProtection: false,
    });

    // Connect transport to MCP server
    await mcpServer.connect(transport);

    log.info('MCP server created for request', {
      connectionType: connection.constructor.name,
      hasDestination: !!destination?.destinationName,
    });

    // Cleanup function - MUST be called after request completes
    const cleanup = async () => {
      try {
        await transport.close();
      } catch (err) {
        log.warn('Failed to close transport during cleanup', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        // End the server-side ADT stateful session (releases a left-open
        // edit-lock), then reset local state. Both exist in the implementation
        // but not the interface, so use type assertions.
        await (
          connection as { closeSession?: () => Promise<void> }
        ).closeSession?.();
        (connection as { reset?: () => void }).reset?.();
      } catch (err) {
        log.warn('Failed to reset connection during cleanup', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    return {
      server: mcpServer,
      connection,
      transport,
      cleanup,
    };
    // biome-ignore lint/suspicious/noExplicitAny: Error type from MCP server creation is not fully typed
  } catch (err: any) {
    // biome-ignore lint/suspicious/noExplicitAny: Context can contain any values
    const context: Record<string, any> = {
      destination: (req.headers[HEADER_SAP_DESTINATION] as string) || undefined,
    };

    logErrorSafely(log, 'MCP server creation', err, context);

    if (err instanceof Error) {
      const errWithCode = err as Error & { statusCode?: number; code?: string };
      errWithCode.statusCode = errWithCode.statusCode || 502;
      errWithCode.code =
        errWithCode.code || err?.name || 'MCP_SERVER_CREATION_FAILED';
    }

    throw err;
  }
}
