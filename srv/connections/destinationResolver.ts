import { getDestination } from '@sap-cloud-sdk/connectivity';
import type { Destination } from '@sap-cloud-sdk/connectivity';
import type { SapConfig } from '@mcp-abap-adt/connection';

// Helper to extract JWT from request headers if available
function extractJwtFromRequest(req?: any): string | undefined {
  if (!req) return undefined;
  const authHeader = req.headers?.authorization || req.get?.('authorization');
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return undefined;
}

// Ensure VCAP_SERVICES is loaded from default-env.json for local development
// CAP loads it automatically, but we ensure it's available for SAP Cloud SDK
if (!process.env.VCAP_SERVICES && process.env.VCAP_APPLICATION === undefined) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const xsenv = require('@sap/xsenv');
    xsenv.loadEnv();
  } catch {
    // If @sap/xsenv is not available or loadEnv fails, continue
    // CAP should have already loaded default-env.json
  }
}

export interface DestinationResolution {
  destinationName: string;
  sapConfig: SapConfig;
  proxyType?: string | null;
  cloudConnectorLocationId?: string;
  authenticationType?: string;
  tokenExpiresAt?: number;
}

/**
 * Get case-insensitive property from destination configuration
 */
function getCaseInsensitive(destination: Destination, key: string): string | undefined {
  const config = destination.originalProperties || {};

  // Try exact match first
  if (config[key] !== undefined) {
    return String(config[key]);
  }

  // Try case-insensitive match
  const lowerKey = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(config)) {
    if (entryKey.toLowerCase() === lowerKey) {
      return String(value);
    }
  }

  // Try using destination's get method for well-known properties
  try {
    if (key.toLowerCase() === 'url') {
      return destination.url;
    }
    if (key.toLowerCase() === 'proxytype') {
      return destination.proxyType ? String(destination.proxyType) : undefined;
    }
    if (key.toLowerCase() === 'authentication') {
      return destination.authentication || undefined;
    }
  } catch {
    // Property might not exist
  }

  return undefined;
}

/**
 * Build SapConfig from SAP Cloud SDK Destination
 *
 * For CloudSdkAbapConnection: returns minimal SapConfig (URL, authType, client)
 * because executeHttpRequest handles all authentication automatically via destination.
 *
 * For on-premise connectivity: returns full SapConfig with username/password
 * because Cloud Connector needs explicit credentials.
 */
async function buildSapConfigFromDestination(
  destinationName: string,
  destination: Destination,
  jwtToken?: string
): Promise<DestinationResolution> {
  const rawUrl = destination.url || getCaseInsensitive(destination, 'URL');
  if (!rawUrl) {
    throw new Error(`Destination "${destinationName}" is missing URL property.`);
  }

  const proxyType = destination.proxyType
    ? String(destination.proxyType)
    : getCaseInsensitive(destination, 'ProxyType');
  const authentication =
    destination.authentication || getCaseInsensitive(destination, 'Authentication');
  const sapClient = getCaseInsensitive(destination, 'sap-client');
  const cloudConnectorLocationId = getCaseInsensitive(destination, 'CloudConnectorLocationId');

  if (!authentication) {
    throw new Error(`Destination "${destinationName}" is missing Authentication property.`);
  }

  // Determine authType based on destination authentication
  let authType: SapConfig['authType'];
  switch (authentication) {
    case 'BasicAuthentication':
      authType = 'basic';
      break;
    case 'OAuth2ClientCredentials':
    case 'OAuth2SAMLBearerAssertion':
      authType = 'jwt';
      break;
    default:
      throw new Error(
        `Destination "${destinationName}" uses unsupported authentication type "${authentication}".`
      );
  }

  // Build minimal SapConfig - CloudSdkAbapConnection uses executeHttpRequest
  // which handles all authentication automatically via destination.
  // Only URL, authType, and client are needed.
  const sapConfig: SapConfig = {
    url: rawUrl,
    authType,
  };

  if (sapClient) {
    sapConfig.client = sapClient;
  }

  // For on-premise connectivity (Cloud Connector), we need username/password
  // This is handled separately in BtpOnPremDestinationConnection
  // For CloudSdkAbapConnection, executeHttpRequest gets credentials from destination automatically

  // For Principal Propagation, JWT token is passed to executeHttpRequest via destination options
  // We store it in SapConfig only for backward compatibility and logging
  if (authentication === 'OAuth2SAMLBearerAssertion' && jwtToken) {
    sapConfig.jwtToken = jwtToken;
  }

  // Token expiration is handled by SAP Cloud SDK internally for OAuth2ClientCredentials
  // For Principal Propagation, use conservative expiration
  const tokenExpiresAt =
    authentication === 'OAuth2SAMLBearerAssertion' && jwtToken
      ? Date.now() + 45 * 60 * 1000 // 45 minutes
      : undefined;

  return {
    destinationName,
    sapConfig,
    proxyType: proxyType || undefined,
    cloudConnectorLocationId,
    authenticationType: authentication,
    tokenExpiresAt,
  };
}

