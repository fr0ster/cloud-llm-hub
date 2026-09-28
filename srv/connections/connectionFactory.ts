/**
 * Connection Factory Pattern
 * Centralized selection between CloudSdkAbapConnection and base connection
 *
 * This factory chooses the right connection type based on:
 * - Destination name → CloudSdkAbapConnection (BTP Destination Service)
 * - Direct URL + Basic → AdtOnPremConnector, Direct URL + JWT → AdtCloudConnector
 */

import type {
  AbapConnection,
  ILogger,
  SapConfig,
} from '@mcp-abap-adt/connection';
import {
  AdtCloudConnector,
  AdtOnPremConnector,
  BasicAuthProvider,
  CloudHttpTransport,
  OnPremHttpTransport,
  TokenAuthProvider,
} from '@mcp-abap-adt/connection';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import type { ITokenRefresher } from '@mcp-abap-adt/interfaces-auth';
import { loggerAdapter } from '../lib/logger';
import { CloudSdkAbapConnection } from './CloudSdkAbapConnection';

export interface ConnectionOptions {
  /**
   * SAP configuration (URL, auth type, credentials)
   * Required for both connection types
   */
  sapConfig: SapConfig;

  /**
   * BTP Destination name (optional)
   * When provided, CloudSdkAbapConnection will be used
   * When omitted, a direct connector is built (Basic → on-prem, JWT → cloud)
   */
  destinationName?: string;

  /**
   * Logger instance (optional)
   * Used by the direct connectors
   * CloudSdkAbapConnection uses its own logger
   */
  logger?: ILogger;

  /**
   * Session ID (optional)
   * Used by base connection for session management
   */
  sessionId?: string;

  /**
   * Token refresher (optional)
   * Used by JWT connection for token refresh
   */
  tokenRefresher?: ITokenRefresher;
}

/**
 * Factory for creating the correct connection type
 *
 * Decision logic:
 * 1. If destinationName provided → CloudSdkAbapConnection (BTP Destination Service)
 * 2. Otherwise → a direct connector: Basic → AdtOnPremConnector, JWT → AdtCloudConnector
 *
 * @param options - Connection configuration options
 * @returns AbapConnection instance (either CloudSdkAbapConnection or base connection)
 *
 * @example
 * // BTP Destination connection
 * const connection = createConnection({
 *   sapConfig: { url: '', authType: 'jwt' }, // URL not used, comes from Destination
 *   destinationName: 'MY_ABAP_SYSTEM'
 * });
 *
 * @example
 * // Direct Basic auth connection
 * const connection = createConnection({
 *   sapConfig: {
 *     url: 'https://my-abap.com:443',
 *     authType: 'basic',
 *     username: 'USER',
 *     password: 'PASS'
 *   }
 * });
 *
 * @example
 * // Direct JWT connection with session
 * const connection = createConnection({
 *   sapConfig: {
 *     url: 'https://my-abap.com:443',
 *     authType: 'jwt',
 *     jwtToken: 'eyJhbGci...'
 *   },
 *   sessionId: 'my-session-123',
 *   sessionStorage: mySessionStorage
 * });
 */
export function createConnection(options: ConnectionOptions): AbapConnection {
  const { sapConfig, destinationName, logger, sessionId, tokenRefresher } =
    options;

  // Priority 1: Destination-based connection (BTP Cloud)
  if (destinationName) {
    // Use CloudSdkAbapConnection for BTP Destination Service
    // This handles:
    // - Destination resolution via BTP Destination Service
    // - Multiple authentication types (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
    // - Cloud Connector for On-Premise systems
    // - Token management via BTP (automatic, not refresh token - handled by BTP infrastructure)
    return new CloudSdkAbapConnection(sapConfig, destinationName, sessionId);
  }

  // Priority 2: Direct connection (Basic/JWT via axios)
  // This handles:
  // - Direct HTTP connections to ABAP systems
  // - Basic authentication (username/password)
  // - JWT authentication (direct token)

  // Use provided logger or default loggerAdapter from mcp-abap-adt
  const effectiveLogger = logger || loggerAdapter;
  const wire = { client: sapConfig.client, baseUrl: sapConfig.url };

  // The mapping connection 1.x's factory applied (basic → on-prem session
  // protocol, jwt → cloud), now stated here: connection 6.0 removed the factory
  // and takes the system from the caller.
  switch (sapConfig.authType) {
    case 'basic':
      return new AdtOnPremConnector(
        sapConfig,
        new BasicAuthProvider(
          sapConfig.username ?? '',
          sapConfig.password ?? '',
        ),
        new OnPremHttpTransport(() => ({}), effectiveLogger, wire),
        effectiveLogger,
        sessionId,
      );
    case 'jwt':
      return new AdtCloudConnector(
        sapConfig,
        new TokenAuthProvider(tokenRefresher ?? sapConfig.jwtToken ?? ''),
        new CloudHttpTransport(() => ({}), effectiveLogger, wire),
        effectiveLogger,
        sessionId,
      );
    default:
      throw new Error(
        `Unsupported authType "${sapConfig.authType}" for a direct connection; use a BTP destination.`,
      );
  }
}

/**
 * Type guard to check if connection is CloudSdkAbapConnection
 *
 * @param connection - Connection instance to check
 * @returns true if connection is CloudSdkAbapConnection
 */
export function isCloudSdkConnection(
  connection: IAbapConnection,
): connection is CloudSdkAbapConnection {
  return connection instanceof CloudSdkAbapConnection;
}

/**
 * Get connection type name for logging/debugging
 *
 * @param connection - Connection instance
 * @returns Human-readable connection type name
 */
export function getConnectionTypeName(connection: AbapConnection): string {
  if (isCloudSdkConnection(connection)) {
    return 'CloudSdkAbapConnection (BTP Destination)';
  }
  return connection instanceof AdtOnPremConnector
    ? 'AdtOnPremConnector (Direct Basic)'
    : 'AdtCloudConnector (Direct JWT)';
}
