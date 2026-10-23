const systemAnswer = (
  info: { userName?: string; systemID?: string } | null,
) => ({
  ok: true as const,
  getResult: () => ({
    value: info
      ? { present: true as const, info }
      : { present: false as const },
  }),
});

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
const defaultTokenExpiry = Math.floor(Date.now() / 1000) + 3600;
const token = (user: string, exp = defaultTokenExpiry) =>
  `header.${Buffer.from(JSON.stringify({ sub: user, exp })).toString('base64url')}.signature`;
const input = (user: string) => ({
  destinationName: 'SAP',
  authenticationType: 'PrincipalPropagation',
  jwt: token(user),
  sapConfig: {
    url: 'https://sap',
    client: '100',
    authType: 'jwt' as const,
    jwtToken: token(user),
  },
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
    .mockResolvedValue(systemAnswer({ userName: 'USER', systemID: 'DEV' }));
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
    systemIdentitySession({
      ...input('expired'),
      jwt: token('expired', exp),
      sapConfig: {
        ...input('expired').sapConfig,
        jwtToken: token('expired', exp),
      },
    })?.expiresAt,
  ).toBe(exp * 1000);
});

it('expires a cached identity at JWT exp', async () => {
  jest.useFakeTimers();
  try {
    jest
      .mocked(getSystemInformation)
      .mockResolvedValue(systemAnswer({ userName: 'USER', systemID: 'DEV' }));
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
      sapConfig: {
        ...input(user).sapConfig,
        url: `https://users-${authenticationType.toLowerCase()}`,
        jwtToken: token(user, exp),
      },
    });
    const connect = (user: string) => {
      const conn = {} as IAbapConnection;
      bindSystemIdentity(conn, sessionInput(user));
      return conn;
    };
    jest
      .mocked(getSystemInformation)
      .mockResolvedValueOnce(
        systemAnswer({ userName: 'USER_A', systemID: 'DEV' }),
      )
      .mockResolvedValueOnce(
        systemAnswer({ userName: 'USER_B', systemID: 'DEV' }),
      );
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
  'disables caching without a user JWT for %s',
  (authenticationType) => {
    for (const jwt of [undefined, '']) {
      expect(
        systemIdentitySession({
          ...input('a'),
          authenticationType,
          jwt,
          sapConfig: { ...input('a').sapConfig, jwtToken: jwt },
        }),
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
    .mockResolvedValue(systemAnswer({ userName: 'TECH', systemID: 'DEV' }));
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
      sapConfig: {
        ...input('unused').sapConfig,
        authType: 'basic',
        username,
        password: 'password',
      },
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
        sapConfig: {
          url: `https://override-${authenticationType.toLowerCase()}`,
          authType: 'basic',
          username,
          password: 'password',
        },
      });
      return conn;
    };
    jest
      .mocked(getSystemInformation)
      .mockResolvedValueOnce(systemAnswer({ userName: 'ALICE' }))
      .mockResolvedValueOnce(systemAnswer({ userName: 'BOB' }));
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
        sapConfig: { url, authType, client: '100' },
      });
      return conn;
    };
    jest
      .mocked(getSystemInformation)
      .mockResolvedValueOnce(
        systemAnswer({ userName: 'FIRST', systemID: 'ONE' }),
      )
      .mockResolvedValueOnce(
        systemAnswer({ userName: 'SECOND', systemID: 'TWO' }),
      );
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

it('separates direct SAP JWT users and ignores the hub bearer and its expiry', async () => {
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const connect = (user: string, hub: string) => {
    const conn = {} as IAbapConnection;
    bindSystemIdentity(conn, {
      jwt: token(hub, 1),
      sapConfig: {
        url: 'https://direct-jwt',
        client: '100',
        authType: 'jwt',
        jwtToken: token(user, exp),
      },
    });
    return conn;
  };
  jest
    .mocked(getSystemInformation)
    .mockResolvedValueOnce(systemAnswer({ userName: 'SAP_A' }))
    .mockResolvedValueOnce(systemAnswer({ userName: 'SAP_B' }));
  expect(await resolveSystemIdentity(connect('a', 'hub'))).toEqual({
    responsible: 'SAP_A',
  });
  expect(await resolveSystemIdentity(connect('b', 'hub'))).toEqual({
    responsible: 'SAP_B',
  });
  expect(await resolveSystemIdentity(connect('a', 'other-hub'))).toEqual({
    responsible: 'SAP_A',
  });
  expect(getSystemInformation).toHaveBeenCalledTimes(2);
  expect(
    systemIdentitySession({
      jwt: token('hub', 1),
      sapConfig: {
        url: 'https://direct-jwt',
        authType: 'jwt',
        jwtToken: token('a', exp),
      },
    })?.expiresAt,
  ).toBe(exp * 1000);
});

it('keys direct basic sessions by uppercase SAP login, ignoring the hub JWT', () => {
  const session = (username: string, jwt: string) =>
    systemIdentitySession({
      jwt,
      sapConfig: { url: 'https://direct-basic', authType: 'basic', username },
    });
  expect(session('alice', token('a'))?.key).toBe(
    session(' ALICE ', token('b'))?.key,
  );
  expect(session('alice', token('a'))?.key).not.toBe(
    session('bob', token('a'))?.key,
  );
});

