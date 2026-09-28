/**
 * Unit tests for srv/lib/btp-oauth.ts — the client_credentials token cache.
 *
 * `wrappedAuth` exchanges a caller's Basic `sb-*` client id and secret for a
 * token through `getToken`. The cache must not hand out a token obtained with
 * one secret to a caller presenting a different one.
 *
 * Under test:
 * - the same client id and secret reuse the cached token
 * - a different secret for a cached client id goes to the token endpoint
 *   again, so a wrong secret fails there instead of receiving the cached token
 */

import { getToken } from '../../srv/lib/btp-oauth';

const TOKEN_URL = 'https://xsuaa.example/oauth/token';

function tokenResponse(token: string): Response {
  return new Response(
    JSON.stringify({ access_token: token, expires_in: 43200 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function secretFrom(init: RequestInit | undefined): string | null {
  return new URLSearchParams(String(init?.body)).get('client_secret');
}

describe('getToken cache', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) =>
      secretFrom(init) === 'right-secret'
        ? tokenResponse('token-for-right-secret')
        : new Response('{"error":"unauthorized"}', { status: 401 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reuses the cached token for the same client id and secret', async () => {
    const creds = {
      tokenUrl: TOKEN_URL,
      clientId: 'sb-reuse!t1',
      clientSecret: 'right-secret',
      uri: TOKEN_URL,
    };

    await expect(getToken(creds)).resolves.toBe('token-for-right-secret');
    await expect(getToken(creds)).resolves.toBe('token-for-right-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not return a cached token to a caller with a wrong secret', async () => {
    const clientId = 'sb-bypass!t1';
    await getToken({
      tokenUrl: TOKEN_URL,
      clientId,
      clientSecret: 'right-secret',
      uri: TOKEN_URL,
    });

    await expect(
      getToken({
        tokenUrl: TOKEN_URL,
        clientId,
        clientSecret: 'wrong-secret',
        uri: TOKEN_URL,
      }),
    ).rejects.toThrow('Token request failed: 401');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
