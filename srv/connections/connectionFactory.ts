/**
 * Connection Factory Pattern
 * Centralized selection between CloudSdkAbapConnection and base connection
 *
 * This factory chooses the right connection type based on:
 * - Destination name → CloudSdkAbapConnection (BTP Destination Service)
 * - Direct URL → the connector for the DECLARED system kind (`x-sap-system-type`,
 *   default on-premise): cloud → AdtCloudConnector, otherwise AdtOnPremConnector
 */

import {
  BasicAuthProvider,
  TokenAuthProvider,
} from '@mcp-abap-adt/auth-providers';
import type {
  AbapConnection,
  ILogger,
  SapConfig,
} from '@mcp-abap-adt/connection';
import {
  AdtOnPremConnector,
  CloudHttpTransport,
  OnPremHttpTransport,
} from '@mcp-abap-adt/connection';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import { loggerAdapter } from '../lib/logger';
import type { SystemType } from '../lib/system-type';
import { CloudSdkAbapConnection } from './CloudSdkAbapConnection';
import { HubCloudConnector, HubOnPremConnector } from './directConnectors';

interface CommonConnectionOptions {
  /**
   * SAP configuration (URL, auth type, credentials)
   * Required for both connection types
   */
  sapConfig: SapConfig;

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
}

/**
 * A BTP destination (→ CloudSdkAbapConnection), or a direct connection that
 * states the system it dials (→ the connector for that kind). The kind comes
 * from `resolveSystemType` (`lib/system-type.ts`) and is required for a direct
 * connection: the connector class IS the declaration, so it is never guessed
 * from the authentication.
 */
export type ConnectionOptions =
  | (CommonConnectionOptions & {
      /** BTP Destination name → CloudSdkAbapConnection. */
      destinationName: string;
      systemType?: never;
    })
  | (CommonConnectionOptions & {
      destinationName?: undefined;
      /** `cloud` → AdtCloudConnector; `onprem` / `legacy` → AdtOnPremConnector. */
      systemType: SystemType;
    });

/**
 * Factory for creating the correct connection type
 *
 * Decision logic:
 * 1. If destinationName provided → CloudSdkAbapConnection (BTP Destination Service)
 * 2. Otherwise → a direct connector for the declared kind: `cloud` →
 *    AdtCloudConnector, `onprem` / `legacy` → AdtOnPremConnector. The
 *    credential follows the auth type and decides nothing else: Basic →
 *    BasicAuthProvider, JWT → a fixed TokenAuthProvider (the hub holds no
 *    refresher; a client sends a valid token on every request).
 *
 * @param options - Connection configuration options
 * @returns AbapConnection instance (either CloudSdkAbapConnection or a direct connector)
 *
 * @example
 * // BTP Destination connection
 * const connection = createConnection({
 *   sapConfig: { url: '', authType: 'jwt' }, // URL not used, comes from Destination
 *   destinationName: 'MY_ABAP_SYSTEM'
 * });
 *
 * @example
 * // Direct Basic auth connection to an on-premise system
 * const connection = createConnection({
 *   sapConfig: {
 *     url: 'https://my-abap.com:443',
 *     authType: 'basic',
 *     username: 'USER',
 *     password: 'PASS'
 *   },
 *   systemType: 'onprem'
 * });
 */
export function createConnection(options: ConnectionOptions): AbapConnection {
  const { sapConfig, logger, sessionId } = options;

  // Priority 1: Destination-based connection (BTP Cloud)
  if (options.destinationName) {
    // Use CloudSdkAbapConnection for BTP Destination Service
    // This handles:
    // - Destination resolution via BTP Destination Service
    // - Multiple authentication types (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
    // - Cloud Connector for On-Premise systems
    // - Token management via BTP (automatic, not refresh token - handled by BTP infrastructure)
    return new CloudSdkAbapConnection(
      sapConfig,
      options.destinationName,
      sessionId,
    );
  }

  // Priority 2: Direct connection (Basic/JWT via axios)
  // Use provided logger or default loggerAdapter from mcp-abap-adt
  const effectiveLogger = logger || loggerAdapter;
  const wire = { client: sapConfig.client, baseUrl: sapConfig.url };

  let credential: BasicAuthProvider | TokenAuthProvider;
  switch (sapConfig.authType) {
    case 'basic':
      credential = new BasicAuthProvider(
        sapConfig.username ?? '',
        sapConfig.password ?? '',
      );
      break;
    case 'jwt':
      credential = TokenAuthProvider.fixed(sapConfig.jwtToken ?? '');
      break;
    default:
      throw new Error(
        `Unsupported authType "${sapConfig.authType}" for a direct connection; use a BTP destination.`,
      );
  }

  // Taking the connector class is how @mcp-abap-adt/connection is told which
  // system it dials (its session protocol and logoff): the declared kind
  // picks it, never the credential. The Hub* subclasses add one guarantee:
  // their teardown (`endSession`) waits for an open critical section.
  return options.systemType === 'cloud'
    ? new HubCloudConnector(
        sapConfig,
        credential,
        new CloudHttpTransport(() => ({}), effectiveLogger, wire),
        effectiveLogger,
        sessionId,
      )
    : new HubOnPremConnector(
        sapConfig,
        credential,
        new OnPremHttpTransport(() => ({}), effectiveLogger, wire),
        effectiveLogger,
        sessionId,
      );
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
 * Whether the connection is one of the hub's direct connectors (an `x-sap-url`
 * request). Those end their session with `endSession()` — the logoff, sent
 * only after any open critical section has ended; they have no `closeSession`.
 */
export function isDirectConnector(
  connection: IAbapConnection,
): connection is HubOnPremConnector | HubCloudConnector {
  return (
    connection instanceof HubOnPremConnector ||
    connection instanceof HubCloudConnector
  );
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
    ? 'AdtOnPremConnector (Direct, on-premise)'
    : 'AdtCloudConnector (Direct, ABAP Cloud)';
}
