/**
 * Active-destination probe: test whether the CALLER's own SAP identity
 * (x-sap-login / x-sap-password / x-sap-client) can reach a single destination.
 *
 * Unlike the all-destinations DiagnoseDestinations probe — which uses each
 * destination's OWN stored credentials — this builds the connection from the
 * caller's headers, so it answers "does MY session work". It deliberately
 * requires both credential headers and never falls back to the destination's
 * (possibly technical) auth, so it can never silently probe the wrong identity.
 *
 * Kept as a standalone, dependency-light function (like establishRequestConnection)
 * so it can be unit-tested with mocked resolver + connection.
 */

import type { SapConfig } from '@mcp-abap-adt/connection';
import { createConnection } from '../connections/connectionFactory';
import { resolveDestinationSapConfig } from '../connections/destinationResolver';
import { classifyProbe, type ProbeStatus } from './probe-classifier';

/** A 400-class error the CAP handler maps to an HTTP 400. */
export class ActiveProbeBadRequest extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ActiveProbeBadRequest';
  }
}

export interface ActiveProbeResult {
  name: string;
  url: string;
  proxyType: string;
  status: ProbeStatus;
  httpCode: number;
  latencyMs: number;
  rawMessage: string;
  hint: string;
}

export interface ActiveProbeHeaders {
  destination?: string;
  login?: string;
  password?: string;
  client?: string;
  jwt?: string;
}

const PROBE_PATH = '/sap/bc/adt/discovery';

/**
 * @param headers - caller identity extracted from the request
 * @param now - monotonic clock (injectable for tests); defaults to Date.now
 * @throws ActiveProbeBadRequest on missing destination or incomplete credentials
 */
export async function runActiveDestinationProbe(
  headers: ActiveProbeHeaders,
  now: () => number = Date.now,
): Promise<ActiveProbeResult> {
  const destination = headers.destination?.trim();
  const login = headers.login?.trim();
  const password = headers.password; // never trim a password
  const client = headers.client?.trim();

  if (!destination) {
    throw new ActiveProbeBadRequest('Header "X-SAP-Destination" is required.');
  }
  // Caller-identity guarantee: require the user's own credentials; never fall
  // back to the destination's stored (possibly technical) auth.
  if (!login || !password) {
    throw new ActiveProbeBadRequest(
      'Both x-sap-login and x-sap-password are required to probe under your SAP identity.',
    );
  }

  const resolved = await resolveDestinationSapConfig(destination, headers.jwt);

  const sapConfig: SapConfig = { ...resolved.sapConfig };
  sapConfig.authType = 'basic';
  sapConfig.username = login;
  sapConfig.password = password;
  sapConfig.jwtToken = undefined;
  if (client) sapConfig.client = client;

  const proxyType = resolved.proxyType ?? 'Internet';

  const t0 = now();
  // Must pass destinationName so the factory selects CloudSdkAbapConnection
  // (Cloud SDK + Cloud Connector + probe()), not the base direct connection.
  const conn = createConnection({
    sapConfig,
    destinationName: resolved.destinationName,
  }) as unknown as {
    probe(path: string): Promise<{ httpCode: number; rawMessage: string }>;
  };
  const { httpCode, rawMessage } = await conn.probe(PROBE_PATH);
  const latencyMs = now() - t0;

  const { status, hint } = classifyProbe(
    httpCode,
    rawMessage,
    proxyType,
    'caller',
  );

  return {
    name: destination,
    url: sapConfig.url || '',
    proxyType,
    status,
    httpCode,
    latencyMs,
    rawMessage,
    hint,
  };
}
