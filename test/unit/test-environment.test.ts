import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cds from '@sap/cds';
import { config, configDotenv, parse } from 'dotenv';

const directory = mkdtempSync(join(tmpdir(), 'hub-test-env-'));
const envPath = join(directory, '.env');
const saved = process.env.HUB_TEST_LOCAL_ENV;

beforeAll(() => {
  writeFileSync(envPath, 'HUB_TEST_LOCAL_ENV=dummy\n');
  writeFileSync(join(directory, '.test.env'), 'HUB_TEST_LOCAL_ENV=dummy\n');
  writeFileSync(
    join(directory, 'default-env.json'),
    JSON.stringify({ HUB_TEST_LOCAL_ENV: 'dummy' }),
  );
});

beforeEach(() => {
  delete process.env.HUB_TEST_LOCAL_ENV;
});

afterAll(() => {
  if (saved === undefined) delete process.env.HUB_TEST_LOCAL_ENV;
  else process.env.HUB_TEST_LOCAL_ENV = saved;
  rmSync(directory, { recursive: true, force: true });
});

it('keeps CAP test profiles without loading local environment files', () => {
  const env = cds.env.for('cds', directory);
  expect(env.profiles).toContain('test');
  expect(env.profiles).toContain('development');
  expect(process.env.HUB_TEST_LOCAL_ENV).toBeUndefined();
});

it.each([config, configDotenv])(
  'ignores dotenv file loading, including an explicit file path',
  (load) => {
    load({ path: envPath });
    expect(process.env.HUB_TEST_LOCAL_ENV).toBeUndefined();
  },
);

it('ignores dotenv/config side effect imports', () => {
  const savedPath = process.env.DOTENV_CONFIG_PATH;
  process.env.DOTENV_CONFIG_PATH = envPath;
  try {
    jest.isolateModules(() => {
      require('dotenv/config');
    });
    expect(process.env.HUB_TEST_LOCAL_ENV).toBeUndefined();
  } finally {
    if (savedPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = savedPath;
  }
});

it('preserves explicitly supplied environment values and dotenv parsing', () => {
  process.env.HUB_TEST_LOCAL_ENV = 'explicit';
  cds.env.for('cds', directory);
  config({ path: envPath, override: true });
  expect(process.env.HUB_TEST_LOCAL_ENV).toBe('explicit');
  expect(parse('HUB_TEST_LOCAL_ENV=dummy')).toEqual({
    HUB_TEST_LOCAL_ENV: 'dummy',
  });
});
