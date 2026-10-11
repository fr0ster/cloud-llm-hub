import {
  jsonRpcError,
  MCP_DESTINATION_ERROR_CODE,
  mcpDestinationFailureMessage,
  mcpDestinationRefusal,
} from '../../srv/lib/mcp-destination-guard';

describe('mcpDestinationRefusal', () => {
  test('refuses every call when the subaccount has no destination', () => {
    const r = mcpDestinationRefusal(undefined, false, []);
    expect(r?.reason).toBe('no_destinations');
    expect(r?.message).toContain('No SAP destinations are configured');
    expect(r?.message).toContain('Cloud Connector');
  });

  test('refuses a named destination that does not exist', () => {
    const r = mcpDestinationRefusal('S4HANA_DEV', false, ['DS1', 'DS2']);
    expect(r?.reason).toBe('unknown_destination');
    expect(r?.message).toContain('"S4HANA_DEV" does not exist');
    expect(r?.message).toContain('available: DS1, DS2');
  });

  test('lets an existing destination through', () => {
    expect(mcpDestinationRefusal('DS1', false, ['DS1'])).toBeNull();
  });

  test('lets a call without a destination through when some exist', () => {
    expect(mcpDestinationRefusal(undefined, false, ['DS1'])).toBeNull();
  });

  test('never refuses a direct (x-sap-url) call', () => {
    expect(mcpDestinationRefusal(undefined, true, [])).toBeNull();
    expect(mcpDestinationRefusal('X', true, [])).toBeNull();
  });
});

describe('MCP destination error bodies', () => {
  test('failure message names the destination and what to check', () => {
    const m = mcpDestinationFailureMessage('DS1', 'connect ECONNREFUSED');
    expect(m).toContain('"DS1" failed: connect ECONNREFUSED');
    expect(m).toContain('Cloud Connector');
  });

  test('jsonRpcError keeps the request id, null when absent', () => {
    expect(jsonRpcError(7, 'm', { reason: 'x' })).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: MCP_DESTINATION_ERROR_CODE,
        message: 'm',
        data: { reason: 'x' },
      },
    });
    expect(jsonRpcError(undefined, 'm', {})).toMatchObject({ id: null });
  });
});
