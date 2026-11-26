import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const result = spawnSync(process.execPath, [tool, keyFile, ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  for (const value of [clientId, clientSecret, authBase, apiBase]) {
    expect(result.stdout + result.stderr).not.toContain(value);
  }
  return result;
}

test('creates .env in the requested checkout and reports a missing .mtaext', () => {
  const checkout = fs.mkdtempSync(path.join(dir, 'deploy-checkout-'));
  const result = run('--dir', checkout, '--provider', 'sap-ai-sdk');
  const target = path.join(checkout, '.env');
  expect(result.status).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe(
    `AICORE_AUTH_URL=${authBase}\nAICORE_CLIENT_ID=${clientId}\nAICORE_CLIENT_SECRET=${clientSecret}\nAICORE_BASE_URL=${apiBase}\n`,
  );
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
    '  AICORE_CLIENT_SECRET =old-value',
    'AICORE_CLIENT_SECRET=duplicate-value',
    `AICORE_BASE_URL= ${apiBase}  `,
    '# End of original file',
  ].join('\r\n');
  fs.writeFileSync(envFile, existing);

  const first = run();
  expect(first.status).toBe(0);
  expect(first.stdout).toContain(`${envFile}: AICORE_CLIENT_SECRET updated`);
  expect(first.stdout).toContain(`${envFile}: AICORE_CLIENT_ID added`);
  expect(first.stdout).toContain(`${envFile}: AICORE_BASE_URL unchanged`);
  const updated = existing
    .replace(`${authBase}/`, authBase)
    .replace('=old-value', `=${clientSecret}`)
    .replace('=duplicate-value', `=${clientSecret}`)
    .concat(`\r\nAICORE_CLIENT_ID=${clientId}\r\n`);
  expect(fs.readFileSync(envFile, 'utf8')).toBe(updated);

  fs.utimesSync(envFile, 946684800, 946684800);
  const modifiedAt = fs.statSync(envFile).mtimeMs;
  const second = run();
  expect(second.status).toBe(0);
  expect(second.stdout.trim().split(/\r?\n/)).toEqual(
    ['AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'BASE_URL'].map(
      (key) => `${envFile}: AICORE_${key} unchanged`,
    ),
  );
  expect(fs.readFileSync(envFile, 'utf8')).toBe(updated);
  expect(fs.statSync(envFile).mtimeMs).toBe(modifiedAt);
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
