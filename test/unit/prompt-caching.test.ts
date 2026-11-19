import { AnthropicProvider } from '@mcp-abap-adt/anthropic-llm';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import { clearAgentConfig, loadAgentConfig } from '../../srv/agent-config';
import {
  buildLlmOnlyAgent,
  buildPlannerAgent,
  createToolQueryAnalyzer,
  initProviders,
} from '../../srv/agent-manager';
import { BuildValidationError } from '../../srv/lib/build-validation-error';
import {
  configuredPromptCaching,
  type PromptCachingRole,
} from '../../srv/lib/deploy-role-config';
import { hubLlmKey, makeHubLlm } from '../../srv/lib/llm-factory';
import { startProviders } from '../../srv/lib/providers';
import { withRoleModels } from '../../srv/lib/role-models-scope';
import { SessionLlms } from '../../srv/lib/session-llms';
import { bindTestCaller } from './helpers/bind-test-caller';

const roles: PromptCachingRole[] = [
  'coordinator',
  'planner',
  'executor',
  'checker',
  'classifier',
];
const saved = { ...process.env };

beforeEach(() => {
  process.env = { ...saved };
  for (const name of Object.keys(process.env))
    if (name.startsWith('LLM_AGENT_')) delete process.env[name];
  clearAgentConfig();
});

afterEach(() => {
  process.env = { ...saved };
  clearAgentConfig();
  jest.restoreAllMocks();
});

test('prompt caching defaults to on, including empty deployment parameters', () => {
  expect(configuredPromptCaching(undefined, {})).toBe(true);
  for (const role of roles) {
    expect(configuredPromptCaching(role, {})).toBe(true);
    expect(
      configuredPromptCaching(role, {
        LLM_AGENT_PROMPT_CACHING: '',
        [`LLM_AGENT_${role.toUpperCase()}_PROMPT_CACHING`]: '  ',
      }),
    ).toBe(true);
  }
});

test.each([
  ['on', true],
  ['true', true],
  ['off', false],
  ['false', false],
] as const)('global %s resolves to %s', (raw, expected) => {
  const env = { LLM_AGENT_PROMPT_CACHING: ` ${raw} ` };
  expect(configuredPromptCaching(undefined, env)).toBe(expected);
  for (const role of roles)
    expect(configuredPromptCaching(role, env)).toBe(expected);
});

test.each(roles)('%s overrides global in both directions', (role) => {
  const name = `LLM_AGENT_${role.toUpperCase()}_PROMPT_CACHING`;
  expect(
    configuredPromptCaching(role, {
      LLM_AGENT_PROMPT_CACHING: 'off',
      [name]: 'on',
    }),
  ).toBe(true);
  expect(
    configuredPromptCaching(role, {
      LLM_AGENT_PROMPT_CACHING: 'on',
      [name]: 'false',
    }),
  ).toBe(false);
});

test.each(['1', '0', 'enabled', '5m', 'ephemeral', 'ON'])(
  'rejects invalid global value %s even with a valid role override',
  (raw) => {
    expect(() =>
      configuredPromptCaching('executor', {
        LLM_AGENT_PROMPT_CACHING: raw,
        LLM_AGENT_EXECUTOR_PROMPT_CACHING: 'on',
      }),
    ).toThrow(BuildValidationError);
  },
);

test.each([
  'LLM_AGENT_PROMPT_CACHING',
  ...roles.map((role) => `LLM_AGENT_${role.toUpperCase()}_PROMPT_CACHING`),
])('rejects invalid %s at startup', (name) => {
  process.env[name] = 'invalid';
  expect(() => loadAgentConfig()).toThrow(BuildValidationError);
  expect(() => loadAgentConfig()).toThrow(name);
});

test.each(roles)(
  '%s reaches session provider configs on chat and streams',
  async (role) => {
    process.env.LLM_AGENT_PROMPT_CACHING = 'on';
    process.env[`LLM_AGENT_${role.toUpperCase()}_PROMPT_CACHING`] = 'off';
    const providers: OpenAIProvider[] = [];
    jest
      .spyOn(OpenAIProvider.prototype, 'chat')
      .mockImplementation(async function (this: OpenAIProvider) {
        providers.push(this);
        return { content: 'ok', finishReason: 'stop' };
      });
    jest
      .spyOn(OpenAIProvider.prototype, 'streamChat')
      .mockImplementation(async function* (this: OpenAIProvider) {
        providers.push(this);
        yield { content: 'ok', finishReason: 'stop' };
      });
    const cfg = {
      provider: 'openai' as const,
      apiKey: 'test',
      model: 'test',
      role,
    };
    const offKey = hubLlmKey(cfg, undefined);
    const llm = await makeHubLlm(cfg, undefined);
    process.env[`LLM_AGENT_${role.toUpperCase()}_PROMPT_CACHING`] = 'on';
    expect(hubLlmKey(cfg, undefined)).not.toBe(offKey);
    const enabled = await makeHubLlm(cfg, undefined);
    const session = new SessionLlms();
    try {
      await session.run(async () => {
        await llm.chat([]);
        for await (const chunk of llm.streamChat([]))
          expect(chunk.ok).toBe(true);
        await enabled.chat([]);
      });
      expect(
        providers.map((provider) => provider.config.promptCaching),
      ).toEqual([false, false, true]);
      expect(providers[0]).toBe(providers[1]);
      expect(providers[0]).not.toBe(providers[2]);
    } finally {
      session.dispose();
    }
  },
);

