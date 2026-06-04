import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const GEN = path.join(__dirname, '..', '..', 'tools', 'make-staging-mta.js');

const PROD_MTA = `_schema-version: 3.3.0
ID: cloud-llm-hub
version: 6.11.0
description: "A simple CAP project."
parameters:
  LLM_AGENT_PROVIDER: "sap-ai-sdk"
  APPROUTER_HOST: "cloud-llm-hub"
  CF_LANDSCAPE: "cfapps.eu10.hana.ondemand.com"
modules:
  - name: cloud-llm-hub-srv
    type: nodejs
    provides:
      - name: srv-api
    requires:
      - name: cloud-llm-hub-auth
      - name: cloud-llm-hub-ai-core
  - name: cloud-llm-hub
    type: approuter.nodejs
    parameters:
      routes:
        - route: \${APPROUTER_HOST}.\${CF_LANDSCAPE}
    properties:
      TENANT_HOST_PATTERN: "^(.*)-cloud-llm-hub.\${CF_LANDSCAPE}"
    requires:
      - name: srv-api
      - name: cloud-llm-hub-auth
resources:
  - name: cloud-llm-hub-auth
    parameters:
      path: ./xs-security.json
      config:
        xsappname: cloud-llm-hub-\${space-guid}
  - name: cloud-llm-hub-analyst-consumer
    parameters:
      path: ./xs-security-analyst-consumer.json
      config:
        xsappname: cloud-llm-hub-analyst-consumer-\${space-guid}
  - name: cloud-llm-hub-ai-core
    parameters:
      service: aicore
`;

const PROD_XS_AUTH = JSON.stringify(
  {
    xsappname: 'cloud-llm-hub-{space-guid}',
    scopes: [
      {
        name: '$XSAPPNAME.MCP_Analyst',
        'grant-as-authority-to-apps': [
          'cloud-llm-hub-analyst-consumer-abc!t000001',
        ],
      },
    ],
    authorities: ['$XSAPPNAME.MCP_Reader'],
    'role-collections': [
      {
        name: 'MCP Reader Access',
        description: 'Read-only access to ABAP objects via MCP.',
        'role-template-references': ['$XSAPPNAME.MCP_Reader'],
      },
    ],
  },
  null,
  2,
);

const PROD_XS_ANALYST = JSON.stringify(
  {
    xsappname: 'cloud-llm-hub-analyst-consumer-{space-guid}',
    authorities: ['cloud-llm-hub-abc!t000001.MCP_Analyst'],
  },
  null,
  2,
);

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML is dynamic
function run(srcDir: string): any {
  execFileSync('node', [GEN], { cwd: srcDir });
  return yaml.load(
    fs.readFileSync(path.join(srcDir, 'mta.staging.generated.yaml'), 'utf8'),
  );
}

