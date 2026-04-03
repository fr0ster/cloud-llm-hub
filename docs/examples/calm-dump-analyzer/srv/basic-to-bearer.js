/**
 * Basic→Bearer middleware — exchanges XSUAA client_credentials for JWT.
 *
 * Allows service-to-service (M2M) authentication via HTTP Basic auth with
 * XSUAA client_id:client_secret. The middleware intercepts Basic auth,
 * exchanges credentials for a JWT via XSUAA token endpoint, and replaces
 * the Authorization header before passing to CAP auth middleware.
 *
 * XSUAA service clients are identified by the 'sb-' prefix (SAP BTP convention).
 */

const cds = require('@sap/cds');

const tokenCache = new Map();

/**
 * Extract XSUAA credentials from VCAP_SERVICES.
 */
function getXsuaaCredentials() {
  const vcap = process.env.VCAP_SERVICES;
  if (!vcap) throw new Error('VCAP_SERVICES not available');

  const services = JSON.parse(vcap);
  const binding = services.xsuaa?.[0];
  if (!binding?.credentials) throw new Error('XSUAA binding not found in VCAP_SERVICES');

  const creds = binding.credentials;
  return {
    tokenUrl: `${creds.url}/oauth/token`,
    clientId: creds.clientid,
    clientSecret: creds.clientsecret,
  };
}

/**
 * Get OAuth2 client_credentials token (cached until ~5min before expiry).
 */
async function getToken(clientId, clientSecret, tokenUrl) {
  const cached = tokenCache.get(clientId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
  });

  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);

  const data = await response.json();
  tokenCache.set(clientId, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  });

  return data.access_token;
}

/**
 * Create middleware that wraps CAP auth with Basic→Bearer exchange.
 */
function createBasicToBearerMiddleware(capAuth) {
  const log = cds.log('basic-to-bearer');

  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return capAuth(req, res, next);
    }

    const decoded = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 0) return capAuth(req, res, next);

    const clientId = decoded.substring(0, colonIdx);
    const clientSecret = decoded.substring(colonIdx + 1);

    // Only exchange for XSUAA service clients (sb-* prefix)
    if (!clientId.startsWith('sb-')) {
      return capAuth(req, res, next);
    }

    try {
      const xsuaa = getXsuaaCredentials();
      const token = await getToken(clientId, clientSecret, xsuaa.tokenUrl);
      req.headers.authorization = `Bearer ${token}`;
      log.info('Basic->Bearer exchange OK', { clientId });
    } catch (err) {
      log.warn('Token exchange failed', { clientId, error: err.message });
      res.status(401).json({ error: { message: 'Client credentials exchange failed', code: '401' } });
      return;
    }

    return capAuth(req, res, next);
  };
}

module.exports = { createBasicToBearerMiddleware };
