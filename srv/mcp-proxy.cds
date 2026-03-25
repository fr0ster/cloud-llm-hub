@path: 'mcp-proxy'
service McpProxyService {
  function Health() returns HealthStatus;
  function ProbeDestination(destination: String) returns DestinationProbeResult;
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
