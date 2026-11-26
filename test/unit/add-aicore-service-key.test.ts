import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { parseDotenv } = require('../../tools/set-env-from-dotenv.js');

const tool = path.resolve(__dirname, '../../tools/add-aicore-service-key.js');
const authBase = 'https://auth.example.invalid';
const apiBase = 'https://api.example.invalid/v2/';
const clientId = 'test-client';

let dir: string;
let envFile: string;
let keyFile: string;
let clientSecret: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicore-key-'));
  envFile = path.join(dir, '.env');
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

test('creates .env in the requested checkout', () => {
  const checkout = fs.mkdtempSync(path.join(dir, 'deploy-checkout-'));
  const result = run('--dir', checkout);
  const target = path.join(checkout, '.env');
  expect(result.status).toBe(0);
  expect(
    fs.readFileSync(target, 'utf8') ===
      `AICORE_AUTH_URL=${authBase}\nAICORE_CLIENT_ID=${clientId}\nAICORE_CLIENT_SECRET=${clientSecret}\nAICORE_BASE_URL=${apiBase}\n`,
  ).toBe(true);
  expect(fs.existsSync(envFile)).toBe(false);
  expect(result.stdout).toContain(`${target}: AICORE_AUTH_URL added`);
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

test.each([
  ['writeFileSync', true],
  ['renameSync', true],
  ['renameSync', false],
])(
  'leaves .env intact when %s fails (existing .env: %s)',
  (operation, existingEnv) => {
    const originalEnv = '# Existing environment\nKEEP=original\n';
    const originalTime = 946684800;
    if (existingEnv) {
      fs.writeFileSync(envFile, originalEnv);
      fs.utimesSync(envFile, originalTime, originalTime);
    }
    const preload = path.join(dir, 'fail-dotenv-write.cjs');
    fs.writeFileSync(
      preload,
      `const fs = require('node:fs');
const operation = '${operation}';
const original = fs[operation];
fs[operation] = (...args) => {
  if (operation === 'writeFileSync') original(args[0], args[1].slice(0, 1), args[2]);
  throw new Error('Injected file system failure');
};`,
    );
    const originalFiles = fs.readdirSync(dir);

    const result = runWithNodeArgs(['--require', preload]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Could not write ${envFile}.`);
    expect(fs.readdirSync(dir)).toEqual(originalFiles);
    if (existingEnv) {
      expect(fs.readFileSync(envFile, 'utf8') === originalEnv).toBe(true);
      expect(fs.statSync(envFile).mtimeMs).toBe(originalTime * 1000);
    }
  },
);

test.each(['clientid', 'clientsecret', 'url', 'serviceurls.AI_API_URL'])(
  'leaves .env untouched when %s is missing',
  (field) => {
    const originalEnv = '# Existing environment\nKEEP=original\n';
    fs.writeFileSync(envFile, originalEnv);
    writeKey(field);

    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Missing or invalid required service key fields: ${field}.`,
    );
    expect(fs.readFileSync(envFile, 'utf8')).toBe(originalEnv);
  },
);

test('reports malformed JSON without printing its contents or creating .env', () => {
  fs.writeFileSync(keyFile, `${clientSecret} ${authBase} ${apiBase}`);
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('invalid JSON');
  expect(fs.existsSync(envFile)).toBe(false);
});
