jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import {
  clearDestinationsCache,
  getAvailableDestinations,
  setDestinationSource,
} from '../../srv/lib/btp-destinations';
import {
  createDestinationSource,
  EnvDestinationSource,
} from '../../srv/lib/destination-source';

describe('DestinationSource', () => {
  it('env source lists the configured destinations as SapDestination', async () => {
    const src = new EnvDestinationSource([
      {
        name: 'SAP_DEV',
        url: 'https://sap.example.com:44300',
        proxyType: 'Internet',
        authentication: 'NoAuthentication',
        sapClient: '100',
      },
    ]);
    expect(await src.list()).toEqual([
      {
        name: 'SAP_DEV',
        url: 'https://sap.example.com:44300',
        proxyType: 'Internet',
        authentication: 'NoAuthentication',
      },
    ]);
  });

  it('getAvailableDestinations delegates to the injected source', async () => {
    setDestinationSource(
      createDestinationSource({
        source: 'env',
        destinations: [
          {
            name: 'SAP_QAS',
            url: 'https://qas.example.com',
            proxyType: 'Internet',
            authentication: 'NoAuthentication',
          },
        ],
      }),
    );
    expect((await getAvailableDestinations()).map((d) => d.name)).toEqual([
      'SAP_QAS',
    ]);
    clearDestinationsCache();
  });
});
