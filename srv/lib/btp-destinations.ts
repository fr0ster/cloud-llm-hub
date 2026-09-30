/**
 * BTP Destinations — fetches and caches SAP system destinations.
 *
 * Uses BTP Destination Service REST API to list subaccount destinations,
 * filters to SAP-compatible systems (OnPremise + BasicAuth with SAP URLs).
 */

import cds from '@sap/cds';
import { getServiceCredentials, getToken } from './btp-oauth';
import type { DestinationSource } from './destination-source';

export interface SapDestination {
  name: string;
  url: string;
  authentication: string;
  proxyType: string;
}

interface RawDestination {
  Name: string;
  URL: string;
  Authentication: string;
  ProxyType: string;
  Type?: string;
  [key: string]: unknown;
}

/**
 * Heuristic: is this destination likely a SAP ABAP system usable for MCP?
 *
 * Criteria:
 * - OnPremise proxy (Cloud Connector) with BasicAuthentication
 * - URL contains SAP-typical patterns (/sap/, known SAP ports)
 * - Excludes OData-only, AI, and non-ABAP destinations
 */
/** Destination names that are technical/infrastructure, not SAP ABAP systems */
const EXCLUDED_DESTINATION_NAMES = [
  'cloud-connector',
  'cloud_connector',
  'connectivity',
];

function isSapAbapDestination(d: RawDestination): boolean {
  const url = d.URL?.toLowerCase() || '';
  const name = d.Name?.toLowerCase() || '';
  const auth = d.Authentication || '';
  const proxy = d.ProxyType || '';

  // Must be BasicAuthentication (MCP ADT requires it)
  if (auth !== 'BasicAuthentication') return false;

  // Must be OnPremise (Cloud Connector to SAP system)
  if (proxy !== 'OnPremise') return false;

  // Exclude known technical/infrastructure destinations
  if (EXCLUDED_DESTINATION_NAMES.includes(name)) return false;

  // Exclude OData-only endpoints (specific service paths)
  if (url.includes('/sap/opu/odata')) return false;

  // Exclude if URL looks like a specific service endpoint, not a system root
  if (url.includes('/srvd_a2x/')) return false;

  return true;
}

let cachedDestinations: SapDestination[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch all subaccount destinations from BTP Destination Service.
 */
async function fetchDestinations(): Promise<SapDestination[]> {
  const log = cds.log('btp-destinations');
  const creds = getServiceCredentials('destination');
  const token = await getToken(creds);

  const response = await fetch(
    `${creds.uri}/destination-configuration/v1/subaccountDestinations`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!response.ok) {
    throw new Error(`BTP Destination Service API failed: ${response.status}`);
  }

  const raw = (await response.json()) as RawDestination[];
  const destinations: SapDestination[] = raw
    .filter(isSapAbapDestination)
    .map((d) => ({
      name: d.Name,
      url: d.URL,
      authentication: d.Authentication,
      proxyType: d.ProxyType,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const excluded = raw.filter((d) => !isSapAbapDestination(d));
  if (excluded.length > 0) {
    log.info('Excluded non-ABAP destinations', {
      excluded: excluded.map((d) => ({
        name: d.Name,
        auth: d.Authentication,
        proxy: d.ProxyType,
        url: (d.URL ?? '').substring(0, 60),
      })),
    });
  }

  log.info('Fetched SAP destinations', {
    total: raw.length,
    sapDestinations: destinations.length,
    names: destinations.map((d) => d.name),
  });

  return destinations;
}

/** Clear destination list cache — forces re-fetch from BTP on next call. */
function clearBtpCache(): void {
  cachedDestinations = null;
  cacheTimestamp = 0;
}

/**
 * Get available SAP destinations (cached with 5min TTL).
 *
 * Falls back to the current destination from env var if API fails.
 */
async function listFromBtp(): Promise<SapDestination[]> {
  if (cachedDestinations && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedDestinations;
  }

  const log = cds.log('btp-destinations');
  try {
    cachedDestinations = await fetchDestinations();
    cacheTimestamp = Date.now();
    return cachedDestinations;
  } catch (err) {
    log.warn('Failed to fetch destinations, using env var fallback', {
      error: err instanceof Error ? err.message : String(err),
    });

    // Fallback: return only the configured destination
    const envDest = process.env.LLM_AGENT_MCP_DESTINATION;
    if (envDest) {
      return [
        {
          name: envDest,
          url: '',
          authentication: 'BasicAuthentication',
          proxyType: 'OnPremise',
        },
      ];
    }
    return [];
  }
}

/** Destinations fetched from the BTP Destination service, cached with a 5min TTL. */
export function btpDestinationSource(): DestinationSource {
  // The service is the authority on which names exist; nothing to check first.
  return { list: listFromBtp, clearCache: clearBtpCache, refuse: () => null };
}

let source: DestinationSource | null = null;

/** Called once by the builder (providers). Until then, BTP as today. */
export function setDestinationSource(s: DestinationSource): void {
  source = s;
}

export async function getAvailableDestinations(): Promise<SapDestination[]> {
  return (source ?? btpDestinationSource()).list();
}

/** Why the configured source cannot serve `name`, or null. See {@link DestinationSource.refuse}. */
export function refuseDestination(name: string): string | null {
  return (source ?? btpDestinationSource()).refuse(name);
}

export function clearDestinationsCache(): void {
  (source ?? btpDestinationSource()).clearCache();
}
