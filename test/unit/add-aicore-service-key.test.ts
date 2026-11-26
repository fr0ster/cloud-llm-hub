import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const { parseDotenv } = require('../../tools/set-env-from-dotenv.js');

const tool = path.resolve(__dirname, '../../tools/add-aicore-service-key.js');
const authBase = 'https://auth.example.invalid';
const apiBase = 'https://api.example.invalid/v2/';
const clientId = 'test-client';

const extension = [
  '# Deployment settings',
  'ID: test-deployment',
  'parameters: {LLM_AGENT_PROVIDER: sap-ai-sdk}',
  'modules:',
  '    - name: cloud-llm-hub-srv',
  '      properties:',
  '        LLM_AGENT_PROVIDER: "sap-ai-sdk"  # Provider override',
  '        LLM_AGENT_MODEL: "test-model"',
  '',
  '    - name: cloud-llm-hub',
  '      properties: {LLM_AGENT_PROVIDER: other-provider}',
  '# End of extension',
  '',
].join('\r\n');

let dir: string;
let envFile: string;
let mtaFile: string;
let keyFile: string;
let clientSecret: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicore-key-'));
  envFile = path.join(dir, '.env');
  mtaFile = path.join(dir, '.mtaext');
  keyFile = path.join(dir, 'service-key.json');
  clientSecret = `${randomUUID()}=+&|#`;
  writeKey();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeKey(omit = '') {
  const key = {
    clientid: omit === 'clientid' ? undefined : clientId,
    clientsecret: omit === 'clientsecret' ? undefined : clientSecret,
    url: omit === 'url' ? undefined : `${authBase}///`,
    serviceurls: {
      AI_API_URL: omit === 'serviceurls.AI_API_URL' ? undefined : apiBase,
    },
  };
  fs.writeFileSync(keyFile, JSON.stringify(key));
}

function run(...args: string[]) {
  return runWithNodeArgs([], ...args);
}

function runWithNodeArgs(nodeArgs: string[], ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [...nodeArgs, tool, keyFile, ...args],
    { cwd: dir, encoding: 'utf8' },
  );
  expect(result.error).toBeUndefined();
  for (const value of [clientId, clientSecret, authBase, apiBase]) {
    expect((result.stdout + result.stderr).includes(value)).toBe(false);
  }
  return result;
}

test('creates .env in the requested checkout and reports a missing .mtaext', () => {
  const checkout = fs.mkdtempSync(path.join(dir, 'deploy-checkout-'));
  const result = run('--dir', checkout, '--provider', 'sap-ai-sdk');
  const target = path.join(checkout, '.env');
  expect(result.status).toBe(0);
  expect(
    fs.readFileSync(target, 'utf8') ===
      `AICORE_AUTH_URL=${authBase}\nAICORE_CLIENT_ID=${clientId}\nAICORE_CLIENT_SECRET=${clientSecret}\nAICORE_BASE_URL=${apiBase}\n`,
  ).toBe(true);
  expect(fs.existsSync(envFile)).toBe(false);
  expect(fs.existsSync(path.join(checkout, '.mtaext'))).toBe(false);
  expect(result.stdout).toContain(`${target}: AICORE_AUTH_URL added`);
  expect(result.stdout).toContain(
    `${path.join(checkout, '.mtaext')}: missing, skipped`,
  );
});

