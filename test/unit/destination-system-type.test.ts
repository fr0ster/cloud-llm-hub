/**
 * A destination declares its system kind in its `SAP_SYSTEM_TYPE` property —
 * a BTP destination's additional property, or a field of the Cloud SDK
 * `destinations` entry. Read through the real Cloud SDK here: the field must
 * survive into `originalProperties`. Nothing is derived from the proxy type.
 */

jest.mock(
  '@sap/cds',
  () => {
    const log = () => ({ info() {}, warn() {}, error() {}, debug() {} });
    // destinationResolver reaches cds through require(), not the default import.
    return { __esModule: true, default: { log }, log };
  },
  { virtual: true },
);

import { parseDestinationConfig } from '../../srv/agent-config';
import { resolveDestinationSapConfig } from '../../srv/connections/destinationResolver';
import { setDestinationSource } from '../../srv/lib/btp-destinations';
import { createDestinationSource } from '../../srv/lib/destination-source';

const entries = [
  {
    name: 'CLOUD_SYS',
    url: 'https://cloud.example.invalid',
    proxyType: 'Internet',
    authentication: 'NoAuthentication',
    SAP_SYSTEM_TYPE: 'cloud',
  },
  {
    name: 'ONPREM_SYS',
    url: 'https://onprem.example.invalid',
    proxyType: 'OnPremise',
    authentication: 'NoAuthentication',
  },
  {
    name: 'BAD_SYS',
    url: 'https://bad.example.invalid',
    proxyType: 'Internet',
    authentication: 'NoAuthentication',
    SAP_SYSTEM_TYPE: 'Internet',
  },
];

const saved = process.env.destinations;
beforeAll(() => {
  process.env.destinations = JSON.stringify(entries);
  setDestinationSource(
    createDestinationSource({
      source: 'env',
      destinations: entries.map(({ name, url, proxyType, authentication }) => ({
        name,
        url,
        proxyType,
        authentication,
      })),
    }),
  );
});
afterAll(() => {
  if (saved === undefined) delete process.env.destinations;
  else process.env.destinations = saved;
});

describe('destinationResolver — SAP_SYSTEM_TYPE property', () => {
  it('reads the declared kind', async () => {
    const r = await resolveDestinationSapConfig('CLOUD_SYS');
    expect(r.systemType).toBe('cloud');
  });

  it('declares nothing when the property is absent — the proxy type is not a kind', async () => {
    const r = await resolveDestinationSapConfig('ONPREM_SYS');
    expect(r.proxyType).toBe('OnPremise');
    expect(r.systemType).toBeUndefined();
  });

  it('refuses an unknown value, naming the destination and the property', async () => {
    await expect(resolveDestinationSapConfig('BAD_SYS')).rejects.toThrow(
      /Destination "BAD_SYS" property SAP_SYSTEM_TYPE must be one of onprem, cloud, legacy; got "Internet"/,
    );
  });
});

describe('agent-config — env destinations', () => {
  const env = (list: unknown[]) =>
    ({
      LLM_AGENT_DESTINATION_SOURCE: 'env',
      destinations: JSON.stringify(list),
    }) as NodeJS.ProcessEnv;

  it('keeps a declared SAP_SYSTEM_TYPE field', () => {
    const cfg = parseDestinationConfig(env([entries[0], entries[1]]));
    expect(cfg).toMatchObject({
      source: 'env',
      destinations: [
        { name: 'CLOUD_SYS', systemType: 'cloud' },
        { name: 'ONPREM_SYS' },
      ],
    });
    if (cfg.source === 'env') {
      expect(cfg.destinations[1].systemType).toBeUndefined();
    }
  });

  it('reads the field case-insensitively, like the request-time resolver', () => {
    const lower = { ...entries[1], sap_system_type: 'cloud' };
    const cfg = parseDestinationConfig(env([lower]));
    expect(cfg).toMatchObject({ destinations: [{ systemType: 'cloud' }] });
    expect(() =>
      parseDestinationConfig(
        env([{ ...entries[1], Sap_System_Type: 'bogus' }]),
      ),
    ).toThrow(/field SAP_SYSTEM_TYPE must be one of/);
  });

  it('stops the start on an unknown value', () => {
    expect(() => parseDestinationConfig(env([entries[2]]))).toThrow(
      /destinations\[0\] \(BAD_SYS\) field SAP_SYSTEM_TYPE must be one of/,
    );
  });
});
