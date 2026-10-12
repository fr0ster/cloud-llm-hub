/**
 * MCP destination guard — decides, before any MCP server is built, whether an
 * MCP call can reach SAP at all. Without a usable destination the call is
 * refused with what to configure instead of a connection error.
 */

/** JSON-RPC error code for "SAP destination not configured / not usable". */
export const MCP_DESTINATION_ERROR_CODE = -32001;

const HOW_TO_FIX =
  'Configure an HTTP(S) destination to the ABAP system through the Cloud Connector ' +
  '(ProxyType OnPremise) in the BTP subaccount; the hub picks it up automatically.';

export interface McpDestinationRefusal {
  reason: 'no_destinations';
  message: string;
}

/**
 * Only a call that names no system at all is refused here. A named
 * destination is left to destination resolution: the discovery list keeps
 * OnPremise + BasicAuthentication only, while resolution also serves OAuth2
 * and Internet destinations. If the named one fails, the call reports which
 * destination failed (see {@link mcpDestinationFailureMessage}).
 *
 * @param named - the call names a destination (header or tool argument)
 * @param direct - the call names the system itself (`x-sap-url`), no destination
 * @param available - SAP destinations the subaccount has
 * @returns why the call is refused, or null to let it through
 */
export function mcpDestinationRefusal(
  named: boolean,
  direct: boolean,
  available: readonly string[],
): McpDestinationRefusal | null {
  if (direct || named || available.length > 0) return null;
  return {
    reason: 'no_destinations',
    message: `No SAP destinations are configured in this BTP subaccount — MCP tools are unavailable. ${HOW_TO_FIX}`,
  };
}

/** The message for a call whose destination failed while it ran. */
export function mcpDestinationFailureMessage(
  destination: string,
  detail: string,
): string {
  return `SAP destination "${destination}" failed: ${detail}. Check the destination in the BTP subaccount and the Cloud Connector (mapping, resources, connection state).`;
}

/** A JSON-RPC error response body. */
export function jsonRpcError(
  id: unknown,
  message: string,
  data: Record<string, unknown>,
): object {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: MCP_DESTINATION_ERROR_CODE, message, data },
  };
}

function messageId(message: unknown): unknown {
  return message !== null && typeof message === 'object'
    ? (message as { id?: unknown }).id
    : undefined;
}

/**
 * The error response to a whole JSON-RPC body, correlated with its requests:
 * one error per request in a batch, notifications (no id) left unanswered.
 * Null when nothing in the body expects an answer.
 */
export function jsonRpcErrorFor(
  body: unknown,
  message: string,
  data: Record<string, unknown>,
): object | object[] | null {
  if (Array.isArray(body)) {
    const errors = body
      .filter((m) => messageId(m) !== undefined)
      .map((m) => jsonRpcError(messageId(m), message, data));
    return errors.length > 0 ? errors : null;
  }
  const id = messageId(body);
  // A body that is not a JSON-RPC message gets the id-less error.
  if (id === undefined && body !== null && typeof body === 'object') {
    return null;
  }
  return jsonRpcError(id, message, data);
}

/**
 * The planner surface's (`/mcp/agent/stream/http`) only SAP-backed call is
 * `execute_step`; the handshake and `list_destinations` need no system.
 *
 * @returns whether the body runs `execute_step`, and whether every such call
 * names its destination as an argument
 */
export function agentStepCalls(body: unknown): {
  runsStep: boolean;
  allNamed: boolean;
} {
  const steps = (Array.isArray(body) ? body : [body]).filter(
    (m): m is { params?: { arguments?: { destination?: unknown } } } =>
      m !== null &&
      typeof m === 'object' &&
      (m as { method?: unknown }).method === 'tools/call' &&
      (m as { params?: { name?: unknown } }).params?.name === 'execute_step',
  );
  return {
    runsStep: steps.length > 0,
    allNamed: steps.every(
      (m) =>
        typeof m.params?.arguments?.destination === 'string' &&
        m.params.arguments.destination.trim() !== '',
    ),
  };
}