test('updates .env in place, preserves other lines, and skips writing on a second run', () => {
  const existing = [
    '# AICORE_CLIENT_ID=commented',
    '',
    'KEEP = keep all spaces  ',
    `AICORE_AUTH_URL=${authBase}/`,
    '  AICORE_CLIENT_SECRET =old-value  # Credential',
    'AICORE_CLIENT_SECRET=duplicate-value',
    `AICORE_BASE_URL= ${apiBase}  `,
    '# End of original file',
  ].join('\r\n');
  fs.writeFileSync(envFile, existing);

  const first = run();
  expect(first.status).toBe(0);
  expect(first.stdout).toContain(`${envFile}: AICORE_CLIENT_SECRET updated`);
  expect(first.stdout).toContain(`${envFile}: AICORE_CLIENT_ID added`);
  expect(first.stdout).toContain(`${envFile}: AICORE_BASE_URL updated`);
  const updated = existing
    .replace(`${authBase}/`, authBase)
    .replace(
      '  AICORE_CLIENT_SECRET =old-value  # Credential',
      `  # Credential\r\nAICORE_CLIENT_SECRET=${clientSecret}`,
    )
    .replace('=duplicate-value', `=${clientSecret}`)
    .replace(`= ${apiBase}  `, `=${apiBase}`)
    .concat(`\r\nAICORE_CLIENT_ID=${clientId}\r\n`);
  expect(fs.readFileSync(envFile, 'utf8') === updated).toBe(true);

  fs.utimesSync(envFile, 946684800, 946684800);
  const modifiedAt = fs.statSync(envFile).mtimeMs;
  const second = run();
  expect(second.status).toBe(0);
  expect(second.stdout.trim().split(/\r?\n/)).toEqual(
    ['AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'BASE_URL'].map(
      (key) => `${envFile}: AICORE_${key} unchanged`,
    ),
  );
  expect(fs.readFileSync(envFile, 'utf8') === updated).toBe(true);
  expect(fs.statSync(envFile).mtimeMs).toBe(modifiedAt);
});

test('moves inline comments and round-trips bare credentials through the injector', () => {
  clientSecret = `${randomUUID()}\\'"#tag # literal`;
  writeKey();
  fs.writeFileSync(
    envFile,
    [
      ' \tAICORE_CLIENT_SECRET  =  "old \\" # inside"  # double quoted  ',
      "AICORE_CLIENT_SECRET= 'old' # single quoted",
      'AICORE_CLIENT_SECRET=old#literal  # unquoted',
      `AICORE_CLIENT_SECRET=${clientSecret} # comment after literal hash`,
      '',
    ].join('\r\n'),
  );

  expect(run().status).toBe(0);
  const updated = fs.readFileSync(envFile, 'utf8');
  expect(
    updated.startsWith(
      [
        ' \t# double quoted  ',
        `AICORE_CLIENT_SECRET=${clientSecret}`,
        '# single quoted',
        `AICORE_CLIENT_SECRET=${clientSecret}`,
        '# unquoted',
        `AICORE_CLIENT_SECRET=${clientSecret}`,
        '# comment after literal hash',
        `AICORE_CLIENT_SECRET=${clientSecret}`,
        '',
      ].join('\r\n'),
    ),
  ).toBe(true);
  const injected: [string, string][] = parseDotenv(updated);
  expect(
    injected
      .filter(([key]) => key === 'AICORE_CLIENT_SECRET')
      .map(([, value]) => value === clientSecret),
  ).toEqual([true, true, true, true]);
  expect(run().status).toBe(0);
  expect(fs.readFileSync(envFile, 'utf8') === updated).toBe(true);
});

test('updates only the srv properties in .mtaext and preserves the surrounding YAML', () => {
  fs.writeFileSync(mtaFile, extension);
  const args = [
    '--provider',
    'sap-aicore-foundation',
    '--resource-group',
    'qa',
  ];
  const first = run(...args);
  expect(first.status).toBe(0);
  expect(first.stdout).toContain(`${mtaFile}: LLM_AGENT_PROVIDER updated`);
  expect(first.stdout).toContain(`${mtaFile}: LLM_AGENT_RESOURCE_GROUP added`);
  const updated = extension
    .replace(
      '"sap-ai-sdk"  # Provider override',
      '"sap-aicore-foundation"  # Provider override',
    )
    .replace(
      'LLM_AGENT_MODEL: "test-model"\r\n',
      'LLM_AGENT_MODEL: "test-model"\r\n        LLM_AGENT_RESOURCE_GROUP: qa\r\n',
    );
  expect(fs.readFileSync(mtaFile, 'utf8')).toBe(updated);

  const second = run(...args);
  expect(second.status).toBe(0);
  expect(second.stdout).toContain(`${mtaFile}: LLM_AGENT_PROVIDER unchanged`);
  expect(second.stdout).toContain(
    `${mtaFile}: LLM_AGENT_RESOURCE_GROUP unchanged`,
  );
  expect(fs.readFileSync(mtaFile, 'utf8')).toBe(updated);
});

