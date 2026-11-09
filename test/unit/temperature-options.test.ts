import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import { loadAgentConfig } from '../../srv/agent-config';
import { type HubLlmConfig, makeHubLlm } from '../../srv/lib/llm-factory';

jest.mock('@mcp-abap-adt/openai-llm', () => {
  const actual = jest.requireActual<typeof import('@mcp-abap-adt/openai-llm')>(
    '@mcp-abap-adt/openai-llm',
  );
  return {
    ...actual,
    OpenAIProvider: jest.fn(
      (...args: ConstructorParameters<typeof actual.OpenAIProvider>) =>
        new actual.OpenAIProvider(...args),
    ),
  };
});

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

it.each<HubLlmConfig['component']>([
  'chat',
  'planner-author',
  'classifier',
  'analyst',
  'other',
])(
  'omits temperature from provider and call options for %s when off',
  async (component) => {
    process.env.LLM_AGENT_TEMPERATURE = 'off';
    const config = loadAgentConfig();
    const llm = await makeHubLlm(
      { provider: 'openai', apiKey: 'test', model: 'test', component },
      config.llm.temperature,
    );
    expect(jest.mocked(OpenAIProvider).mock.calls[0]?.[0]).not.toHaveProperty(
      'temperature',
    );
    const actual = jest.requireActual<
      typeof import('@mcp-abap-adt/openai-llm')
    >('@mcp-abap-adt/openai-llm');
    const chat = jest
      .spyOn(actual.OpenAIProvider.prototype, 'chat')
      .mockResolvedValue({ content: 'ok' });
    await llm.chat([{ role: 'user', content: 'hello' }]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[2]?.temperature).toBeUndefined();
  },
);

it('keeps the unset temperature default in provider options', async () => {
  delete process.env.LLM_AGENT_TEMPERATURE;
  delete process.env.SAP_CORE_AI_TEMPERATURE;
  await makeHubLlm(
    { provider: 'openai', apiKey: 'test', model: 'test' },
    loadAgentConfig().llm.temperature,
  );
  expect(jest.mocked(OpenAIProvider).mock.calls[0]?.[0]).toHaveProperty(
    'temperature',
    0.7,
  );
});