test('Anthropic provider receives the default on and global off', async () => {
  const seen: (boolean | undefined)[] = [];
  jest
    .spyOn(AnthropicProvider.prototype, 'chat')
    .mockImplementation(async function (this: AnthropicProvider) {
      seen.push(this.config.promptCaching);
      return { content: 'ok', finishReason: 'stop' };
    });
  const cfg = { provider: 'anthropic' as const, apiKey: 'test', model: 'test' };
  await (await makeHubLlm(cfg, undefined)).chat([]);
  process.env.LLM_AGENT_PROMPT_CACHING = 'off';
  await (await makeHubLlm(cfg, undefined)).chat([]);
  expect(seen).toEqual([true, false]);
});

test('coordinator model switches and classifier analysis keep their own caching config', async () => {
  process.env.LLM_AGENT_PROVIDER = 'openai';
  process.env.LLM_AGENT_MODEL = 'main';
  process.env.LLM_AGENT_MODELS = 'main,switched';
  process.env.LLM_AGENT_API_KEY = 'test';
  process.env.LLM_AGENT_PROMPT_CACHING = 'off';
  process.env.LLM_AGENT_COORDINATOR_PROMPT_CACHING = 'on';
  process.env.LLM_AGENT_CLASSIFIER_PROMPT_CACHING = 'off';
  const config = loadAgentConfig();
  initProviders(await startProviders(config));
  const caller = {
    sessionId: 'caching-session',
    userId: 'test-user',
    isAdmin: false,
  };
  await bindTestCaller(caller);
  const seen: { model: string; promptCaching?: boolean }[] = [];
  const record = (provider: OpenAIProvider) => {
    seen.push({
      model: provider.model,
      promptCaching: provider.config.promptCaching,
    });
    return {
      content: '{"translation":"hello","needsAbapSystem":false,"writes":false}',
      finishReason: 'stop' as const,
    };
  };
  jest
    .spyOn(OpenAIProvider.prototype, 'chat')
    .mockImplementation(async function (this: OpenAIProvider) {
      return record(this);
    });
  jest
    .spyOn(OpenAIProvider.prototype, 'streamChat')
    .mockImplementation(async function* (this: OpenAIProvider) {
      yield record(this);
    });
  for (const model of ['main', 'switched']) {
    await withRoleModels({ coordinator: { model } }, async () => {
      const planner = await buildPlannerAgent(
        { ...config, llm: { ...config.llm, coordinatorModel: model } },
        'Answer briefly.',
      );
      await planner.process('hello', { caller, sessionId: caller.sessionId });
    });
  }
  const result = await createToolQueryAnalyzer().analyze('hello there');
  expect(result.needsAbapSystem).toBe(false);
  expect(seen).toEqual([
    { model: 'main', promptCaching: true },
    { model: 'switched', promptCaching: true },
    { model: 'main', promptCaching: false },
  ]);
});

test.each([undefined, 8192])(
  'tool query analyzer forwards the configured output limit %s',
  async (maxTokens) => {
    process.env.LLM_AGENT_PROVIDER = 'openai';
    process.env.LLM_AGENT_API_KEY = 'test';
    delete process.env.SAP_CORE_AI_MAX_TOKENS;
    if (maxTokens !== undefined)
      process.env.LLM_AGENT_MAX_TOKENS = String(maxTokens);
    const chat = jest
      .spyOn(OpenAIProvider.prototype, 'chat')
      .mockImplementation(async function (this: OpenAIProvider) {
        expect(this.config.maxTokens).toBe(maxTokens);
        return {
          content:
            '{"translation":"Inspect MARA","needsAbapSystem":true,"writes":false}',
          finishReason: 'stop',
        };
      });
    expect(await createToolQueryAnalyzer().analyze('Inspect MARA')).toEqual({
      text: 'Inspect MARA',
      needsAbapSystem: true,
      writes: false,
    });
    expect(chat).toHaveBeenCalledTimes(1);
  },
);

test('LLM-only guard uses classifier caching with the selected generation model', async () => {
  process.env.LLM_AGENT_PROVIDER = 'openai';
  process.env.LLM_AGENT_MODEL = 'guard-main';
  process.env.LLM_AGENT_MODELS = 'guard-main,guard-selected';
  process.env.LLM_AGENT_API_KEY = 'test';
  process.env.LLM_AGENT_PROMPT_CACHING = 'on';
  process.env.LLM_AGENT_CLASSIFIER_PROMPT_CACHING = 'off';
  const config = loadAgentConfig();
  initProviders(await startProviders(config));
  const caller = {
    sessionId: 'guard-session',
    userId: 'test-user',
    isAdmin: false,
  };
  await bindTestCaller(caller);
  const seen: { model: string; promptCaching?: boolean }[] = [];
  const record = (provider: OpenAIProvider) => {
    seen.push({
      model: provider.model,
      promptCaching: provider.config.promptCaching,
    });
    return { content: '{"action":false}', finishReason: 'stop' as const };
  };
  jest
    .spyOn(OpenAIProvider.prototype, 'chat')
    .mockImplementation(async function (this: OpenAIProvider) {
      return record(this);
    });
  jest
    .spyOn(OpenAIProvider.prototype, 'streamChat')
    .mockImplementation(async function* (this: OpenAIProvider) {
      yield record(this);
    });
  const handle = await buildLlmOnlyAgent(
    { ...config, llm: { ...config.llm, model: 'guard-selected' } },
    'waiting',
  );
  const result = await handle.agent.process('hello there', {
    caller,
    sessionId: caller.sessionId,
  });
  expect(result.ok).toBe(true);
  expect(seen).toEqual([
    { model: 'guard-selected', promptCaching: false },
    { model: 'guard-selected', promptCaching: true },
  ]);
});
