// Run before application imports and setupFilesAfterEnv: both CAP and
// srv/env-setup can otherwise populate process.env from local files.
jest.mock('@sap/cds/lib/env/cds-env.js', () => {
  // CAP exports Config.prototype. Keep its profiles and configuration intact,
  // but prevent .env, profile env files and default-env.json from injecting vars.
  const config = jest.requireActual<{
    _add_to_env(filename: string, env?: NodeJS.ProcessEnv): void;
  }>('@sap/cds/lib/env/cds-env.js');
  config._add_to_env = () => {};
  return config;
});

jest.mock('dotenv', () => ({
  ...jest.requireActual<typeof import('dotenv')>('dotenv'),
  config: () => ({ parsed: {} }),
  configDotenv: () => ({ parsed: {} }),
}));