describe('make-staging-mta', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtagen-'));
    fs.writeFileSync(path.join(dir, 'mta.yaml'), PROD_MTA);
    fs.writeFileSync(path.join(dir, 'xs-security.json'), PROD_XS_AUTH);
    fs.writeFileSync(
      path.join(dir, 'xs-security-analyst-consumer.json'),
      PROD_XS_ANALYST,
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON is dynamic
  function readJson(srcDir: string, file: string): any {
    return JSON.parse(fs.readFileSync(path.join(srcDir, file), 'utf8'));
  }

  test('renames ID to -staging', () => {
    expect(run(dir).ID).toBe('cloud-llm-hub-staging');
  });

  test('renames module names', () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic
    expect(run(dir).modules.map((m: any) => m.name)).toEqual([
      'cloud-llm-hub-staging-srv',
      'cloud-llm-hub-staging',
    ]);
  });

  test('renames resource names', () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic
    expect(run(dir).resources.map((r: any) => r.name)).toEqual([
      'cloud-llm-hub-staging-auth',
      'cloud-llm-hub-staging-analyst-consumer',
      'cloud-llm-hub-staging-ai-core',
    ]);
  });

  test('renames requires references', () => {
    const doc = run(dir);
    // biome-ignore lint/suspicious/noExplicitAny: dynamic
    expect(doc.modules[0].requires.map((r: any) => r.name)).toEqual([
      'cloud-llm-hub-staging-auth',
      'cloud-llm-hub-staging-ai-core',
    ]);
    // srv-api is NOT renamed (no cloud-llm-hub token)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic
    expect(doc.modules[1].requires.map((r: any) => r.name)).toEqual([
      'srv-api',
      'cloud-llm-hub-staging-auth',
    ]);
  });

  test('does NOT rename srv-api provides', () => {
    expect(run(dir).modules[0].provides[0].name).toBe('srv-api');
  });

  test('renames xsappname', () => {
    expect(run(dir).resources[0].parameters.config.xsappname).toBe(
      'cloud-llm-hub-staging-${space-guid}',
    );
  });

  test('renames TENANT_HOST_PATTERN', () => {
    expect(run(dir).modules[1].properties.TENANT_HOST_PATTERN).toBe(
      '^(.*)-cloud-llm-hub-staging.${CF_LANDSCAPE}',
    );
  });

  test('does NOT touch the route template', () => {
    expect(run(dir).modules[1].parameters.routes[0].route).toBe(
      '${APPROUTER_HOST}.${CF_LANDSCAPE}',
    );
  });

  test('does NOT touch APPROUTER_HOST parameter', () => {
    // host comes from .mtaext.staging, not the descriptor
    expect(run(dir).parameters.APPROUTER_HOST).toBe('cloud-llm-hub');
  });

  test('keeps version unchanged', () => {
    expect(run(dir).version).toBe('6.11.0');
  });

  test('is idempotent — no double -staging', () => {
    run(dir);
    fs.copyFileSync(
      path.join(dir, 'mta.staging.generated.yaml'),
      path.join(dir, 'mta.yaml'),
    );
    const doc = run(dir);
    expect(doc.ID).toBe('cloud-llm-hub-staging');
    expect(doc.modules[0].name).toBe('cloud-llm-hub-staging-srv');
  });

  test('repoints xs-security paths to generated copies', () => {
    const doc = run(dir);
    // biome-ignore lint/suspicious/noExplicitAny: dynamic
    const paths = doc.resources.map((r: any) => r.parameters?.path);
    expect(paths).toEqual([
      './xs-security.generated.json',
      './xs-security-analyst-consumer.generated.json',
      undefined, // ai-core has no path
    ]);
  });

  test('generates xs-security.generated.json with renamed xsappname + grant', () => {
    run(dir);
    const sec = readJson(dir, 'xs-security.generated.json');
    expect(sec.xsappname).toBe('cloud-llm-hub-staging-{space-guid}');
    expect(sec.scopes[0]['grant-as-authority-to-apps']).toEqual([
      'cloud-llm-hub-staging-analyst-consumer-abc!t000001',
    ]);
  });

  test('generates consumer xs-security with renamed authority target', () => {
    run(dir);
    const sec = readJson(dir, 'xs-security-analyst-consumer.generated.json');
    expect(sec.xsappname).toBe(
      'cloud-llm-hub-staging-analyst-consumer-{space-guid}',
    );
    expect(sec.authorities).toEqual([
      'cloud-llm-hub-staging-abc!t000001.MCP_Analyst',
    ]);
  });

  test('does NOT mutate the source xs-security.json', () => {
    run(dir);
    const src = readJson(dir, 'xs-security.json');
    expect(src.xsappname).toBe('cloud-llm-hub-{space-guid}');
  });

  test('suffixes role-collection names so they do not collide with prod', () => {
    run(dir);
    const sec = readJson(dir, 'xs-security.generated.json');
    expect(sec['role-collections'][0].name).toBe('MCP Reader Access (staging)');
    // role-template-references stay $XSAPPNAME-scoped (untouched).
    expect(sec['role-collections'][0]['role-template-references']).toEqual([
      '$XSAPPNAME.MCP_Reader',
    ]);
    // source file's role-collection name is unchanged.
    const src = readJson(dir, 'xs-security.json');
    expect(src['role-collections'][0].name).toBe('MCP Reader Access');
  });
});
