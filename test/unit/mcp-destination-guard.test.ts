import {
  agentStepCalls,
  jsonRpcError,
  jsonRpcErrorFor,
  MCP_DESTINATION_ERROR_CODE,
  mcpDestinationFailureMessage,
  mcpDestinationRefusal,
} from '../../srv/lib/mcp-destination-guard';

describe('mcpDestinationRefusal', () => {
  test('refuses an unnamed call when the subaccount has no destination', () => {
    const r = mcpDestinationRefusal(false, false, []);
    expect(r?.reason).toBe('no_destinations');
    expect(r?.message).toContain('No SAP destinations are configured');
    expect(r?.message).toContain('Cloud Connector');
  });

  test('leaves a named destination to resolution, even off the discovery list', () => {
    // OAuth2 / Internet destinations are not in the discovery list but resolve.
    expect(mcpDestinationRefusal(true, false, [])).toBeNull();
    expect(mcpDestinationRefusal(true, false, ['DS1'])).toBeNull();
  });

  test('lets a call without a destination through when some exist', () => {
    expect(mcpDestinationRefusal(false, false, ['DS1'])).toBeNull();
  });

  test('never refuses a direct (x-sap-url) call', () => {
    expect(mcpDestinationRefusal(false, true, [])).toBeNull();
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

describe('jsonRpcErrorFor', () => {
  test('answers a request with its own id', () => {
    expect(
      jsonRpcErrorFor(
        { jsonrpc: '2.0', id: 'a1', method: 'tools/call' },
        'm',
        {},
      ),
    ).toMatchObject({ id: 'a1' });
  });

  test('answers each request of a batch, skips notifications', () => {
    const r = jsonRpcErrorFor(
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/call' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call' },
      ],
      'm',
      {},
    ) as { id: unknown }[];
    expect(r.map((e) => e.id)).toEqual([1, 2]);
  });

  test('nothing to answer for a notification or a batch of them', () => {
    expect(
      jsonRpcErrorFor({ jsonrpc: '2.0', method: 'x' }, 'm', {}),
    ).toBeNull();
    expect(
      jsonRpcErrorFor([{ jsonrpc: '2.0', method: 'x' }], 'm', {}),
    ).toBeNull();
  });

  test('a body that is not JSON-RPC gets the id-less error', () => {
    expect(jsonRpcErrorFor('garbage', 'm', {})).toMatchObject({ id: null });
  });
});

describe('agentStepCalls', () => {
  const step = (args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'execute_step', arguments: args },
  });

  test('handshake and list_destinations run no step', () => {
    expect(agentStepCalls({ method: 'initialize', id: 1 }).runsStep).toBe(
      false,
    );
    expect(agentStepCalls({ method: 'tools/list', id: 1 }).runsStep).toBe(
      false,
    );
    expect(
      agentStepCalls({
        method: 'tools/call',
        id: 1,
        params: { name: 'list_destinations', arguments: {} },
      }).runsStep,
    ).toBe(false);
  });

  test('execute_step with a destination argument is named', () => {
    expect(agentStepCalls(step({ destination: 'DS1', task: 't' }))).toEqual({
      runsStep: true,
      allNamed: true,
    });
  });

  test('execute_step without a destination argument is not named', () => {
    expect(agentStepCalls(step({ task: 't' }))).toEqual({
      runsStep: true,
      allNamed: false,
    });
    expect(agentStepCalls(step({ destination: ' ', task: 't' })).allNamed).toBe(
      false,
    );
  });

  test('a batch is named only when every step is', () => {
    expect(
      agentStepCalls([step({ destination: 'DS1' }), step({})]).allNamed,
    ).toBe(false);
  });
});
