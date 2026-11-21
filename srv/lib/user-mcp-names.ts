const prefix = 'user__';
const serverPattern = /^(?!.*__)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i;
const toolPattern = /^[a-z0-9_-]+$/i;
const reservedServers = new Set([
  'user',
  'user-mcp',
  'hub',
  'sap',
  'docs',
  'rag',
  'system',
  'client',
  'target',
]);

export function isUserMcpName(name: string): boolean {
  return name.toLowerCase().startsWith(prefix);
}

export function validUserMcpServer(name: string): boolean {
  return serverPattern.test(name) && !reservedServers.has(name.toLowerCase());
}

export function validUserMcpTool(name: string): boolean {
  return toolPattern.test(name) && !isUserMcpName(name);
}

export function userMcpSelectionKey(server: string): string {
  return `${prefix}${server}`;
}

export function userMcpToolName(server: string, tool: string): string {
  return `${userMcpSelectionKey(server)}__${tool}`;
}

export function acceptsUserMcpPolicyName(name: string): boolean {
  if (!name.startsWith(prefix)) return false;
  const separator = name.indexOf('__', prefix.length);
  return (
    separator >= 0 &&
    validUserMcpServer(name.slice(prefix.length, separator)) &&
    validUserMcpTool(name.slice(separator + 2))
  );
}
