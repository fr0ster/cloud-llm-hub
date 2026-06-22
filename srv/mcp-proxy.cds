@path: 'mcp-proxy'
service McpProxyService {
  function Health() returns HealthStatus;
  function ProbeDestination(destination: String) returns DestinationProbeResult;
  function ListDestinations() returns array of DestinationStatus;
  function DiagnoseDestinations() returns array of DestinationDiagnostic;
  // Probe ONLY the active destination (X-SAP-Destination) under the CALLER's own
  // SAP identity (x-sap-login/x-sap-password/x-sap-client), not the destination's
  // stored credentials. Used by the post-login OK/ERROR status + DIAG button.
  function ProbeActiveDestination() returns DestinationDiagnostic;
  action InvokeTool(request: ProxyInvocation) returns ProxyResult;
}

type ProxyInvocation {
  toolId  : String;
  mode    : String;      // Expected values: "sse" or "stream-http"
  payload : LargeString;
}

type ProxyResult {
  status     : String;
  mode       : String;
  message    : LargeString;
  receivedAt : DateTime;
}

type HealthStatus {
  status     : String;
  timestamp  : DateTime;
}

type DestinationProbeResult {
  destination              : String;
  connectivity             : String;
  proxyType                : String;
  authentication           : String;
  sapClient                : String;
  cloudConnectorLocationId : String;
  tokenExpiresAt           : Integer;
  probe                    : DestinationProbe;
  timestamp                : DateTime;
}

type DestinationProbe {
  status      : Integer;
  statusText  : String;
  contentType : String;
}

type DestinationStatus {
  name           : String;
  url            : String;
  authentication : String;
  proxyType      : String;
  reachable      : Boolean;
  error          : String;
  probeStatus    : Integer;
  probeStatusText: String;
  timestamp      : DateTime;
}

// Independent diagnostic probe — classifies raw connectivity-proxy
// responses instead of hiding them behind a generic 503. Helps operators
// tell apart "SCC offline", "no SCC for this subaccount", "wrong location
// id", "tunnel up but ABAP auth failed", etc. (see issue #85).
type DestinationDiagnostic {
  name             : String;
  url              : String;
  proxyType        : String;
  locationId       : String;
  status           : String; // classified: ok | tunnel_timeout | no_scc_registration | wrong_location_id | backend_auth_failed | backend_reachable_path_error | backend_error | dns_or_network | unknown
  httpCode         : Integer;
  latencyMs        : Integer;
  rawMessage       : String;
  hint             : String;
  timestamp        : DateTime;
}
