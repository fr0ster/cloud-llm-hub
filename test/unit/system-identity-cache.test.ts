import { getSystemInformation } from '@mcp-abap-adt/adt-clients/core';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import {
  bindSystemIdentity,
  resolveSystemIdentity,
  SystemIdentityCache,
  systemIdentitySession,
} from '../../srv/lib/system-identity-cache';

jest.mock('@mcp-abap-adt/adt-clients/core', () => ({
  getSystemInformation: jest.fn(),
}));
const token = (user: string, exp = Date.now() / 1000 + 3600) =>
  `header.${Buffer.from(JSON.stringify({ user_uuid: user, zid: 'tenant', exp })).toString('base64url')}.signature`;
const input = (user: string) => ({
  destinationName: 'SAP',
  authenticationType: 'PrincipalPropagation',
  jwt: token(user),
  sapConfig: { url: 'https://sap', client: '100', authType: 'basic' as const },
});
const connection = (user: string) => {
  const conn = {} as IAbapConnection;
  bindSystemIdentity(conn, input(user));
  return conn;
};
beforeEach(() => jest.mocked(getSystemInformation).mockReset());
it('reuses identity across requests and separates principals without retaining tokens', async () => {
  jest
    .mocked(getSystemInformation)
    .mockResolvedValue({ userName: 'USER', systemID: 'DEV' });
  await resolveSystemIdentity(connection('one'));
  await resolveSystemIdentity(connection('one'));
  expect(getSystemInformation).toHaveBeenCalledTimes(1);
  await resolveSystemIdentity(connection('two'));
  expect(getSystemInformation).toHaveBeenCalledTimes(2);
  expect(systemIdentitySession(input('one'))?.key).not.toContain(
    input('one').jwt,
  );
});
it('caches unavailable endpoints', async () => {
  jest
    .mocked(getSystemInformation)
    .mockRejectedValue({ response: { status: 404 } });
  await resolveSystemIdentity(connection('missing'));
  await resolveSystemIdentity(connection('missing'));
  expect(getSystemInformation).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 500, undefined])(
  'does not cache transient failure %s',
  async (status) => {
    jest
      .mocked(getSystemInformation)
      .mockRejectedValue({ response: { status } });
    await resolveSystemIdentity(connection(`transient-${status}`));
    await resolveSystemIdentity(connection(`transient-${status}`));
    expect(getSystemInformation).toHaveBeenCalledTimes(2);
  },
);
it('expires entries, respects JWT exp, and evicts the least recently used entry', () => {
  const cache = new SystemIdentityCache(2);
  cache.set('expired', null, Date.now() - 1);
  expect(cache.get('expired')).toBeUndefined();
  cache.set('a', null, Date.now() + 1000);
  cache.set('b', null, Date.now() + 1000);
  expect(cache.get('a')).toBeNull();
  cache.set('c', null, Date.now() + 1000);
  expect(cache.get('b')).toBeUndefined();
  const exp = Math.floor(Date.now() / 1000) - 1;
  expect(
    systemIdentitySession({ ...input('expired'), jwt: token('expired', exp) })
      ?.expiresAt,
  ).toBe(exp * 1000);
});

it('expires a cached identity at JWT exp', async () => {
  jest.useFakeTimers();
  try {
    jest
      .mocked(getSystemInformation)
      .mockResolvedValue({ userName: 'USER', systemID: 'DEV' });
    await resolveSystemIdentity(connection('expiring'));
    jest.advanceTimersByTime(3600001);
    await resolveSystemIdentity(connection('expiring'));
    expect(getSystemInformation).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

const userDependentAuthenticationTypes = [
  'PrincipalPropagation',
  'SAMLAssertion',
  'OAuth2SAMLBearerAssertion',
  'OAuth2UserTokenExchange',
  'OAuth2JWTBearer',
];

it.each(userDependentAuthenticationTypes)(
  'separates users and expires at JWT exp for %s',
  async (authenticationType) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sessionInput = (user: string) => ({
      ...input(user),
      destinationName: `users-${authenticationType}`,
      authenticationType,
      jwt: token(user, exp),
    });
    const connect = (user: string) => {
      const conn = {} as IAbapConnection;
      bindSystemIdentity(conn, sessionInput(user));
      return conn;
    };
    jest
      .mocked(getSystemInformation)
      .mockResolvedValueOnce({ userName: 'USER_A', systemID: 'DEV' })
      .mockResolvedValueOnce({ userName: 'USER_B', systemID: 'DEV' });
    expect(await resolveSystemIdentity(connect('a'))).toEqual({
      responsible: 'USER_A',
      masterSystem: 'DEV',
    });
    expect(await resolveSystemIdentity(connect('b'))).toEqual({
      responsible: 'USER_B',
      masterSystem: 'DEV',
    });
    expect(await resolveSystemIdentity(connect('a'))).toEqual({
      responsible: 'USER_A',
      masterSystem: 'DEV',
    });
    expect(getSystemInformation).toHaveBeenCalledTimes(2);
    expect(systemIdentitySession(sessionInput('a'))?.expiresAt).toBe(
      exp * 1000,
    );
  },
);

it.each(userDependentAuthenticationTypes)(
  'disables caching without a decodable user JWT for %s',
  (authenticationType) => {
    for (const jwt of [
      undefined,
      'invalid',
      token(''),
      'header.e30.signature',
    ]) {
      expect(
        systemIdentitySession({ ...input('a'), authenticationType, jwt }),
      ).toBeUndefined();
    }
  },
);

it('shares OAuth2ClientCredentials identity across JWT users', async () => {
  const connect = (user: string) => {
    const conn = {} as IAbapConnection;
    bindSystemIdentity(conn, {
      ...input(user),
      destinationName: 'technical-client',
      authenticationType: 'OAuth2ClientCredentials',
      sapConfig: { url: 'https://sap', authType: 'jwt' },
    });
    return conn;
  };
  jest
    .mocked(getSystemInformation)
    .mockResolvedValue({ userName: 'TECH', systemID: 'DEV' });
  await resolveSystemIdentity(connect('a'));
  expect(await resolveSystemIdentity(connect('b'))).toEqual({
    responsible: 'TECH',
    masterSystem: 'DEV',
  });
  expect(getSystemInformation).toHaveBeenCalledTimes(1);
});

it('keys NoAuthentication basic sessions by login', () => {
  const session = (username: string) =>
    systemIdentitySession({
      ...input('unused'),
      authenticationType: 'NoAuthentication',
      sapConfig: { ...input('unused').sapConfig, username },
    });
  expect(session('alice')?.key).toBe(session(' ALICE ')?.key);
  expect(session('alice')?.key).not.toBe(session('bob')?.key);
});
