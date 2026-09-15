/**
 * A network failure on the CSRF-retry path carries the connector's outage tag.
 *
 * The retry after a `403` re-fetches the token and re-sends the request once.
 * A failure there was rethrown before the connector's tagging block ran, so a
 * system that went away between the first attempt and the retry never closed
 * its destination. The verdict must come from the same tagging as every other
 * connect-phase failure — including its deliberate refusal to read a reset as
 * an outage, and without a second retry of a write.
 */

const mockExec = jest.fn();
jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: (...args: unknown[]) => mockExec(...args),
}));
jest.mock('../../srv/env-setup', () => ({}), { virtual: true });

import { CSRF_CONFIG } from '@mcp-abap-adt/connection';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';
import { asOutage } from '../../srv/lib/mcp-outage';

function makeConn() {
  return new CloudSdkAbapConnection(
    {
      url: 'http://sap.invalid:44300',
      authType: 'basic',
      username: 'U',
      password: 'P',
    } as never,
    'DEST',
  );
}

/** The token fetch answers; the first write is refused on CSRF; the retry meets `retryFailure`. */
function routeRetryFailure(retryFailure: Error) {
  const writes: string[] = [];
  mockExec.mockImplementation(
    async (_dest: unknown, opts: { method: string; url: string }) => {
      if (opts.url.endsWith(CSRF_CONFIG.ENDPOINT)) {
        return { status: 200, data: '', headers: { 'x-csrf-token': 'tok' } };
      }
      writes.push(opts.method);
      if (writes.length === 1) {
        throw Object.assign(new Error('Request failed with status code 403'), {
          response: { status: 403, data: 'CSRF token validation failed' },
        });
      }
      throw retryFailure;
    },
  );
  return writes;
}

const write = (conn: CloudSdkAbapConnection) =>
  conn.makeAdtRequest({
    url: '/sap/bc/adt/oo/classes',
    method: 'POST',
    data: '<class/>',
  } as never);

beforeEach(() => mockExec.mockReset());

describe('the CSRF-retry path', () => {
  it('tags a connect-phase failure of the retry, so the destination can close', async () => {
    const writes = routeRetryFailure(
      new Error('connect ECONNREFUSED 10.0.0.1:44300'),
    );

    const err = await write(makeConn()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/\[dns_or_network\]/);
    // The same verdict the embedded tool dispatch reads to close a destination.
    expect(asOutage(err, 'DEST')?.status).toBe('dns_or_network');
    // Tagged, not retried again: the write went out twice, as before.
    expect(writes).toEqual(['POST', 'POST']);
  });

  it('does not tag a reset, which may mean the write already ran', async () => {
    const writes = routeRetryFailure(new Error('socket hang up ECONNRESET'));

    const err = await write(makeConn()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/\[[a-z_]+\]/);
    expect(writes).toEqual(['POST', 'POST']);
  });
});
