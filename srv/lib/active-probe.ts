/**
 * Active-destination probe: test whether the CALLER's own SAP identity
 * (SAP credentials or forwarded user JWT, plus client) can reach a destination.
 *
 * Unlike the all-destinations DiagnoseDestinations probe — which uses each
 * destination's OWN stored credentials — this builds the connection from the
 * caller's headers or forwarded JWT, so it answers "does MY session work".
 * Principal propagation preserves the resolved user-token auth; other
 * destinations require both credential headers, never stored technical auth.
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
  const resolved = await resolveDestinationSapConfig(destination, headers.jwt);
  const principalPropagation =
    resolved.authenticationType === 'PrincipalPropagation';

  // Non-PP caller-identity guarantee: require SAP credentials; never fall
  // back to the destination's stored (possibly technical) auth.
  if (!principalPropagation && (!login || !password)) {
    throw new ActiveProbeBadRequest(
      'Both x-sap-login and x-sap-password are required to probe under your SAP identity.',
    );
  }

  const sapConfig: SapConfig = { ...resolved.sapConfig };
  if (!principalPropagation) {
    sapConfig.authType = 'basic';
    sapConfig.username = login;
    sapConfig.password = password;
    sapConfig.jwtToken = undefined;
  }
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
    closeSession?: () => Promise<void>;
  };

  // Building a connection costs one SAP session: CloudSdkAbapConnection presents
  // a SAP_SESSIONID of its own, and SAP holds a session per distinct value until
  // it times out. This probe runs on a UI cadence, so without the release below
  // it mints a session every few seconds and never gives one back.
  let httpCode: number;
  let rawMessage: string;
  try {
    ({ httpCode, rawMessage } = await conn.probe(PROBE_PATH));
  } finally {
    await conn.closeSession?.();
  }
  const latencyMs = now() - t0;

  const { status, hint: classifiedHint } = classifyProbe(
    httpCode,
    rawMessage,
    proxyType,
    'caller',
  );

  const hint =
    principalPropagation && status === 'backend_auth_failed'
      ? 'Single sign-on failed. Reload and sign in again; if it persists, check the principal propagation mapping in Cloud Connector and SAP.'
      : classifiedHint;

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
