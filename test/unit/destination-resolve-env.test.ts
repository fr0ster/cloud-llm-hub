jest.mock('@sap-cloud-sdk/connectivity', () => ({
  getDestination: jest.fn(async () => {
    // What the SDK answers for a name missing from `destinations`: it falls
    // back to the BTP Destination service, which a local run does not have.
    throw new Error("Could not find service binding of type 'destination'.");
  }),
}));

import { getDestination } from '@sap-cloud-sdk/connectivity';
import { resolveDestinationSapConfig } from '../../srv/connections/destinationResolver';
import { setDestinationSource } from '../../srv/lib/btp-destinations';
import {
  createDestinationSource,
  EnvDestinationSource,
} from '../../srv/lib/destination-source';

const env = (...names: string[]) =>
  names.map((name) => ({
    name,
    url: `https://${name.toLowerCase()}.example.com`,
    proxyType: 'Internet',
    authentication: 'NoAuthentication',
  }));

describe('env destination source: an unknown name', () => {
  it('names the variable and the destinations it does know', () => {
    const src = new EnvDestinationSource(env('SAP_DEV', 'SAP_QAS'));
    expect(src.refuse('SAP_PRD')).toBe(
      'destination SAP_PRD is not in the `destinations` variable (known: SAP_DEV, SAP_QAS)',
    );
    expect(src.refuse('SAP_DEV')).toBeNull();
  });

  it('is refused by the resolver in those words, not with BTP wording', async () => {
    setDestinationSource(
      createDestinationSource({ source: 'env', destinations: env('SAP_DEV') }),
    );
    const err = (await resolveDestinationSapConfig('SAP_PRD').catch(
      (e) => e,
    )) as Error;
    expect(err.message).toContain(
      'destination SAP_PRD is not in the `destinations` variable (known: SAP_DEV)',
    );
    expect(err.message).not.toMatch(/service binding/);
    expect(getDestination).not.toHaveBeenCalled();
  });

  it('leaves a known name to the Cloud SDK', async () => {
    setDestinationSource(
      createDestinationSource({ source: 'env', destinations: env('SAP_DEV') }),
    );
    await resolveDestinationSapConfig('SAP_DEV').catch(() => undefined);
    expect(getDestination).toHaveBeenCalledWith({ destinationName: 'SAP_DEV' });
  });
});
