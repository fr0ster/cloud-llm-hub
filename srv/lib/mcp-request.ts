/**
 * Classification of an inbound MCP (JSON-RPC) message.
 */

/**
 * Methods the MCP server answers on its own, without ever reaching SAP.
 *
 * An ALLOWLIST rather than a "everything except tools/call" rule: today only
 * `tools/call` runs a handler that touches the system, but a future SAP-backed
 * method must not silently inherit an unopened connection. Anything not listed
 * here connects.
 *
 * `notifications/*` is matched by prefix — those are one-way and answered by
 * the transport.
 */
const SAP_FREE_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
  'logging/setLevel',
]);

/** Whether one JSON-RPC message reaches SAP. Unknown shapes and unknown
 * methods connect: a needless logon is wasteful, a missing one breaks the
 * call. */
function messageNeedsSap(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return true;
  const method = (message as { method?: unknown }).method;
  if (typeof method !== 'string') return true;
  if (method.startsWith('notifications/')) return false;
  return !SAP_FREE_METHODS.has(method);
}

/**
 * Whether this JSON-RPC body actually reaches SAP.
 *
 * Opening the ABAP connection is the establishing call — it COSTS ONE SAP
 * SESSION. The control methods above are answered from the MCP server alone
 * (its handler registry is built from a null-connection context, and the
 * wrapper lambdas resolve the connection lazily).
 *
 * An MCP client that pings every 10 seconds would otherwise make us log on to
 * the ABAP system every 10 seconds and hand the session straight back.
 *
 * Batches connect if ANY member does.
 */
export function needsSapConnection(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(messageNeedsSap);
  return messageNeedsSap(body);
}
