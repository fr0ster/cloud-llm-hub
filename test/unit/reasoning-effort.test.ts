import {
  type LlmStreamChunk,
  type Message,
  REASONING_EFFORTS,
} from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import { loadAgentConfig } from '../../srv/agent-config';
import { BuildValidationError } from '../../srv/lib/build-validation-error';
import {
  configuredReasoningEffort,
  type PromptCachingRole,
} from '../../srv/lib/deploy-role-config';
import { hubLlmKey, makeHubLlm } from '../../srv/lib/llm-factory';
import { captureTokenUsage } from '../../srv/lib/llm-failure';
import { SessionLlms } from '../../srv/lib/session-llms';

const globalName = 'LLM_AGENT_REASONING_EFFORT';
const roles: PromptCachingRole[] = [
  'coordinator',
  'planner',
  'executor',
  'checker',
  'classifier',
];
const roleName = (role: PromptCachingRole) =>
  `LLM_AGENT_${role.toUpperCase()}_REASONING_EFFORT`;
const saved = process.env;

beforeEach(() => {
  process.env = { ...saved };
  for (const name of Object.keys(process.env))
    if (name.startsWith('LLM_AGENT_')) delete process.env[name];
});

afterEach(() => {
  process.env = saved;
  jest.restoreAllMocks();
});

test.each(REASONING_EFFORTS)('accepts global %s', (effort) => {
  const env = { [globalName]: effort };
  expect(configuredReasoningEffort(undefined, env)).toBe(effort);
  for (const role of roles)
    expect(configuredReasoningEffort(role, env)).toBe(effort);
});

test.each(roles)('%s overrides global and inherits when empty', (role) => {
  const env = { [globalName]: 'medium', [roleName(role)]: '  ' };
  expect(configuredReasoningEffort(role, env)).toBe('medium');
  env[roleName(role)] = 'none';
  expect(configuredReasoningEffort(role, env)).toBe('none');
  expect(configuredReasoningEffort(role, {})).toBeUndefined();
  expect(
    configuredReasoningEffort(role, {
      [globalName]: '',
      [roleName(role)]: '',
    }),
  ).toBeUndefined();
});

test.each([globalName, ...roles.map(roleName)])(
  'rejects invalid %s at startup and reports the allowed values',
  (name) => {
    process.env.LLM_AGENT_EXECUTOR_REASONING_EFFORT = 'high';
    process.env[name] = 'invalid';
    expect(() => loadAgentConfig()).toThrow(BuildValidationError);
    expect(() => loadAgentConfig()).toThrow(
      `Invalid ${name}: expected ${REASONING_EFFORTS.join(', ')}`,
    );
  },
);

test('session clients key on effective effort and forward provider output and usage', async () => {
  const cfg = {
    provider: 'openai',
    apiKey: 'test',
    model: 'test',
    component: 'planner-author',
    role: 'planner',
    contextCapture: 'off',
  } as const;
  const providerOutput = {
    protocol: 'openai-responses',
    items: [{ type: 'reasoning', encrypted_content: 'opaque' }],
  };
  const usage = {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    reasoningTokens: 3,
  };
  const providers: OpenAIProvider[] = [];
  jest
    .spyOn(OpenAIProvider.prototype, 'chat')
    .mockImplementation(async function (this: OpenAIProvider) {
      providers.push(this);
      return { content: 'ok', finishReason: 'stop', providerOutput, usage };
    });
  const stream = jest
    .spyOn(OpenAIProvider.prototype, 'streamChat')
    .mockImplementation(async function* (this: OpenAIProvider) {
      providers.push(this);
      yield { content: 'ok', finishReason: 'stop', providerOutput, usage };
    });

  const defaultKey = hubLlmKey(cfg, undefined);
  const defaultLlm = await makeHubLlm(cfg, undefined);
  process.env.LLM_AGENT_REASONING_EFFORT = 'medium';
  const globalKey = hubLlmKey(cfg, undefined);
  const globalLlm = await makeHubLlm(cfg, undefined);
  process.env.LLM_AGENT_PLANNER_REASONING_EFFORT = 'high';
  expect(new Set([defaultKey, globalKey, hubLlmKey(cfg, undefined)]).size).toBe(
    3,
  );
  const plannerLlm = await makeHubLlm(cfg, undefined);

  const session = new SessionLlms();
  try {
    await session.run(async () => {
      await defaultLlm.chat([]);
      const answer = await globalLlm.chat([]);
      if (!answer.ok) throw answer.error;
      expect(answer.value.providerOutput).toBe(providerOutput);
      expect(answer.value.usage).toEqual(usage);

      const messages: Message[] = [
        {
          role: 'assistant',
          content: answer.value.content,
          providerOutput: answer.value.providerOutput,
        },
      ];
      const spend = captureTokenUsage();
      const chunks: LlmStreamChunk[] = [];
      await spend.run(async () => {
        for await (const chunk of globalLlm.streamChat(messages, undefined, {
          reasoningEffort: 'low',
        })) {
          if (!chunk.ok) throw chunk.error;
          chunks.push(chunk.value);
        }
      });
      expect(stream.mock.calls[0][0]).toBe(messages);
      expect(stream.mock.calls[0][2]?.reasoningEffort).toBe('low');
      expect(chunks.find((chunk) => chunk.providerOutput)?.providerOutput).toBe(
        providerOutput,
      );
      expect(chunks.find((chunk) => chunk.usage)?.usage).toEqual(usage);
      expect(spend.usage()?.models?.test.reasoningTokens).toBe(3);
      await plannerLlm.chat([]);
    });
    expect(
      providers.map((provider) => provider.config.reasoningEffort),
    ).toEqual([undefined, 'medium', 'medium', 'high']);
    expect(providers[0].config).not.toHaveProperty('reasoningEffort');
    expect(providers[1]).toBe(providers[2]);
    expect(providers[1]).not.toBe(providers[3]);
  } finally {
    session.dispose();
  }
});
