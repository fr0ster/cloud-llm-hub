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

  it('declares the HDI resource as an existing service with a placeholder name', () => {
    // An .mtaext cannot change a resource type, so the type that the
    // deployments use (an existing container holding the RAG tables) is fixed
    // here; a deployment sets only `active` and `service-name`.
    expect(hdi).toBeDefined();
    expect(hdi.type).toBe('org.cloudfoundry.existing-service');
    expect(hdi.parameters).toEqual({ 'service-name': '<your-hdi-service>' });
  });

  it('is inactive and optional by default', () => {
    expect(hdi.active).toBe(false);
    expect(hdi.optional).toBe(true);
  });

  it('is required by srv by name only: mbt rejects an optional field on a requires entry', () => {
    const srv = mta.modules.find((m) => m.name === 'cloud-llm-hub-srv');
    const dep = srv?.requires?.find((r) => r.name === 'cloud-llm-hub-hdi');
    expect(dep).toEqual({ name: 'cloud-llm-hub-hdi' });
  });

  it('the srv module does not request it with a binding group or parameters', () => {
    // a plain optional requires: the app reads the binding from VCAP_SERVICES
    const names = mta.modules
      .filter((m) => m.name !== 'cloud-llm-hub-srv')
      .flatMap((m) => (m.requires ?? []).map((r) => r.name));
    expect(names).not.toContain('cloud-llm-hub-hdi');
  });

  describe('the .mtaext templates', () => {
    const dir = path.join(
      __dirname,
      '..',
      '..',
      'docs',
      'deployment',
      'templates',
    );
    const templates = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mtaext.template'));

    it('there are six templates', () => {
      expect(templates).toHaveLength(6);
    });

    it.each(templates)(
      '%s sets only active and service-name for the HDI resource',
      (f) => {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        expect(text).toMatch(/# - name: cloud-llm-hub(-staging)?-hdi/);
        expect(text).toMatch(/#\s+active: true/);
        expect(text).toMatch(/#\s+parameters: \{ service-name: "[^"]+" \}/);
        // never a type override: an extension descriptor may not change it
        expect(text).not.toMatch(/^\s*#?\s*type:/m);
      },
    );

    it('the staging template never points at the production container', () => {
      const text = fs.readFileSync(
        path.join(dir, 'staging.mtaext.template'),
        'utf8',
      );
      expect(text).not.toContain('hdi-llm');
      expect(text).toContain('service-name: "<your-staging-hdi-service>"');
    });
  });
});
