import axios from 'axios';
import type { Request } from 'express';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- xsenv has no type definitions
const xsenv = require('@sap/xsenv');

import type { SapConfig } from '@mcp-abap-adt/connection';
import { BtpOnPremDestinationConnection } from './BtpOnPremDestinationConnection';
import type { ConnectivityProxyConfig, BtpOnPremConnectionOptions } from './BtpOnPremDestinationConnection';

interface ConnectivityCredentials {
  onpremise_proxy_host: string;
  onpremise_proxy_port: string;
  clientid: string;
  clientsecret: string;
  token_service_url: string;
}

interface ConnectivityToken {
  token: string;
  expiresAt: number;
}

const CONNECTIVITY_MODE_HEADER = 'x-sap-connectivity-mode';
const CONNECTIVITY_LOCATION_HEADER = 'x-sap-connectivity-location-id';
const CONNECTIVITY_PRINCIPAL_HEADER = 'x-sap-connectivity-auth';

let cachedCredentials: ConnectivityCredentials | undefined;
let cachedToken: ConnectivityToken | undefined;

function loadConnectivityCredentials(): ConnectivityCredentials {
  if (!cachedCredentials) {
    xsenv.loadEnv();
    try {
      const services = xsenv.getServices({ connectivity: { tag: 'connectivity' } });
      cachedCredentials = services.connectivity as ConnectivityCredentials;
    } catch (error) {
      throw new Error('Connectivity service binding with tag "connectivity" is required for on-premise destinations.');
    }
  }
  return cachedCredentials;
}

async function fetchConnectivityToken(credentials: ConnectivityCredentials): Promise<ConnectivityToken> {
  const authHeader = Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString('base64');

  const response = await axios.post(credentials.token_service_url, 'grant_type=client_credentials', {
    headers: {
      Authorization: `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  const accessToken = response.data?.access_token;
  const expiresIn = Number(response.data?.expires_in ?? 0);

  if (!accessToken) {
    throw new Error('Connectivity token response did not contain access_token.');
  }

  const expiresAt = Date.now() + Math.max(expiresIn - 60, 30) * 1000; // refresh one minute early

  return { token: accessToken, expiresAt };
}

async function getConnectivityToken(credentials: ConnectivityCredentials): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  cachedToken = await fetchConnectivityToken(credentials);
  return cachedToken.token;
}

async function buildConnectivityProxyConfig(locationId?: string, principalToken?: string): Promise<ConnectivityProxyConfig> {
  const credentials = loadConnectivityCredentials();
  const authorization = await getConnectivityToken(credentials);

  return {
    host: credentials.onpremise_proxy_host,
    port: Number(credentials.onpremise_proxy_port),
    protocol: 'http',
    authorizationHeader: `Bearer ${authorization}`,
    locationId,
    principalPropagationToken: principalToken
  };
}

/**
 * Check if connectivity proxy should be used for on-premise connections
 * 
 * @param req - HTTP request with connectivity headers
 * @returns true if connectivity mode header is set to 'onprem'
 */
export function shouldUseConnectivity(req: Request): boolean {
  return (req.headers[CONNECTIVITY_MODE_HEADER] as string | undefined)?.toLowerCase() === 'onprem';
}

/**
 * Extract connectivity context from request headers
 * 
 * @param req - HTTP request with connectivity headers
 * @returns Connectivity context with locationId and principalToken
 */
export function extractConnectivityContext(req: Request): {
  locationId?: string;
  principalToken?: string;
} {
  const locationId = req.headers[CONNECTIVITY_LOCATION_HEADER] as string | undefined;
  const principalToken = req.headers[CONNECTIVITY_PRINCIPAL_HEADER] as string | undefined;
  return { locationId, principalToken };
}

/**
 * Create BTP On-Premise destination connection with connectivity proxy
 * 
 * @param sapConfig - SAP configuration (URL, auth type, credentials)
 * @param context - Connectivity context (locationId, principalToken)
 * @returns BTP On-Premise destination connection instance
 */
export async function createBtpOnPremConnection(
  sapConfig: SapConfig,
  context: ReturnType<typeof extractConnectivityContext>
): Promise<BtpOnPremDestinationConnection> {
  const proxy = await buildConnectivityProxyConfig(context.locationId, context.principalToken);

  const options: BtpOnPremConnectionOptions = {
    sapConfig,
    proxy
  };

  const connection = new BtpOnPremDestinationConnection(options);
  if (context.principalToken) {
    connection.updatePrincipalPropagation(context.principalToken);
  }
  return connection;
}

/**
 * Refresh BTP On-Premise connection with updated connectivity context
 * 
 * @param connection - Existing BTP On-Premise connection to refresh
 * @param context - Updated connectivity context (locationId, principalToken)
 */
export async function refreshBtpOnPremConnection(
  connection: BtpOnPremDestinationConnection,
  context: ReturnType<typeof extractConnectivityContext>
): Promise<void> {
  const proxy = await buildConnectivityProxyConfig(context.locationId, context.principalToken);
  connection.updateProxyAuthorization(proxy.authorizationHeader);
  connection.updatePrincipalPropagation(context.principalToken);
}

/**
 * Clear connectivity proxy caches
 * Used when connectivity configuration changes
 */
export function clearConnectivityCaches(): void {
  cachedToken = undefined;
}
