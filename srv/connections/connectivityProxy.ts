import type { Request } from 'express';

const CONNECTIVITY_MODE_HEADER = 'x-sap-connectivity-mode';
const CONNECTIVITY_LOCATION_HEADER = 'x-sap-connectivity-location-id';
const CONNECTIVITY_PRINCIPAL_HEADER = 'x-sap-connectivity-auth';

/**
 * Check if connectivity proxy should be used for on-premise connections
 *
 * @param req - HTTP request with connectivity headers
 * @returns true if connectivity mode header is set to 'onprem'
 */
export function shouldUseConnectivity(req: Request): boolean {
  return (
    (
      req.headers[CONNECTIVITY_MODE_HEADER] as string | undefined
    )?.toLowerCase() === 'onprem'
  );
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
  const locationId = req.headers[CONNECTIVITY_LOCATION_HEADER] as
    | string
    | undefined;
  const principalToken = req.headers[CONNECTIVITY_PRINCIPAL_HEADER] as
    | string
    | undefined;
  return { locationId, principalToken };
}
