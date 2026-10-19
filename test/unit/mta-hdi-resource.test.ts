import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';

interface Named {
  name: string;
  [key: string]: unknown;
}
interface Mta {
  resources: Named[];
  modules: (Named & { requires?: Named[] })[];
}

const mta = load(
  fs.readFileSync(path.join(__dirname, '..', '..', 'mta.yaml'), 'utf8'),
) as Mta;

describe('mta.yaml optional HDI resource (persistent RAG on HANA)', () => {
  const hdi = mta.resources.find(
    (r) => r.name === 'cloud-llm-hub-hdi',
  ) as Named;

  it('declares the HDI container resource', () => {
    expect(hdi).toBeDefined();
    expect(hdi.type).toBe('com.sap.xs.hdi-container');
    expect(hdi.parameters).toEqual({
      service: 'hana',
      'service-plan': 'hdi-shared',
    });
  });

  it('is inactive and optional by default', () => {
    expect(hdi.active).toBe(false);
    expect(hdi.optional).toBe(true);
  });

  it('is required by srv as optional, so an inactive resource cannot break the deploy', () => {
    const srv = mta.modules.find((m) => m.name === 'cloud-llm-hub-srv');
    const dep = srv?.requires?.find((r) => r.name === 'cloud-llm-hub-hdi');
    expect(dep).toEqual({ name: 'cloud-llm-hub-hdi', optional: true });
  });

  it('the srv module does not request it with a binding group or parameters', () => {
    // a plain optional requires: the app reads the binding from VCAP_SERVICES
    const names = mta.modules
      .filter((m) => m.name !== 'cloud-llm-hub-srv')
      .flatMap((m) => (m.requires ?? []).map((r) => r.name));
    expect(names).not.toContain('cloud-llm-hub-hdi');
  });
});
