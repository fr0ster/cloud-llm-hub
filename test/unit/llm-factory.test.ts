/**
 * Unit tests for the hub's LLM composition root (srv/lib/llm-factory.ts).
 *
 * llm-agent 27 providers read no environment, so the hub finds the AI Core
 * service key itself — where the SAP AI SDK used to look — and shares one
 * credential per account, because a credential's identity keys the 429 bucket.
 */

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
  }),
  { virtual: true },
);

import {
  apiKeyCredential,
  getAiCoreAccess,
  makeHubLlm,
  readAiCoreServiceKey,
  resetLlmCredentials,
} from '../../srv/lib/llm-factory';

const key = (apiUrl: string) =>
  JSON.stringify({
    clientid: 'id',
    clientsecret: 'secret',
    url: 'https://auth.example.com',
    serviceurls: { AI_API_URL: apiUrl },
  });

describe('llm-factory', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetLlmCredentials();
    delete process.env.VCAP_SERVICES;
    delete process.env.AICORE_SERVICE_KEY;
  });

  afterAll(() => {
    process.env = saved;
  });

  it('prefers the aicore binding in VCAP_SERVICES over AICORE_SERVICE_KEY', () => {
    process.env.VCAP_SERVICES = JSON.stringify({
      aicore: [{ credentials: JSON.parse(key('https://bound.example.com')) }],
    });
    process.env.AICORE_SERVICE_KEY = key('https://env.example.com');
    expect(getAiCoreAccess().apiBaseUrl).toBe('https://bound.example.com');
  });

  it('accepts the ai-core binding name', () => {
    process.env.VCAP_SERVICES = JSON.stringify({
      'ai-core': [{ credentials: JSON.parse(key('https://dash.example.com')) }],
    });
    expect(getAiCoreAccess().apiBaseUrl).toBe('https://dash.example.com');
  });

  it('falls back to AICORE_SERVICE_KEY without a binding', () => {
    process.env.VCAP_SERVICES = JSON.stringify({ xsuaa: [{}] });
    process.env.AICORE_SERVICE_KEY = key('https://env.example.com');
    expect(getAiCoreAccess().apiBaseUrl).toBe('https://env.example.com');
  });

  it('names what is missing when there is no service key at all', () => {
    expect(() => readAiCoreServiceKey()).toThrow(/AICORE_SERVICE_KEY/);
  });

  it('builds the sap-ai-sdk LLM without a service key, failing only when used', async () => {
    // The AI Core binding is optional: a deployment without it must start.
    const llm = await makeHubLlm(
      { provider: 'sap-ai-sdk', model: 'anthropic--claude-4.5-sonnet' },
      0.7,
    );
    expect(llm.model).toBe('anthropic--claude-4.5-sonnet');
    await expect(getAiCoreAccess().credential.token()).rejects.toThrow(
      /AICORE_SERVICE_KEY/,
    );
  });

  it('shares one AI Core credential across the process', () => {
    process.env.AICORE_SERVICE_KEY = key('https://env.example.com');
    expect(getAiCoreAccess().credential).toBe(getAiCoreAccess().credential);
  });

  it('shares one API-key credential per key', () => {
    expect(apiKeyCredential('k1')).toBe(apiKeyCredential('k1'));
    expect(apiKeyCredential('k1')).not.toBe(apiKeyCredential('k2'));
  });

  it.each([
    ['openai', 'gpt-4o-mini'],
    ['anthropic', 'claude-x'],
    ['deepseek', 'deepseek-chat'],
  ] as const)(
    'builds an ILlm for %s with the requested model',
    async (provider, model) => {
      const llm = await makeHubLlm({ provider, apiKey: 'k', model }, 0.1);
      expect(llm.model).toBe(model);
    },
  );

  it('builds an ILlm for sap-ai-sdk from the service key', async () => {
    process.env.AICORE_SERVICE_KEY = key('https://env.example.com');
    const llm = await makeHubLlm(
      { provider: 'sap-ai-sdk', model: 'anthropic--claude-4.5-sonnet' },
      0.7,
    );
    expect(llm.model).toBe('anthropic--claude-4.5-sonnet');
  });
});
