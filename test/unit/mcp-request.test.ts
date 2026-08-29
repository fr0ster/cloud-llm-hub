import { needsSapConnection } from '../../srv/lib/mcp-request';

// An MCP client behind the proxy pings on a timer. Every forwarded message used
// to open an ABAP connection before the code looked at the method, so a 10s
// ping meant a logon to DEV every 10 seconds — the churn behind the sessions
// piling up.
describe('needsSapConnection', () => {
  it.each([
    'initialize',
    'ping',
    'tools/list',
    'resources/list',
    'resources/templates/list',
    'prompts/list',
    'logging/setLevel',
  ])('%s is answered without a SAP session', (method) => {
    expect(needsSapConnection({ jsonrpc: '2.0', id: 1, method })).toBe(false);
  });

  it.each(['notifications/initialized', 'notifications/cancelled'])(
    '%s is one-way and needs no session',
    (method) => {
      expect(needsSapConnection({ jsonrpc: '2.0', method })).toBe(false);
    },
  );

  it('tools/call opens the connection', () => {
    expect(
      needsSapConnection({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'GetTable', arguments: { table_name: 'T000' } },
      }),
    ).toBe(true);
  });

  // The allowlist is the fail-safe: only methods known to stay inside the MCP
  // server skip the connection. A future SAP-backed method must not silently
  // inherit an unopened one.
  it.each([
    'resources/read',
    'prompts/get',
    'completion/complete',
    'some/future/sap/method',
  ])('%s is unknown, so it connects', (method) => {
    expect(needsSapConnection({ jsonrpc: '2.0', id: 1, method })).toBe(true);
  });

  it('a batch opens the connection when ANY member needs SAP', () => {
    expect(
      needsSapConnection([
        { method: 'ping' },
        { method: 'tools/call', params: { name: 'GetTable' } },
      ]),
    ).toBe(true);
  });

  it('a batch of control methods does not', () => {
    expect(
      needsSapConnection([{ method: 'ping' }, { method: 'tools/list' }]),
    ).toBe(false);
  });

  it('an empty batch reaches no handler', () => {
    expect(needsSapConnection([])).toBe(false);
  });

  // A needless logon is wasteful; a missing one would break the call.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-JSON string', 'not json'],
    ['a number', 42],
  ])('%s errs towards connecting', (_label, body) => {
    expect(needsSapConnection(body)).toBe(true);
  });

  it('an object carrying no method errs towards connecting', () => {
    expect(needsSapConnection({ jsonrpc: '2.0', id: 1 })).toBe(true);
  });

  it('a non-string method errs towards connecting', () => {
    expect(needsSapConnection({ jsonrpc: '2.0', id: 1, method: 42 })).toBe(
      true,
    );
  });
});
