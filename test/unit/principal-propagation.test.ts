jest.mock('../../srv/env-setup', () => ({}));
jest.mock('@sap/cds', () => {
  const log = () => ({ info() {}, warn() {}, debug() {}, error() {} });
  return { __esModule: true, default: { log }, log };
});
jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: jest.fn(),
}));
jest.mock('@sap-cloud-sdk/connectivity', () => ({ getDestination: jest.fn() }));
jest.mock('../../srv/lib/btp-oauth', () => ({
  getServiceCredentials: () => ({ uri: 'https://destination.invalid' }),
  getToken: async () => 'service-token',
}));

import { getDestination } from '@sap-cloud-sdk/connectivity';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import type { Request } from 'express';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';
import { resolveDestinationSapConfig } from '../../srv/connections/destinationResolver';
import {
  btpDestinationSource,
  setDestinationSource,
} from '../../srv/lib/btp-destinations';
import { extractSapContext } from '../../srv/mcp-manager';

const destination = {
  name: 'PP',
  url: 'http://virtual:443',
  proxyType: 'OnPremise',
  authentication: 'PrincipalPropagation',
} as const;
const sdkGet = jest.mocked(getDestination);
const savedFetch = global.fetch;
beforeEach(() => {
  sdkGet.mockReset().mockResolvedValue(destination);
  setDestinationSource({
    list: async () => [destination],
    clearCache() {},
    refuse: () => null,
  });
});
afterAll(() => {
  global.fetch = savedFetch;
});

test('resolves PP with user JWT and forwards jwt to SDK', async () => {
  const resolved = await resolveDestinationSapConfig('PP', 'user-jwt');
  expect(resolved.sapConfig).toMatchObject({
    authType: 'jwt',
    jwtToken: 'user-jwt',
  });
  expect(sdkGet.mock.calls).toEqual([
    [{ destinationName: 'PP' }],
    [{ destinationName: 'PP', jwt: 'user-jwt' }],
  ]);
  await expectRequestDestination(resolved.sapConfig, {
    destinationName: 'PP',
    jwt: 'user-jwt',
  });
});
test('missing user token fails with 401 before SDK proxy setup', async () => {
  await expect(resolveDestinationSapConfig('PP')).rejects.toMatchObject({
    statusCode: 401,
    code: 'SAP_USER_TOKEN_REQUIRED',
    message: expect.stringMatching(
      /principal propagation.*logged-in user token/,
    ),
  });
  expect(sdkGet).not.toHaveBeenCalled();
});
test('metadata warm-up needs no user or SDK connection', async () => {
  const resolved = await resolveDestinationSapConfig('PP', undefined, {
    metadataOnly: true,
  });
  expect(resolved.authenticationType).toBe('PrincipalPropagation');
  expect(resolved.sapConfig.jwtToken).toBeUndefined();
  expect(sdkGet).not.toHaveBeenCalled();
});
test('discovery retains PP and existing exclusion filters', async () => {
  const raw = {
    Name: 'PP',
    URL: 'http://virtual:443',
    ProxyType: 'OnPremise',
    Authentication: 'PrincipalPropagation',
    CloudConnectorLocationId: 'site',
  };
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => [
      raw,
      { ...raw, Name: 'ODATA', URL: 'http://virtual/sap/opu/odata/service' },
      { ...raw, Name: 'connectivity' },
      { ...raw, Name: 'INTERNET', ProxyType: 'Internet' },
    ],
  });
  const source = btpDestinationSource();
  source.clearCache();
  expect(await source.list()).toEqual([
    { ...destination, cloudConnectorLocationId: 'site' },
  ]);
});

test('extractSapContext forwards a lowercase bearer token for PP', async () => {
  const context = await extractSapContext({
    headers: { 'x-sap-destination': 'PP', authorization: 'bearer user-jwt' },
  } as unknown as Request);
  expect(context.destination?.authenticationType).toBe('PrincipalPropagation');
  expect(context.sapConfig.jwtToken).toBe('user-jwt');
  expect(sdkGet).toHaveBeenCalledWith({
    destinationName: 'PP',
    jwt: 'user-jwt',
  });
});

async function expectRequestDestination(
  config: ConstructorParameters<typeof CloudSdkAbapConnection>[0],
  expected: { destinationName: string; jwt?: string },
) {
  const execute = jest.mocked(executeHttpRequest);
  execute
    .mockReset()
    .mockResolvedValue({ data: '', status: 200, headers: {}, request: {} });
  const connection = new CloudSdkAbapConnection(config, 'PP');
  await connection.makeAdtRequest({
    url: '/sap/bc/adt/discovery',
    method: 'GET',
    timeout: 0,
  });
  expect(execute).toHaveBeenCalledWith(expected, expect.any(Object));
}

test.each(['BasicAuthentication', 'OAuth2ClientCredentials'] as const)(
  '%s ignores user JWT for resolution and HTTP requests',
  async (authentication) => {
    sdkGet.mockResolvedValue({ ...destination, authentication });
    const resolved = await resolveDestinationSapConfig('PP', 'user-jwt');
    expect(sdkGet.mock.calls).toEqual([[{ destinationName: 'PP' }]]);
    expect(resolved.sapConfig.jwtToken).toBeUndefined();
    await expectRequestDestination(resolved.sapConfig, {
      destinationName: 'PP',
    });
  },
);
