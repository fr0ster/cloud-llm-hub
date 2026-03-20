import type { SapConfig } from '@mcp-abap-adt/connection';
import type { Destination } from '@sap-cloud-sdk/connectivity';
import { getDestination } from '@sap-cloud-sdk/connectivity';

/**
 * Ensure VCAP_SERVICES is loaded from default-env.json for local development
 * This is called lazily when needed, not at module load time,
 * to ensure CAP has already loaded default-env.json
 */
function ensureVcapServicesLoaded(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const log = require('@sap/cds').log('destination-resolver');

  // Only load if VCAP_SERVICES is not already set and we're in local mode
  if (
    !process.env.VCAP_SERVICES &&
    process.env.VCAP_APPLICATION === undefined
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const xsenv = require('@sap/xsenv');
      const loaded = xsenv.loadEnv();
      // If loadEnv returns something, it means it loaded default-env.json
      if (loaded?.VCAP_SERVICES) {
        process.env.VCAP_SERVICES = JSON.stringify(loaded.VCAP_SERVICES);
        log.debug('VCAP_SERVICES loaded from default-env.json via xsenv', {
          hasDestination: !!(
            loaded.VCAP_SERVICES.destination &&
            loaded.VCAP_SERVICES.destination.length > 0
          ),
          destinationCount: loaded.VCAP_SERVICES.destination?.length || 0,
        });
      } else {
        log.warn('xsenv.loadEnv() returned no VCAP_SERVICES');
      }
    } catch (error) {
      // If @sap/xsenv is not available or loadEnv fails, continue
      // CAP should have already loaded default-env.json
      log.debug(
        'xsenv.loadEnv() failed (this is OK if CAP already loaded default-env.json)',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  // Verify VCAP_SERVICES structure for destination service
  if (process.env.VCAP_SERVICES) {
    try {
      const vcapServices = JSON.parse(process.env.VCAP_SERVICES);
      const hasDestination = !!(
        vcapServices.destination && vcapServices.destination.length > 0
      );
      if (!hasDestination) {
        log.warn('VCAP_SERVICES loaded but no destination service found', {
          availableServices: Object.keys(vcapServices),
        });
      } else {
        const destService = vcapServices.destination[0];
        log.debug('Destination service found in VCAP_SERVICES', {
          name: destService.name,
          hasCredentials: !!destService.credentials,
          hasClientId: !!destService.credentials?.clientid,
          hasClientSecret: !!destService.credentials?.clientsecret,
          hasUri: !!destService.credentials?.uri,
        });
      }
    } catch (parseError) {
      log.error('Failed to parse VCAP_SERVICES', {
        error:
          parseError instanceof Error ? parseError.message : String(parseError),
      });
    }
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
function getCaseInsensitive(
  destination: Destination,
  key: string,
): string | undefined {
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
  jwtToken?: string,
): Promise<DestinationResolution> {
  const rawUrl = destination.url || getCaseInsensitive(destination, 'URL');
  if (!rawUrl) {
    throw new Error(
      `Destination "${destinationName}" is missing URL property.`,
    );
  }

  const proxyType = destination.proxyType
    ? String(destination.proxyType)
    : getCaseInsensitive(destination, 'ProxyType');
  const authentication =
    destination.authentication ||
    getCaseInsensitive(destination, 'Authentication');
  const sapClient = getCaseInsensitive(destination, 'sap-client');
  const cloudConnectorLocationId = getCaseInsensitive(
    destination,
    'CloudConnectorLocationId',
  );

  if (!authentication) {
    throw new Error(
      `Destination "${destinationName}" is missing Authentication property.`,
    );
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
    case 'NoAuthentication':
      authType = 'basic'; // will be populated by x-sap-login/x-sap-password headers
      break;
    default:
      throw new Error(
        `Destination "${destinationName}" uses unsupported authentication type "${authentication}".`,
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
  jwtToken?: string,
): Promise<DestinationResolution> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const log = require('@sap/cds').log('destination-resolver');

  try {
    // Ensure VCAP_SERVICES is loaded before resolving destination
    // This is important for hybrid debugging mode where default-env.json needs to be loaded
    ensureVcapServicesLoaded();

    log.debug('Resolving destination via SAP Cloud SDK', {
      destinationName,
      hasJwt: !!jwtToken,
      hasVcapServices: !!process.env.VCAP_SERVICES,
      isLocal: !process.env.VCAP_APPLICATION,
    });

    // First, get destination without JWT to check authentication type
    // Destination credentials are stored in destination itself, not in user JWT
    const destination = await getDestination({ destinationName });

    if (!destination) {
      log.error('Destination not found', { destinationName });
      throw new Error(`Destination "${destinationName}" not found.`);
    }

    const authentication =
      destination.authentication ||
      getCaseInsensitive(destination, 'Authentication');

    log.debug('Destination retrieved successfully', {
      destinationName,
      url: destination.url,
      proxyType: destination.proxyType,
      authentication,
    });

    // Only pass JWT token if destination requires Principal Propagation
    // For BasicAuthentication and OAuth2ClientCredentials, destination has its own credentials
    if (authentication === 'OAuth2SAMLBearerAssertion' && jwtToken) {
      log.debug(
        'Using Principal Propagation (OAuth2SAMLBearerAssertion) with user JWT',
        {
          destinationName,
          jwtTokenLength: jwtToken.length,
        },
      );
    } else if (authentication === 'OAuth2SAMLBearerAssertion' && !jwtToken) {
      log.warn(
        'Destination requires Principal Propagation but no JWT token provided',
        {
          destinationName,
          authentication,
        },
      );
    } else if (jwtToken && authentication !== 'OAuth2SAMLBearerAssertion') {
      log.debug(
        'Ignoring user JWT token - destination uses its own credentials',
        {
          destinationName,
          authentication,
        },
      );
    }

    return buildSapConfigFromDestination(
      destinationName,
      destination,
      jwtToken,
    );
  } catch (error: unknown) {
    // Log detailed error information for debugging
    const errorDetails: Record<string, unknown> = {
      destinationName,
      hasVcapServices: !!process.env.VCAP_SERVICES,
      isLocal: !process.env.VCAP_APPLICATION,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    };

    // Add error code if available
    const errWithCode = error as Error & {
      code?: string;
      cause?: unknown;
      rootCause?: unknown;
    };
    if (error instanceof Error && errWithCode.code) {
      errorDetails.errorCode = errWithCode.code;
    }

    // Add cause/rootCause if available (SAP Cloud SDK errors often have cause)
    if (error instanceof Error && errWithCode.cause) {
      errorDetails.cause =
        errWithCode.cause instanceof Error
          ? errWithCode.cause.message
          : String(errWithCode.cause);
    }
    if (error instanceof Error && errWithCode.rootCause) {
      errorDetails.rootCause =
        errWithCode.rootCause instanceof Error
          ? errWithCode.rootCause.message
          : String(errWithCode.rootCause);
    }

    // Add VCAP_SERVICES destination service info if available
    if (process.env.VCAP_SERVICES) {
      try {
        const vcapServices = JSON.parse(process.env.VCAP_SERVICES);
        const destService = vcapServices.destination?.[0];
        if (destService) {
          errorDetails.destinationService = {
            name: destService.name,
            hasCredentials: !!destService.credentials,
            hasClientId: !!destService.credentials?.clientid,
            hasClientSecret: !!destService.credentials?.clientsecret,
            hasUri: !!destService.credentials?.uri,
            uri: destService.credentials?.uri,
            url: destService.credentials?.url,
          };
        } else {
          errorDetails.destinationService = 'NOT_FOUND_IN_VCAP_SERVICES';
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Add stack trace in development mode
    if (
      error instanceof Error &&
      error.stack &&
      process.env.NODE_ENV !== 'production'
    ) {
      errorDetails.stack = error.stack.substring(0, 500);
    }

    log.error('Destination resolution failed', errorDetails);

    // Use synchronized error handling from errorUtils
    // In development (cds watch), TypeScript files are executed directly, so use .ts extension
    // In production (compiled), files are .js
    // Try .ts first (development), fallback to .js (production)
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic import result type is not fully typed
    let logErrorSafely: any;
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic import result type is not fully typed
    let formatErrorMessage: any;

    try {
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic import result type is not fully typed
      let errorUtils: any;
      try {
        // @ts-expect-error - Dynamic import with .ts extension for development mode
        errorUtils = await import('../lib/errorUtils.ts');
      } catch {
        errorUtils = await import('../lib/errorUtils.js');
      }
      logErrorSafely = errorUtils.logErrorSafely;
      formatErrorMessage = errorUtils.formatErrorMessage;
    } catch (importError) {
      // Fallback if errorUtils cannot be imported
      log.error('Failed to import errorUtils, using fallback error handling', {
        error:
          importError instanceof Error
            ? importError.message
            : String(importError),
      });
      // Fallback implementations
      logErrorSafely = (
        // biome-ignore lint/suspicious/noExplicitAny: Fallback logger can be any type
        logger: any,
        operation: string,
        // biome-ignore lint/suspicious/noExplicitAny: Fallback error can be any type
        err: any,
        // biome-ignore lint/suspicious/noExplicitAny: Fallback context can be any type
        context?: any,
      ) => {
        logger.error(`${operation} failed`, {
          error: err instanceof Error ? err.message : String(err),
          context,
        });
      };
      // biome-ignore lint/suspicious/noExplicitAny: Fallback error can be any type
      formatErrorMessage = (err: any) => {
        return err instanceof Error ? err.message : String(err);
      };
    }

    logErrorSafely(log, 'Destination resolution', error, {
      destinationName,
    });

    // Create error with status code for proper HTTP response
    const message = formatErrorMessage(error);
    const destinationError = new Error(
      `Failed to resolve destination "${destinationName}": ${message}`,
    ) as Error & { statusCode?: number; code?: string };
    destinationError.statusCode = 502; // Bad Gateway
    const errorObj = error as { code?: string };
    destinationError.code =
      error instanceof Error && errorObj.code
        ? errorObj.code
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
