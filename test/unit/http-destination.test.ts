jest.mock('@sap-cloud-sdk/connectivity', () => ({ getDestination: jest.fn() }));

import { type Destination, getDestination } from '@sap-cloud-sdk/connectivity';
import { resolveHttpDestination } from '../../srv/connections/destinationResolver';

test('resolves a subaccount HTTP docs destination through the bound SDK without SAP metadata', async () => {
  const destination: Destination = {
    name: 'DOCS_MCP',
    url: 'https://docs.example.com/mcp',
    proxyType: 'Internet',
    authentication: 'NoAuthentication',
  };
  jest.mocked(getDestination).mockResolvedValue(destination);
  expect(await resolveHttpDestination('DOCS_MCP')).toBe(destination);
  expect(getDestination).toHaveBeenCalledWith({
    destinationName: 'DOCS_MCP',
    useCache: false,
  });
});
