import axios from 'axios';
import type { SapConfig } from '@fr0ster/mcp-abap-adt/dist/lib/sapConfig';

// eslint-disable-next-line @typescript-eslint/no-var-requires -- xsenv does not ship type definitions
const xsenv = require('@sap/xsenv');

interface DestinationServiceCredentials {
  uri?: string;
  url?: string;
  clientid: string;
  clientsecret: string;
  tokenServiceURL?: string;
  tokenServiceUrl?: string;
  token_service_url?: string;
  tokenService?: {
    url?: string;
  };
  [key: string]: unknown;
}

interface DestinationResponse {
  destinationConfiguration: Record<string, string>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface DestinationResolution {
  destinationName: string;
  sapConfig: SapConfig;
  proxyType?: string;
  cloudConnectorLocationId?: string;
  authenticationType?: string;
  tokenExpiresAt?: number;
}

let cachedCredentials: DestinationServiceCredentials | undefined;
let cachedServiceToken: CachedToken | undefined;

function ensureDestinationCredentials(): DestinationServiceCredentials {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  xsenv.loadEnv();

  let serviceBinding: any;
  try {
    ({ destination: serviceBinding } = xsenv.getServices({ destination: { tag: 'destination' } }));
  } catch (error) {
    throw new Error('Destination service binding with tag "destination" is required to use destination headers.');
  }

  if (!serviceBinding) {
    throw new Error('Destination service binding not found in environment.');
  }

  const credentials = serviceBinding.credentials ?? serviceBinding;
  if (!credentials?.clientid || !credentials?.clientsecret) {
    throw new Error('Destination service credentials must contain clientid and clientsecret.');
  }

  cachedCredentials = credentials as DestinationServiceCredentials;
  return cachedCredentials;
}

function determineTokenUrl(credentials: DestinationServiceCredentials): string {
  return (
    credentials.tokenServiceURL ||
    credentials.tokenServiceUrl ||
    credentials.token_service_url ||
    credentials.tokenService?.url ||
    ''
  );
}

function normalizeServiceUrl(credentials: DestinationServiceCredentials): string {
  const raw = credentials.uri || credentials.url;
  if (!raw) {
    throw new Error('Destination service credentials are missing service URL.');
  }
  return raw.replace(/\/$/, '');
}

async function fetchServiceToken(credentials: DestinationServiceCredentials): Promise<CachedToken> {
  if (cachedServiceToken && cachedServiceToken.expiresAt > Date.now()) {
    return cachedServiceToken;
  }

  const tokenUrl = determineTokenUrl(credentials);
  if (!tokenUrl) {
    throw new Error('Destination service credentials are missing token service URL.');
  }

  const auth = Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString('base64');

  try {
    const response = await axios.post(
      tokenUrl,
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = response.data?.access_token as string | undefined;
    const expiresIn = Number(response.data?.expires_in ?? 0);

    if (!accessToken) {
      throw new Error('Destination service token response did not contain access_token.');
    }

    const expiresAt = expiresIn > 0
      ? Date.now() + Math.max(expiresIn - 60, 30) * 1000
      : Date.now() + 5 * 60 * 1000;

    cachedServiceToken = { token: accessToken, expiresAt };
    return cachedServiceToken;
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const details = error.response?.data;
      throw new Error(`Failed to obtain destination service token: ${error.message} ${details ? JSON.stringify(details) : ''}`.trim());
    }
    throw error;
  }
}

function getCaseInsensitive(config: Record<string, string>, key: string): string | undefined {
  if (config[key] !== undefined) {
    return config[key];
  }
  const lowerKey = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(config)) {
    if (entryKey.toLowerCase() === lowerKey) {
      return value;
    }
  }
  return undefined;
}

async function buildSapConfigFromDestination(
  destinationName: string,
  destinationConfig: Record<string, string>
): Promise<DestinationResolution> {
  const rawUrl = getCaseInsensitive(destinationConfig, 'URL');
  if (!rawUrl) {
    throw new Error(`Destination "${destinationName}" is missing URL property.`);
  }

  const proxyType = getCaseInsensitive(destinationConfig, 'ProxyType');
  const authentication = getCaseInsensitive(destinationConfig, 'Authentication');
  const sapClient = getCaseInsensitive(destinationConfig, 'sap-client');
  const cloudConnectorLocationId = getCaseInsensitive(destinationConfig, 'CloudConnectorLocationId');

  if (!authentication) {
    throw new Error(`Destination "${destinationName}" is missing Authentication property.`);
  }

  let sapConfig: SapConfig;
  let tokenExpiresAt: number | undefined;

  switch (authentication) {
    case 'BasicAuthentication': {
      const username = getCaseInsensitive(destinationConfig, 'User');
      const password = getCaseInsensitive(destinationConfig, 'Password');

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
      const tokenServiceUrl =
        getCaseInsensitive(destinationConfig, 'tokenServiceURL') ||
        getCaseInsensitive(destinationConfig, 'tokenServiceUrl');
      const tokenServiceUser = getCaseInsensitive(destinationConfig, 'tokenServiceUser');
      const tokenServicePassword = getCaseInsensitive(destinationConfig, 'tokenServicePassword');

      if (!tokenServiceUrl || !tokenServiceUser || !tokenServicePassword) {
        throw new Error(
          `Destination "${destinationName}" must provide tokenServiceURL, tokenServiceUser and tokenServicePassword for OAuth2ClientCredentials.`
        );
      }

      try {
        const response = await axios.post(
          tokenServiceUrl,
          'grant_type=client_credentials',
          {
            headers: {
              Authorization: `Basic ${Buffer.from(`${tokenServiceUser}:${tokenServicePassword}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );

        const accessToken = response.data?.access_token as string | undefined;
        const expiresIn = Number(response.data?.expires_in ?? 0);

        if (!accessToken) {
          throw new Error(`Token service for destination "${destinationName}" did not return access_token.`);
        }

        tokenExpiresAt = expiresIn > 0
          ? Date.now() + Math.max(expiresIn - 60, 30) * 1000
          : undefined;

        sapConfig = {
          url: rawUrl,
          authType: 'jwt',
          jwtToken: accessToken
        };
      } catch (error: unknown) {
        if (axios.isAxiosError(error)) {
          const details = error.response?.data;
          throw new Error(
            `Failed to exchange client credentials for destination "${destinationName}": ${error.message} ${details ? JSON.stringify(details) : ''}`.trim()
          );
        }
        throw error;
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
    proxyType,
    cloudConnectorLocationId,
    authenticationType: authentication,
    tokenExpiresAt
  };
}

export async function resolveDestinationSapConfig(destinationName: string): Promise<DestinationResolution> {
  const credentials = ensureDestinationCredentials();
  const { token } = await fetchServiceToken(credentials);
  const serviceUrl = normalizeServiceUrl(credentials);

  try {
    const response = await axios.get<DestinationResponse>(
      `${serviceUrl}/destination-configuration/v1/destinations/${encodeURIComponent(destinationName)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.data?.destinationConfiguration) {
      throw new Error(`Destination "${destinationName}" response did not include configuration.`);
    }

    return buildSapConfigFromDestination(destinationName, response.data.destinationConfiguration);
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        throw new Error(`Destination "${destinationName}" not found.`);
      }
      const details = error.response?.data;
      throw new Error(`Failed to fetch destination "${destinationName}": ${error.message} ${details ? JSON.stringify(details) : ''}`.trim());
    }
    throw error;
  }
}

export function clearDestinationServiceCache(): void {
  cachedServiceToken = undefined;
}