test('adds the srv module to an extension with only top-level parameters', () => {
  const original =
    'ID: test-deployment\nparameters: { LLM_AGENT_MODEL: sample }\n';
  fs.writeFileSync(mtaFile, original);
  expect(run('--resource-group', 'default').status).toBe(0);
  expect(fs.readFileSync(mtaFile, 'utf8')).toBe(
    `${original}modules:\n  - name: cloud-llm-hub-srv\n    properties:\n      LLM_AGENT_RESOURCE_GROUP: default\n`,
  );
});

test('replaces a setting inside a flow mapping without changing its other entries', () => {
  const original =
    'modules: [{ name: cloud-llm-hub-srv, properties: {LLM_AGENT_RESOURCE_GROUP: old, KEEP: 123} }]\n';
  fs.writeFileSync(mtaFile, original);
  const result = run('--resource-group', 'qa, blue');
  expect(result.status).toBe(0);
  expect(fs.readFileSync(mtaFile, 'utf8')).toBe(
    original.replace('RESOURCE_GROUP: old', 'RESOURCE_GROUP: "qa, blue"'),
  );
});

test('updates an existing srv module whose name is an alias', () => {
  const original = [
    'srvName: &srvName cloud-llm-hub-srv',
    'modules:',
    '  - name: *srvName',
    '    properties: {KEEP: 123}',
    '',
  ].join('\n');
  fs.writeFileSync(mtaFile, original);

  expect(run('--provider', 'sap-aicore-foundation').status).toBe(0);
  expect(fs.readFileSync(mtaFile, 'utf8')).toBe(
    original.replace(
      '{KEEP: 123}',
      '{LLM_AGENT_PROVIDER: sap-aicore-foundation, KEEP: 123}',
    ),
  );
});

test.each([false, true])(
  'gives srv its own properties map when srv defines the shared anchor: %s',
  (anchorOnSrv) => {
    const definition = [
      '    properties: &props # Shared properties',
      '      LLM_AGENT_PROVIDER: sap-ai-sdk',
      '      KEEP: {model: *model}',
    ];
    const srv = [
      '  - name: cloud-llm-hub-srv',
      ...(anchorOnSrv ? definition : ['    properties: *props # Srv settings']),
    ];
    const other = [
      '  - name: first',
      ...(anchorOnSrv ? ['    properties: *props # First use'] : definition),
    ];
    const original = [
      'model: &model sample',
      'modules:',
      ...(anchorOnSrv ? [...srv, ...other] : [...other, ...srv]),
      '  - {name: second, properties: *props}',
      '',
    ].join('\r\n');
    fs.writeFileSync(mtaFile, original);

    const args = [
      '--provider',
      'sap-aicore-foundation',
      '--resource-group',
      'qa',
    ];
    expect(run(...args).status).toBe(0);
    const updated = fs.readFileSync(mtaFile, 'utf8');
    expect(updated).toContain('  - {name: second, properties: *props}\r\n');
    expect(updated).toContain('# Shared properties\r\n');
    expect(updated).toContain(
      anchorOnSrv ? '# First use\r\n' : '# Srv settings\r\n',
    );

    const {
      modules,
      model,
    }: {
      modules: { name: string; properties: Record<string, unknown> }[];
      model: string;
    } = parse(updated);
    const byName = Object.fromEntries(
      modules.map(({ name, properties }) => [name, properties]),
    );
    expect(model).toBe('sample');
    expect(byName).toEqual({
      'cloud-llm-hub-srv': {
        LLM_AGENT_PROVIDER: 'sap-aicore-foundation',
        LLM_AGENT_RESOURCE_GROUP: 'qa',
        KEEP: { model: 'sample' },
      },
      first: { LLM_AGENT_PROVIDER: 'sap-ai-sdk', KEEP: { model: 'sample' } },
      second: { LLM_AGENT_PROVIDER: 'sap-ai-sdk', KEEP: { model: 'sample' } },
    });
    expect(byName.first).toBe(byName.second);
    expect(run(...args).status).toBe(0);
    expect(fs.readFileSync(mtaFile, 'utf8')).toBe(updated);
  },
);

