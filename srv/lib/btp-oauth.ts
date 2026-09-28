/**
 * BTP OAuth2 helper — shared token fetching for BTP service bindings.
 *
 * Extracts credentials from VCAP_SERVICES and obtains client_credentials tokens.
 */

import { createHash } from 'node:crypto';

interface BtpServiceCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  uri: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCache>();

/**
 * Extract credentials for a named BTP service from VCAP_SERVICES.
 */
export function getServiceCredentials(
  ...serviceNames: string[]
): BtpServiceCredentials {
  // 1. Try VCAP_SERVICES (service binding)
  const vcap = process.env.VCAP_SERVICES;
  if (vcap) {
    const services = JSON.parse(vcap);
    for (const name of serviceNames) {
      const binding = services[name]?.[0];
      if (binding?.credentials) {
        const creds = binding.credentials as Record<string, unknown>;
        return {
          tokenUrl: `${creds.url}/oauth/token`,
          clientId: creds.clientid as string,
          clientSecret: creds.clientsecret as string,
          uri:
            (creds.serviceurls as Record<string, string>)?.AI_API_URL ||
            (creds.uri as string) ||
            (creds.url as string),
        };
      }
    }
  }

  // 2. Try AICORE_SERVICE_KEY (assembled from env vars by ensureAiCoreCredentials)
  if (serviceNames.includes('aicore') || serviceNames.includes('ai-core')) {
    const serviceKey = process.env.AICORE_SERVICE_KEY;
    if (serviceKey) {
      const creds = JSON.parse(serviceKey) as Record<string, unknown>;
      return {
        tokenUrl: `${creds.url}/oauth/token`,
        clientId: creds.clientid as string,
        clientSecret: creds.clientsecret as string,
        uri:
          (creds.serviceurls as Record<string, string>)?.AI_API_URL ||
          (creds.uri as string) ||
          (creds.url as string),
      };
    }
  }

  throw new Error(
    `Service binding not found in VCAP_SERVICES (tried: ${serviceNames.join(', ')})`,
  );
}

/**
 * Get OAuth2 client_credentials token (cached until ~5min before expiry).
 *
 * The cache key covers the secret, not only the client id: `wrappedAuth` passes
 * caller-supplied Basic credentials here, and a token obtained with one secret
 * must never be returned to a caller presenting another. The secret is hashed
 * so it is not kept in memory as a map key.
 */
export async function getToken(creds: BtpServiceCredentials): Promise<string> {
  const cacheKey = createHash('sha256')
    .update(`${creds.tokenUrl}\0${creds.clientId}\0${creds.clientSecret}`)
    .digest('hex');
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const response = await fetch(creds.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(creds.clientId)}&client_secret=${encodeURIComponent(creds.clientSecret)}`,
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  // Cache token with 5min safety margin
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  });

  return data.access_token;
}
