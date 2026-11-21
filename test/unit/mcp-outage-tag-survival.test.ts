import { return_error } from '@mcp-abap-adt/lib/utils';
import type { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';
import { logger } from '../../srv/lib/logger';
import { outageFromToolResult } from '../../srv/lib/mcp-outage';

const mockExec = jest.fn<
  ReturnType<typeof executeHttpRequest>,
  Parameters<typeof executeHttpRequest>
>();
jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: (...args: Parameters<typeof executeHttpRequest>) =>
    mockExec(...args),
}));
jest.mock('../../srv/env-setup', () => ({}), { virtual: true });

const tunnelFailure = 'Timed out waiting for tunnel to open';
const longDiagnostic = 'SAP proxy diagnostic. '.repeat(150);

describe('the connector outage tag survives return_error', () => {
  beforeEach(() => jest.spyOn(logger, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it.each([
    {
      status: 503,
      data: tunnelFailure,
      message: 'Service Unavailable',
      outage: 'tunnel_timeout',
      format: 'text',
    },
    {
      status: 502,
      data: 'no SAP Cloud Connector (SCC) connected',
      message: 'Bad Gateway',
      outage: 'no_scc_registration',
      format: 'text',
    },
    {
      status: 503,
      data: { diagnostic: longDiagnostic, error: { message: tunnelFailure } },
      message: tunnelFailure,
      outage: 'tunnel_timeout',
      format: 'a JSON body over 2000 characters',
    },
  ])(
    'detects $outage from $format',
    async ({ status, data, message, outage }) => {
      mockExec.mockRejectedValueOnce(
        Object.assign(new Error(message), { response: { status, data } }),
      );
      const conn = new CloudSdkAbapConnection(
        { url: 'http://sap.example.com:44300', authType: 'basic' },
        'S4HANA_DEV',
      );

      const result = await conn
        .makeAdtRequest({
          url: '/sap/bc/adt/discovery',
          method: 'GET',
          timeout: 0,
        })
        .catch(return_error);

      expect(outageFromToolResult(result, 'S4HANA_DEV')).toMatchObject({
        status: outage,
        destination: 'S4HANA_DEV',
      });
    },
  );
});
