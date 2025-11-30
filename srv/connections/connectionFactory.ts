/**
 * Connection Factory Pattern
 * Centralized selection between CloudSdkAbapConnection and base connection
 * 
 * This factory chooses the right connection type based on:
 * - Destination name → CloudSdkAbapConnection (BTP Destination Service)
 * - Direct URL + Basic/JWT → createAbapConnection from @mcp-abap-adt/connection
 */

import type { AbapConnection, SapConfig, ILogger, ISessionStorage } from '@mcp-abap-adt/connection';
import { createAbapConnection } from '@mcp-abap-adt/connection';
import { CloudSdkAbapConnection } from './CloudSdkAbapConnection';
import { loggerAdapter } from '@fr0ster/mcp-abap-adt/dist/lib/loggerAdapter';

export interface ConnectionOptions {
  /**
   * SAP configuration (URL, auth type, credentials)
   * Required for both connection types
   */
  sapConfig: SapConfig;
  
  /**
   * BTP Destination name (optional)
   * When provided, CloudSdkAbapConnection will be used
   * When omitted, createAbapConnection will be used (Direct Basic/JWT)
   */
  destinationName?: string;
  
  /**
   * Logger instance (optional)
   * Used by base connection (createAbapConnection)
   * CloudSdkAbapConnection uses its own logger
   */
  logger?: ILogger;
  
  /**
   * Session storage (optional)
   * Used by base connection for stateful sessions
   */
  sessionStorage?: ISessionStorage;
  
  /**
   * Session ID (optional)
   * Used by base connection for session management
   */
  sessionId?: string;
}

/**
 * Factory for creating the correct connection type
 * 
 * Decision logic:
 * 1. If destinationName provided → CloudSdkAbapConnection (BTP Destination Service)
 * 2. Otherwise → createAbapConnection (Direct Basic/JWT via axios)
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
  const { sapConfig, destinationName, logger, sessionStorage, sessionId } = options;
  
  // Priority 1: Destination-based connection (BTP Cloud)
  if (destinationName) {
    // Use CloudSdkAbapConnection for BTP Destination Service
    // This handles:
    // - Destination resolution via BTP Destination Service
    // - Multiple authentication types (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
    // - Cloud Connector for On-Premise systems
    // - Automatic token refresh via BTP
    return new CloudSdkAbapConnection(sapConfig, destinationName);
  }
  
  // Priority 2: Direct connection (Basic/JWT via axios)
  // This handles:
  // - Direct HTTP connections to ABAP systems
  // - Basic authentication (username/password)
  // - JWT authentication (direct token)
  
  // Use provided logger or default loggerAdapter from mcp-abap-adt
  const effectiveLogger = logger || loggerAdapter;
  
  return createAbapConnection(sapConfig, effectiveLogger, sessionStorage, sessionId);
}

/**
 * Type guard to check if connection is CloudSdkAbapConnection
 */
export function isCloudSdkConnection(connection: AbapConnection): connection is CloudSdkAbapConnection {
  return connection instanceof CloudSdkAbapConnection;
}

/**
 * Get connection type name for logging/debugging
 */
export function getConnectionTypeName(connection: AbapConnection): string {
  if (isCloudSdkConnection(connection)) {
    return 'CloudSdkAbapConnection (BTP Destination)';
  }
  return 'BaseAbapConnection (Direct Basic/JWT)';
}
