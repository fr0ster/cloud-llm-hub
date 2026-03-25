/**
 * Basic→Bearer middleware — exchanges XSUAA client_credentials for JWT.
 *
 * Allows service-to-service authentication via HTTP Basic auth with
 * XSUAA client_id:client_secret. Detects XSUAA service clients by the
 * 'sb-' prefix (SAP BTP convention) and transparently exchanges
 * credentials for a Bearer JWT before passing to CAP auth middleware.
 *
 * Uses the shared btp-oauth helper for VCAP_SERVICES parsing and
 * token caching with 5min safety margin.
 */

import cds from '@sap/cds';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getServiceCredentials, getToken } from './btp-oauth';

/** XSUAA service client IDs start with 'sb-' (SAP BTP convention) */
const XSUAA_CLIENT_PREFIX = 'sb-';

/**
 * Decode Basic auth header into clientId + clientSecret.
 * Returns null if the header is not Basic auth or malformed.
 */
function decodeBasicAuth(
  authHeader: string,
): { clientId: string; clientSecret: string } | null {
  if (!authHeader.startsWith('Basic ')) return null;

  const decoded = Buffer.from(authHeader.substring(6), 'base64').toString(
    'utf-8',
  );
  const colonIdx = decoded.indexOf(':');
  if (colonIdx < 0) return null;

  return {
    clientId: decoded.substring(0, colonIdx),
    clientSecret: decoded.substring(colonIdx + 1),
  };
}

/**
 * Create Express middleware that wraps CAP auth with Basic→Bearer exchange.
 *
 * When a request arrives with Basic auth and an XSUAA client_id (sb-* prefix),
 * the middleware exchanges client_id:client_secret for a JWT via XSUAA
 * token endpoint, then replaces the Authorization header before passing
 * to the original CAP auth middleware.
 *
 * Non-XSUAA Basic auth (e.g. mocked dev users) passes through unchanged.
 */
export function createBasicToBearerMiddleware(
  capAuth: RequestHandler,
): RequestHandler {
  const log = cds.log('basic-to-bearer');

  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return capAuth(req, res, next);

    const creds = decodeBasicAuth(authHeader);
    if (!creds || !creds.clientId.startsWith(XSUAA_CLIENT_PREFIX)) {
      return capAuth(req, res, next);
    }

    try {
      const xsuaaCreds = getServiceCredentials('xsuaa');
      const token = await getToken({
        tokenUrl: xsuaaCreds.tokenUrl,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        uri: xsuaaCreds.uri,
      });

      req.headers.authorization = `Bearer ${token}`;
      log.info('Basic->Bearer exchange OK', { clientId: creds.clientId });
    } catch (err) {
      log.warn('XSUAA token exchange failed', {
        clientId: creds.clientId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'XSUAA client_credentials exchange failed',
      });
      return;
    }

    return capAuth(req, res, next);
  };
}
