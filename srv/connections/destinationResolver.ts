import { getDestination } from '@sap-cloud-sdk/connectivity';
import type { Destination } from '@sap-cloud-sdk/connectivity';
import type { SapConfig } from '@fr0ster/mcp-abap-adt/dist/lib/sapConfig';

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
 * Converts destination configuration to the format expected by mcp-abap-adt
 */
async function buildSapConfigFromDestination(
  destinationName: string,
  destination: Destination
): Promise<DestinationResolution> {
  const rawUrl = destination.url || getCaseInsensitive(destination, 'URL');
  if (!rawUrl) {
    throw new Error(`Destination "${destinationName}" is missing URL property.`);
  }

  const proxyType = destination.proxyType ? String(destination.proxyType) : getCaseInsensitive(destination, 'ProxyType');
  const authentication = destination.authentication || getCaseInsensitive(destination, 'Authentication');
  const sapClient = getCaseInsensitive(destination, 'sap-client');
  const cloudConnectorLocationId = getCaseInsensitive(destination, 'CloudConnectorLocationId');

  if (!authentication) {
    throw new Error(`Destination "${destinationName}" is missing Authentication property.`);
  }

  let sapConfig: SapConfig;
  let tokenExpiresAt: number | undefined;

  switch (authentication) {
    case 'BasicAuthentication': {
      const username = getCaseInsensitive(destination, 'User') || getCaseInsensitive(destination, 'username');
      const password = getCaseInsensitive(destination, 'Password') || getCaseInsensitive(destination, 'password');

      if (!username || !password) {
        throw new Error(`Destination "${destinationName}" must provide User and Password for BasicAuthentication.`);
      }

      sapConfig = {
        url: rawUrl,
        authType: 'basic',
        username,
        password
      };
      break;
    }
    case 'OAuth2ClientCredentials': {
      // For OAuth2ClientCredentials, SAP Cloud SDK automatically handles token retrieval
      // We need to extract the token from destination headers or get it manually
      // Note: SAP Cloud SDK handles OAuth tokens internally, but we need JWT token for ADT
      const tokenServiceUrl =
        getCaseInsensitive(destination, 'tokenServiceURL') ||
        getCaseInsensitive(destination, 'tokenServiceUrl');
      const tokenServiceUser = getCaseInsensitive(destination, 'tokenServiceUser');
      const tokenServicePassword = getCaseInsensitive(destination, 'tokenServicePassword');

      if (!tokenServiceUrl || !tokenServiceUser || !tokenServicePassword) {
        throw new Error(
          `Destination "${destinationName}" must provide tokenServiceURL, tokenServiceUser and tokenServicePassword for OAuth2ClientCredentials.`
        );
      }

      // Get OAuth token manually (SAP Cloud SDK handles this internally for HTTP requests,
      // but we need the token explicitly for ADT connection)
      try {
        const response = await fetch(tokenServiceUrl, {
          method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`${tokenServiceUser}:${tokenServicePassword}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'grant_type=client_credentials'
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`Token service returned ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const accessToken = data?.access_token;

        if (!accessToken) {
          throw new Error(`Token service for destination "${destinationName}" did not return access_token.`);
        }

        const expiresIn = Number(data?.expires_in ?? 0);
        tokenExpiresAt = expiresIn > 0
          ? Date.now() + Math.max(expiresIn - 60, 30) * 1000
          : undefined;

        sapConfig = {
          url: rawUrl,
          authType: 'jwt',
          jwtToken: accessToken
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to exchange client credentials for destination "${destinationName}": ${message}`);
      }
      break;
    }
    default:
      throw new Error(`Destination "${destinationName}" uses unsupported authentication type "${authentication}".`);
  }

  if (sapClient) {
    sapConfig.client = sapClient;
  }

  return {
    destinationName,
    sapConfig,
    proxyType: proxyType || undefined,
    cloudConnectorLocationId,
    authenticationType: authentication,
    tokenExpiresAt
  };
}

/**
 * Resolve destination configuration using SAP Cloud SDK
 * This replaces the low-level implementation with SAP's recommended approach
 * 
 * @param destinationName - Name of the destination to resolve
 * @param jwtToken - Optional JWT token for user context (may be needed for some destinations)
 */
export async function resolveDestinationSapConfig(
  destinationName: string,
  jwtToken?: string
): Promise<DestinationResolution> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const log = require('@sap/cds').log('destination-resolver');
  
  try {
    log.debug('Resolving destination via SAP Cloud SDK', { destinationName, hasJwt: !!jwtToken });
    
    // SAP Cloud SDK automatically:
    // - Reads credentials from VCAP_SERVICES
    // - Gets token for destination service (if needed)
    // - Retrieves destination from instance or subaccount level
    // - Handles authentication (Basic/OAuth)
    // - Handles proxy configuration for on-premise
    // 
    // Note: If jwtToken is provided, it may be used for principal propagation
    const destinationOptions: any = { destinationName };
    if (jwtToken) {
      destinationOptions.jwt = jwtToken;
    }
    
    const destination = await getDestination(destinationOptions);

    if (!destination) {
      log.error('Destination not found', { destinationName });
      throw new Error(`Destination "${destinationName}" not found.`);
    }

    log.debug('Destination retrieved successfully', { 
      destinationName,
      url: destination.url,
      proxyType: destination.proxyType,
      authentication: destination.authentication
    });

    return buildSapConfigFromDestination(destinationName, destination);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const errorDetails = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: stack
    } : { error: String(error) };
    
    log.error('Failed to resolve destination', {
      destinationName,
      ...errorDetails
    });
    
    // Create error with status code for proper HTTP response
    const destinationError = new Error(`Failed to resolve destination "${destinationName}": ${message}`);
    (destinationError as any).statusCode = 502; // Bad Gateway
    (destinationError as any).code = error instanceof Error && (error as any).code 
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
