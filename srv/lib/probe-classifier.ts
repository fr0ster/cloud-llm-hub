/**
 * Classify a connectivity-proxy / SAP Cloud SDK error message into a
 * stable status enum + an operator-facing hint that points at the side
 * to escalate to. Used both by the on-demand DiagnoseDestinations probe
 * (mcp-proxy.ts) and by the destination_unreachable error response in
 * the OpenAI / Anthropic handlers so external clients (curl, MCP, IDE
 * integrations) get the same classification the WebUI sees.
 *
 * See issue #85 for the rationale.
 */

export type ProbeStatus =
  | 'ok'
  | 'tunnel_timeout'
  | 'no_scc_registration'
  | 'wrong_location_id'
  | 'backend_auth_failed'
  | 'backend_reachable_path_error'
  | 'backend_error'
  | 'dns_or_network'
  | 'unknown';

export interface ProbeClassification {
  status: ProbeStatus;
  hint: string;
}

export function classifyProbe(
  httpCode: number,
  rawMessage: string,
  proxyType: string,
): ProbeClassification {
  const msg = rawMessage || '';
  const isOnprem = proxyType.toLowerCase() === 'onpremise';
  if (httpCode >= 200 && httpCode < 300) {
    return { status: 'ok', hint: '' };
  }
  if (/Timed out waiting for tunnel to open/i.test(msg)) {
    return {
      status: 'tunnel_timeout',
      hint: 'SCC registered for this subaccount but tunnel handshake fails — check SCC admin → subaccount status / reload subaccount; or the on-premise host is offline.',
    };
  }
  if (/no SAP Cloud Connector \(SCC\) connected.*SCC location ID/i.test(msg)) {
    return {
      status: 'wrong_location_id',
      hint: 'A SCC is registered to this subaccount, but not under the location id this destination uses — align destination CloudConnectorLocationId with a registered location, or add a new SCC subaccount registration with this location id.',
    };
  }
  if (/no SAP Cloud Connector \(SCC\) connected/i.test(msg)) {
    return {
      status: 'no_scc_registration',
      hint: 'No SCC is registered for this subaccount at all — add it via SCC admin → Configuration → Cloud → Add Subaccount.',
    };
  }
  if (
    httpCode === 401 ||
    /Anmeldung fehlgeschlagen|Unauthorized|Logon failed|invalid_grant/i.test(
      msg,
    )
  ) {
    return {
      status: 'backend_auth_failed',
      hint: isOnprem
        ? 'Tunnel works; backend ABAP rejected credentials. Check destination User/Password (or override via x-sap-login/x-sap-password).'
        : 'Backend returned 401 — credentials in the destination are stale.',
    };
  }
  if (httpCode === 403) {
    return {
      status: 'backend_reachable_path_error',
      hint: 'Tunnel works but backend forbids the probe path (often benign — destination is technically reachable).',
    };
  }
  if (httpCode >= 400 && httpCode < 500) {
    return {
      status: 'backend_reachable_path_error',
      hint: 'Tunnel works; backend returned a 4xx on the probe path. Usually benign for diagnostic purposes.',
    };
  }
  if (httpCode >= 500 && httpCode < 600) {
    return {
      status: 'backend_error',
      hint: 'Tunnel works; backend returned 5xx. Inspect ABAP system / on-premise service health.',
    };
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return {
      status: 'dns_or_network',
      hint: 'Backend host is unresolvable or refuses TCP — check destination URL and on-premise network.',
    };
  }
  return {
    status: 'unknown',
    hint: 'Unrecognised connectivity-proxy response. See rawMessage for details.',
  };
}
