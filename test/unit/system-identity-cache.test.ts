import { getSystemInformation } from '@mcp-abap-adt/adt-clients/core';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import cds from '@sap/cds';
import {
  bindSystemIdentity,
  resolveSystemIdentity,
  SystemIdentityCache,
  systemIdentitySession,
  warmSystemIdentity,
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
  sapConfig: { url: 'https://sap', client: '100', authType: 'jwt' as const },
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
      sapConfig: { ...input('unused').sapConfig, authType: 'basic', username },
    });
  expect(session('alice')?.key).toBe(session(' ALICE ')?.key);
  expect(session('alice')?.key).not.toBe(session('bob')?.key);
});

it.each(
  userDependentAuthenticationTypes.filter(
    (type) => type !== 'PrincipalPropagation',
  ),
)(
  'keys effective basic overrides by login for %s',
  async (authenticationType) => {
    const connect = (username: string) => {
      const conn = {} as IAbapConnection;
      bindSystemIdentity(conn, {
        ...input('same-jwt-user'),
        destinationName: `override-${authenticationType}`,
        authenticationType,
        sapConfig: { url: 'https://sap', authType: 'basic', username },
      });
      return conn;
    };
    jest
      .mocked(getSystemInformation)
      .mockResolvedValueOnce({ userName: 'ALICE' })
      .mockResolvedValueOnce({ userName: 'BOB' });
    expect(await resolveSystemIdentity(connect('alice'))).toEqual({
      responsible: 'ALICE',
    });
    expect(await resolveSystemIdentity(connect('bob'))).toEqual({
      responsible: 'BOB',
    });
    expect(await resolveSystemIdentity(connect(' ALICE '))).toEqual({
      responsible: 'ALICE',
    });
    expect(getSystemInformation).toHaveBeenCalledTimes(2);
  },
);

it.each(['onprem', 'legacy'] as const)(
  'caches unavailable endpoints during %s warm-up without warnings',
  async (systemType) => {
    const warn = jest
      .spyOn(cds.log('system-identity'), 'warn')
      .mockImplementation();
    try {
      for (const status of [404, 405]) {
        jest
          .mocked(getSystemInformation)
          .mockClear()
          .mockRejectedValue({ response: { status } });
        const user = `warm-${systemType}-${status}`;
        await warmSystemIdentity(connection(user), systemType);
        await warmSystemIdentity(connection(user), systemType);
        expect(getSystemInformation).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
      }
    } finally {
      warn.mockRestore();
    }
  },
);

it.each([
  ['onprem', 500],
  ['legacy', 500],
  ['cloud', 404],
  ['cloud', 405],
  ['cloud', 500],
] as const)(
  'retries %s warm-up failure %s and warns by class once per failure',
  async (systemType, status) => {
    const warn = jest
      .spyOn(cds.log('system-identity'), 'warn')
      .mockImplementation();
    const error = Object.assign(new TypeError('sensitive details'), {
      response: { status },
    });
    jest.mocked(getSystemInformation).mockRejectedValue(error);
    try {
      const user = `warm-transient-${systemType}-${status}`;
      await expect(
        warmSystemIdentity(connection(user), systemType),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      await expect(
        warmSystemIdentity(connection(user), systemType),
      ).resolves.toBeUndefined();
      expect(getSystemInformation).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([
        ['System identity lookup failed', { error: 'TypeError' }],
        ['System identity lookup failed', { error: 'TypeError' }],
      ]);
    } finally {
      warn.mockRestore();
    }
  },
);

it.each(['basic', 'jwt'] as const)(
  'scopes %s identities to the resolved system and shares equivalent URLs',
  async (authType) => {
    const connect = (url: string) => {
      const conn = {} as IAbapConnection;
      bindSystemIdentity(conn, {
        destinationName: `system-scope-${authType}`,
        authenticationType:
          authType === 'basic'
            ? 'BasicAuthentication'
            : 'OAuth2ClientCredentials',
        sapConfig: { url, authType, username: 'TECH', client: '100' },
      });
      return conn;
    };
    jest
      .mocked(getSystemInformation)
      .mockResolvedValueOnce({ userName: 'FIRST', systemID: 'ONE' })
      .mockResolvedValueOnce({ userName: 'SECOND', systemID: 'TWO' });
    expect(
      await resolveSystemIdentity(connect('HTTPS://FIRST.sap:443/')),
    ).toEqual({
      responsible: 'FIRST',
      masterSystem: 'ONE',
    });
    expect(await resolveSystemIdentity(connect('https://second.sap'))).toEqual({
      responsible: 'SECOND',
      masterSystem: 'TWO',
    });
    expect(await resolveSystemIdentity(connect('https://first.sap'))).toEqual({
      responsible: 'FIRST',
      masterSystem: 'ONE',
    });
    expect(getSystemInformation).toHaveBeenCalledTimes(2);
  },
);

it('normalizes system URLs without retaining secrets and keeps system routing paths', () => {
  const session = (url: string) =>
    systemIdentitySession({
      destinationName: 'url-normalization',
      authenticationType: 'OAuth2ClientCredentials',
      sapConfig: { url, authType: 'jwt' },
    });
  const key = session(
    'HTTPS://user:secret@SAP:8443/system/?token=secret#secret',
  )?.key;
  expect(key).toBeDefined();
  expect(key).toBe(session('https://sap:8443/system')?.key);
  expect(key).not.toContain('secret');
  expect(key).not.toBe(session('https://sap:8443/other')?.key);
  expect(key).not.toBe(session('https://sap:9443/system')?.key);
  expect(session('invalid')).toBeUndefined();
});