/**
 * Resolve destination configuration using SAP Cloud SDK
 * This replaces the low-level implementation with SAP's recommended approach
 *
 * @param destinationName - Name of the destination to resolve
 * @param jwtToken - Optional JWT token for Principal Propagation (only for OAuth2SAMLBearerAssertion)
 */
export async function resolveDestinationSapConfig(
  destinationName: string,
  jwtToken?: string
): Promise<DestinationResolution> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const log = require('@sap/cds').log('destination-resolver');

  try {
    log.debug('Resolving destination via SAP Cloud SDK', { destinationName, hasJwt: !!jwtToken });

    // First, get destination without JWT to check authentication type
    // Destination credentials are stored in destination itself, not in user JWT
    const destination = await getDestination({ destinationName });

    if (!destination) {
      log.error('Destination not found', { destinationName });
      throw new Error(`Destination "${destinationName}" not found.`);
    }

    const authentication =
      destination.authentication || getCaseInsensitive(destination, 'Authentication');

    log.debug('Destination retrieved successfully', {
      destinationName,
      url: destination.url,
      proxyType: destination.proxyType,
      authentication,
    });

    // Only pass JWT token if destination requires Principal Propagation
    // For BasicAuthentication and OAuth2ClientCredentials, destination has its own credentials
    if (authentication === 'OAuth2SAMLBearerAssertion' && jwtToken) {
      log.debug('Using Principal Propagation (OAuth2SAMLBearerAssertion) with user JWT', {
        destinationName,
        jwtTokenLength: jwtToken.length,
      });
    } else if (authentication === 'OAuth2SAMLBearerAssertion' && !jwtToken) {
      log.warn('Destination requires Principal Propagation but no JWT token provided', {
        destinationName,
        authentication,
      });
    } else if (jwtToken && authentication !== 'OAuth2SAMLBearerAssertion') {
      log.debug('Ignoring user JWT token - destination uses its own credentials', {
        destinationName,
        authentication,
      });
    }

    return buildSapConfigFromDestination(destinationName, destination, jwtToken);
  } catch (error: unknown) {
    // Use synchronized error handling from errorUtils
    const { logErrorSafely } = await import('../lib/errorUtils');
    logErrorSafely(log, 'Destination resolution', error, {
      destinationName,
    });

    // Create error with status code for proper HTTP response
    const { formatErrorMessage } = await import('../lib/errorUtils');
    const message = formatErrorMessage(error);
    const destinationError = new Error(
      `Failed to resolve destination "${destinationName}": ${message}`
    );
    (destinationError as any).statusCode = 502; // Bad Gateway
    (destinationError as any).code =
      error instanceof Error && (error as any).code
        ? (error as any).code
        : 'DESTINATION_RESOLUTION_FAILED';
    throw destinationError;
  }
}

/**
 * Clear any cached destination data
 * Note: SAP Cloud SDK handles caching internally, but we keep this for compatibility
 */
export function clearDestinationServiceCache(): void {
  // SAP Cloud SDK handles caching internally
  // This function is kept for backward compatibility
}
