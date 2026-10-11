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
  reason: 'no_destinations' | 'unknown_destination';
  message: string;
}

/**
 * @param requested - the `x-sap-destination` header, if any
 * @param direct - the call names the system itself (`x-sap-url`), no destination
 * @param available - SAP destinations the subaccount has
 * @returns why the call is refused, or null to let it through
 */
export function mcpDestinationRefusal(
  requested: string | undefined,
  direct: boolean,
  available: readonly string[],
): McpDestinationRefusal | null {
  if (direct) return null;
  if (available.length === 0) {
    return {
      reason: 'no_destinations',
      message: `No SAP destinations are configured in this BTP subaccount — MCP tools are unavailable. ${HOW_TO_FIX}`,
    };
  }
  if (requested && !available.includes(requested)) {
    return {
      reason: 'unknown_destination',
      message: `SAP destination "${requested}" does not exist in this BTP subaccount (available: ${available.join(', ')}). ${HOW_TO_FIX}`,
    };
  }
  return null;
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
