@requires: 'proxyAccess'
@path: 'mcp'
service McpProxyService {
  function Health() returns HealthStatus;
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
