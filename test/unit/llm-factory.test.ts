import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { createUsageRecorder } from '@mcp-abap-adt/llm-usage';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';

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

test('real SmartAgent author calls retain their LLM component after the tool loop', async () => {
  const records: UsageRecord[] = [];
  const usage = createUsageRecorder({
    transport: {
      send: async (batch) => {
        records.push(...batch);
      },
      close: async () => {},
    },
  });
  const chat = jest
    .spyOn(OpenAIProvider.prototype, 'chat')
    .mockImplementation(async (_messages, _tools, options) => {
      options?.usage?.record({
        kind: 'llm.call',
        context: {},
        outcome: 'ok',
        durationMs: 1,
        operationId: 'author-call',
        physicalSeq: 1,
        outerAttempt: 1,
        providerAttempt: 1,
        granularity: 'request',
        retriesVisible: true,
        provider: 'openai',
        model: 'test',
        stream: false,
        tokensSource: 'unknown',
      });
      return { content: 'Plan', finishReason: 'stop' };
    });
  const stream = jest
    .spyOn(OpenAIProvider.prototype, 'streamChat')
    .mockImplementation(async function* (messages, tools, options) {
      yield await OpenAIProvider.prototype.chat(messages, tools, options);
    });
  try {
    const llm = await makeHubLlm(
      {
        provider: 'openai',
        apiKey: 'fake',
        model: 'test',
        component: 'planner-author',
      },
      0,
    );
    const { agent } = await new SmartAgentBuilder({ skipModelValidation: true })
      .withMainLlm(llm)
      .withClassification(false)
      .withMode('hard')
      .build();
    const result = await agent.process('Create a plan', {
      usage: usage.with({ component: 'planner', sessionId: 'author-session' }),
    });
    expect(result).toMatchObject({ ok: true, value: { content: 'Plan' } });
    expect(stream).toHaveBeenCalledTimes(1);
    await usage.close(1000);
    expect(
      records
        .filter((record) => record.kind === 'llm.call')
        .map((record) => record.context),
    ).toEqual([
      expect.objectContaining({
        component: 'planner-author',
        sessionId: 'author-session',
      }),
    ]);
  } finally {
    await usage.close(1000);
    chat.mockRestore();
    stream.mockRestore();
  }
});

test('author usage wrapper preserves adapter model and model discovery', async () => {
  const models = [{ id: 'test' }, { id: 'other' }];
  const getModels = jest
    .spyOn(OpenAIProvider.prototype, 'getModels')
    .mockResolvedValue(models);
  try {
    const config = {
      provider: 'openai' as const,
      apiKey: 'fake',
      model: 'test',
    };
    const original = await makeHubLlm(config, 0);
    const wrapped = await makeHubLlm(
      { ...config, component: 'planner-author' },
      0,
    );
    expect(wrapped.model).toBe(original.model);
    expect(wrapped.getModels).toEqual(expect.any(Function));
    expect(await wrapped.getModels?.()).toEqual(await original.getModels?.());
    expect(getModels).toHaveBeenCalledTimes(2);
  } finally {
    getModels.mockRestore();
  }
});