test.each([
  ['*provider', '&provider sap-ai-sdk'],
  ['&provider sap-ai-sdk', '*provider'],
])(
  'detaches a shared provider value (%s) from the srv property',
  (srv, other) => {
    const srvModule = [
      '  - name: cloud-llm-hub-srv',
      '    properties:',
      `      LLM_AGENT_PROVIDER: ${srv}  # srv override`,
      '      KEEP: 123',
    ];
    const otherModule = [
      '  - name: first',
      `    properties: {LLM_AGENT_PROVIDER: ${other}}`,
    ];
    const original = [
      'modules:',
      ...(srv.startsWith('*')
        ? [...otherModule, ...srvModule]
        : [...srvModule, ...otherModule]),
      '  - name: second',
      '    properties: {LLM_AGENT_PROVIDER: *provider}',
      '',
    ].join('\n');
    fs.writeFileSync(mtaFile, original);

    expect(run('--provider', 'sap-aicore-foundation').status).toBe(0);
    const updated = fs.readFileSync(mtaFile, 'utf8');
    expect(updated).toContain(
      '      LLM_AGENT_PROVIDER: "sap-aicore-foundation"  # srv override\n      KEEP: 123\n',
    );
    expect(updated).toContain('properties: {LLM_AGENT_PROVIDER: *provider}\n');
    const {
      modules,
    }: {
      modules: { name: string; properties: { LLM_AGENT_PROVIDER: string } }[];
    } = parse(updated);
    expect(
      Object.fromEntries(
        modules.map(({ name, properties }) => [
          name,
          properties.LLM_AGENT_PROVIDER,
        ]),
      ),
    ).toEqual({
      'cloud-llm-hub-srv': 'sap-aicore-foundation',
      first: 'sap-ai-sdk',
      second: 'sap-ai-sdk',
    });
  },
);

test.each([
  ['writeFileSync', true],
  ['renameSync', true],
  ['renameSync', false],
])(
  'leaves original files intact after the second %s fails (existing .env: %s)',
  (operation, existingEnv) => {
    const originalEnv = '# Existing environment\nKEEP=original\n';
    const originalTime = 946684800;
    if (existingEnv) {
      fs.writeFileSync(envFile, originalEnv);
      fs.utimesSync(envFile, originalTime, originalTime);
    }
    fs.writeFileSync(mtaFile, extension);
    const preload = path.join(dir, 'fail-second-operation.cjs');
    fs.writeFileSync(
      preload,
      `const fs = require('node:fs');
const operation = '${operation}';
const original = fs[operation];
let calls = 0;
fs[operation] = (...args) => {
  if (++calls !== 2) return original(...args);
  if (operation === 'writeFileSync') original(args[0], args[1].slice(0, 1), args[2]);
  throw new Error('Injected file system failure');
};`,
    );
    const originalFiles = fs.readdirSync(dir);

    const result = runWithNodeArgs(
      ['--require', preload],
      '--resource-group',
      'qa',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Could not write ${mtaFile}.`);
    expect(fs.readdirSync(dir)).toEqual(originalFiles);
    if (existingEnv) {
      expect(fs.readFileSync(envFile, 'utf8') === originalEnv).toBe(true);
      expect(fs.statSync(envFile).mtimeMs).toBe(originalTime * 1000);
    }
    expect(fs.readFileSync(mtaFile, 'utf8')).toBe(extension);
  },
);

test.each(['clientid', 'clientsecret', 'url', 'serviceurls.AI_API_URL'])(
  'leaves both target files untouched when %s is missing',
  (field) => {
    const originalEnv = '# Existing environment\nKEEP=original\n';
    fs.writeFileSync(envFile, originalEnv);
    fs.writeFileSync(mtaFile, extension);
    writeKey(field);

    const result = run('--resource-group', 'qa');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Missing or invalid required service key fields: ${field}.`,
    );
    expect(fs.readFileSync(envFile, 'utf8')).toBe(originalEnv);
    expect(fs.readFileSync(mtaFile, 'utf8')).toBe(extension);
  },
);

test('reports malformed JSON without printing its contents or creating .env', () => {
  fs.writeFileSync(keyFile, `${clientSecret} ${authBase} ${apiBase}`);
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('invalid JSON');
  expect(fs.existsSync(envFile)).toBe(false);
});