it('uses destination technical Basic identity when no override is sent', () => {
  const session = (destinationName: string, jwt: string) =>
    systemIdentitySession({
      destinationName,
      authenticationType: 'BasicAuthentication',
      jwt,
      sapConfig: { url: 'https://technical-basic', authType: 'basic' },
    });
  expect(session('technical', token('a'))).toBeDefined();
  expect(session('technical', token('a'))?.key).toBe(
    session('technical', token('b'))?.key,
  );
  expect(session('technical', token('a'))?.key).not.toBe(
    session('other', token('a'))?.key,
  );
});

it('separates refreshed tokens and destination routes for identical credentials', () => {
  const original = input('same-user');
  const refreshed = `${original.jwt}-refreshed`;
  const session = systemIdentitySession(original);
  expect(session?.key).toMatch(/jwt:[a-f0-9]{64}/);
  expect(session?.key).not.toContain(original.jwt);
  expect(
    systemIdentitySession({ ...original, destinationName: 'another' })?.key,
  ).not.toBe(session?.key);
  expect(
    systemIdentitySession({
      ...original,
      jwt: refreshed,
      sapConfig: { ...original.sapConfig, jwtToken: refreshed },
    })?.key,
  ).not.toBe(session?.key);
});

it.each([
  'opaque',
  'header.e30.signature',
  'header.invalid.signature',
  'header.bnVsbA.signature',
  'header.eyJleHAiOiIxIn0.signature',
])('uses configured TTL when token %s has no numeric exp', (jwtToken) => {
  jest.useFakeTimers();
  const previous = process.env.SYSTEM_IDENTITY_CACHE_TTL_MS;
  try {
    for (const ttl of [undefined, '12345']) {
      if (ttl === undefined) delete process.env.SYSTEM_IDENTITY_CACHE_TTL_MS;
      else process.env.SYSTEM_IDENTITY_CACHE_TTL_MS = ttl;
      const session = systemIdentitySession({
        sapConfig: { url: 'https://sap', authType: 'jwt', jwtToken },
      });
      expect(session?.expiresAt).toBe(
        Date.now() + (ttl ? Number(ttl) : 8 * 60 * 60 * 1000),
      );
    }
  } finally {
    if (previous === undefined) delete process.env.SYSTEM_IDENTITY_CACHE_TTL_MS;
    else process.env.SYSTEM_IDENTITY_CACHE_TTL_MS = previous;
    jest.useRealTimers();
  }
});

it('keeps URL and client in every principal row', () => {
  const rows: Parameters<typeof systemIdentitySession>[0][] = [
    input('routing'),
    {
      ...input('routing'),
      authenticationType: 'NoAuthentication',
      sapConfig: {
        url: 'https://sap',
        authType: 'basic',
        username: 'LOGIN',
        password: 'password',
      },
    },
    {
      ...input('routing'),
      authenticationType: 'BasicAuthentication',
      sapConfig: { url: 'https://sap', authType: 'basic' },
    },
    { ...input('routing'), authenticationType: 'OAuth2ClientCredentials' },
    { sapConfig: input('routing').sapConfig },
    { sapConfig: { url: 'https://sap', authType: 'basic', username: 'LOGIN' } },
  ];
  for (const row of rows) {
    const key = systemIdentitySession(row)?.key;
    expect(key).toBeDefined();
    for (const change of [{ url: 'https://other' }, { client: '200' }])
      expect(
        systemIdentitySession({
          ...row,
          sapConfig: { ...row.sapConfig, ...change },
        })?.key,
      ).not.toBe(key);
  }
});

it('leaves unsupported and ambiguous credentials uncached', () => {
  const rows: Parameters<typeof systemIdentitySession>[0][] = [
    {
      jwt: token('valid-hub'),
      sapConfig: { url: 'https://sap', authType: 'jwt' },
    },
    ...[undefined, 'Unknown', 'NoAuthentication'].map((authenticationType) => ({
      ...input('ambiguous'),
      authenticationType,
    })),
    {
      ...input('mismatch'),
      sapConfig: {
        ...input('mismatch').sapConfig,
        jwtToken: token('different'),
      },
    },
    {
      ...input('missing-forwarded'),
      sapConfig: { url: 'https://sap', authType: 'jwt' },
    },
    { sapConfig: { url: 'https://sap', authType: 'basic', username: ' ' } },
    {
      ...input('partial'),
      sapConfig: { url: 'https://sap', authType: 'basic', username: 'LOGIN' },
    },
    {
      ...input('partial'),
      sapConfig: {
        url: 'https://sap',
        authType: 'basic',
        password: 'password',
      },
    },
  ];
  for (const row of rows) expect(systemIdentitySession(row)).toBeUndefined();
});

it('separates destination routes with the same URL, client and JWT', async () => {
  jest
    .mocked(getSystemInformation)
    .mockResolvedValueOnce(
      systemAnswer({ userName: 'USER', systemID: 'SITE_A' }),
    )
    .mockResolvedValueOnce(
      systemAnswer({ userName: 'USER', systemID: 'SITE_B' }),
    );
  const connect = (destinationName: string) => {
    const conn = {} as IAbapConnection;
    bindSystemIdentity(conn, { ...input('routing'), destinationName });
    return conn;
  };
  expect(await resolveSystemIdentity(connect('LOCATION_A'))).toMatchObject({
    masterSystem: 'SITE_A',
  });
  expect(await resolveSystemIdentity(connect('LOCATION_B'))).toMatchObject({
    masterSystem: 'SITE_B',
  });
  expect(await resolveSystemIdentity(connect('LOCATION_A'))).toMatchObject({
    masterSystem: 'SITE_A',
  });
  expect(getSystemInformation).toHaveBeenCalledTimes(2);
});
