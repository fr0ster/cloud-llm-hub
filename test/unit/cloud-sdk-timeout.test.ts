/**
 * CloudSdkAbapConnection.makeAdtRequest() sets no deadline.
 *
 * A timeout here is a problem the connector creates: a long ADT request means
 * a lot of data or a loaded system, and cutting it makes the outcome
 * unpredictable. The consumer that wants a bound closes the connection itself,
 * so no `timeout` — not even the one the ADT client passes — reaches
 * executeHttpRequest, inside a critical section or out of it.
 */

import type { AbapRequestOptions } from '@mcp-abap-adt/connection';
import type { executeHttpRequest } from '@sap-cloud-sdk/http-client';

const mockExec = jest.fn<
  ReturnType<typeof executeHttpRequest>,
  Parameters<typeof executeHttpRequest>
>();
jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: (...args: Parameters<typeof executeHttpRequest>) =>
    mockExec(...args),
}));
jest.mock('../../srv/env-setup', () => ({}), { virtual: true });

import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';
import { logger } from '../../srv/lib/logger';

function makeConn() {
  return new CloudSdkAbapConnection(
    {
      url: 'http://sap.example.com:44300',
      authType: 'basic',
      username: 'DEVELOPER',
      password: 'configured-sap-password',
      client: '600',
    },
    'S4HANA_QAS',
  );
}

function lastOpts() {
  const calls = mockExec.mock.calls;
  return calls[calls.length - 1][1] as { timeout?: number };
}

beforeEach(() => jest.clearAllMocks());

describe('CloudSdkAbapConnection.makeAdtRequest deadline', () => {
  const send = (conn: CloudSdkAbapConnection, timeout: number | undefined) =>
    // Older callers can omit the timeout field.
    conn.makeAdtRequest({
      url: '/sap/bc/adt/repository/informationsystem/search',
      method: 'GET',
      ...(timeout === undefined ? {} : { timeout }),
    } as AbapRequestOptions);

  beforeEach(() =>
    mockExec.mockResolvedValue({
      status: 200,
      data: '<ok/>',
      headers: {},
      request: {},
    }),
  );

  it.each([
    ['set by the caller', 90_000],
    ['0 from the ADT client', 0],
    ['omitted', undefined],
  ])('sends no timeout when it is %s', async (_label, timeout) => {
    await send(makeConn(), timeout);
    expect(mockExec).toHaveBeenCalled();
    expect(lastOpts().timeout).toBeUndefined();
  });

  it('sends none inside a critical section either', async () => {
    const conn = makeConn();
    conn.beginCriticalSection();
    await send(conn, 30_000);
    expect(lastOpts().timeout).toBeUndefined();
    conn.endCriticalSection();
  });
});

it.each(['text', 'object'] as const)(
  'forwards the full SAP %s failure and masks credentials in the full diagnostic log',
  async (format) => {
    const detail = 'SAP refused the operation. '.repeat(150);
    const tail = 'Last SAP diagnostic';
    const data =
      format === 'text'
        ? `<error>${detail}<Password>xml-secret-value</Password> configured-sap-password ${tail}</error>`
        : {
            message: detail,
            password: 'object-secret-value',
            req: { reason: tail },
          };
    const loggedBody =
      format === 'text'
        ? `<error>${detail}<Password>«redacted»</Password> [redacted] ${tail}</error>`
        : JSON.stringify({
            message: detail,
            password: '«redacted»',
            req: { reason: tail },
          });
    const forwardedBody = structuredClone(data);
    const error = Object.assign(new Error('Request failed'), {
      response: {
        status: 400,
        data,
        headers: {
          'set-cookie': 'sid=secret-cookie',
          'x-csrf-token': 'csrf-secret',
        },
      },
    });
    mockExec.mockRejectedValueOnce(error);
    const log = jest.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await expect(
        makeConn().makeAdtRequest({
          url: '/sap/bc/adt/discovery',
          method: 'GET',
          timeout: 0,
        }),
      ).rejects.toMatchObject({
        response: { status: 400, data: forwardedBody },
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('ADT request failed'),
        expect.objectContaining({ responseData: loggedBody }),
      );
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toMatch(
        /xml-secret-value|configured-sap-password|object-secret-value|secret-cookie|csrf-secret/,
      );
    } finally {
      log.mockRestore();
    }
  },
);
