import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const readJson = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

describe('deployed security roles', () => {
  const security = readJson('xs-security.json');
  const mta = yaml.load(
    fs.readFileSync(path.join(root, 'mta.yaml'), 'utf8'),
  ) as {
    resources: {
      name: string;
      parameters: {
        config?: {
          scopes: { name: string; 'grant-as-authority-to-apps'?: string[] }[];
        };
      };
    }[];
  };
  const scopes = mta.resources.find((r) => r.name === 'cloud-llm-hub-auth')
    ?.parameters.config?.scopes;

  it('defines only Reader, Developer and independent Admin', () => {
    const names = ['MCP_Reader', 'MCP_Developer', 'MCP_Admin'];
    expect(
      security['role-templates'].map((r: { name: string }) => r.name),
    ).toEqual(names);
    expect(scopes?.map((s) => s.name)).toEqual(
      names.map((n) => `$XSAPPNAME.${n}`),
    );
    expect(
      security['role-templates'].map(
        (r: { 'scope-references': string[] }) => r['scope-references'],
      ),
    ).toEqual([
      ['$XSAPPNAME.MCP_Reader'],
      ['$XSAPPNAME.MCP_Reader', '$XSAPPNAME.MCP_Developer'],
      ['$XSAPPNAME.MCP_Admin'],
    ]);
    expect(
      security['role-collections'].map(
        (r: { name: string; 'role-template-references': string[] }) => [
          r.name,
          r['role-template-references'],
        ],
      ),
    ).toEqual([
      ['MCP Reader Access', ['$XSAPPNAME.MCP_Reader']],
      ['MCP Developer Access', ['$XSAPPNAME.MCP_Developer']],
      ['MCP Admin Access', ['$XSAPPNAME.MCP_Admin']],
    ]);
  });

  it('grants Reader to the existing analyst consumer and Developer to its consumer', () => {
    expect(scopes?.map((s) => s['grant-as-authority-to-apps'])).toEqual([
      ['$XSAPPNAME(application,cloud-llm-hub-analyst-consumer-${space-guid})'],
      [
        '$XSAPPNAME(application,cloud-llm-hub-developer-consumer-${space-guid})',
      ],
      undefined,
    ]);
    for (const tier of ['analyst', 'developer']) {
      expect(
        mta.resources.some((r) => r.name === `cloud-llm-hub-${tier}-consumer`),
      ).toBe(true);
      const consumer = readJson(`xs-security-${tier}-consumer.json`);
      expect(consumer.authorities).toEqual(['$ACCEPT_GRANTED_AUTHORITIES']);
      expect(consumer.scopes).toEqual([]);
    }
  });
});
