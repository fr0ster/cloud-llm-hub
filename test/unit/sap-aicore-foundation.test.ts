import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import type { Message } from '@mcp-abap-adt/llm-agent';
import { loadAgentConfig, parseRagConfig } from '../../srv/agent-config';
import { getAvailableModels } from '../../srv/lib/ai-core-models';
import { BuildValidationError } from '../../srv/lib/build-validation-error';
import {
  makeHubLlm,
  readAiCoreServiceKey,
  resetLlmCredentials,
} from '../../srv/lib/llm-factory';
import { modelCapabilities } from '../../srv/lib/model-capabilities';
import {
  ensureModelCatalog,
  resetModelCatalog,
} from '../../srv/lib/model-catalog';
import { parseModelAllowlist } from '../../srv/lib/model-policy';
import { buildEmbedding } from '../../srv/lib/providers';

const provider = 'sap-aicore-foundation';
const resourceGroup = 'test-group';
const openAiModel = 'gpt-4o-mini';
const embeddingModel = 'text-embedding-3-small';
const unsupportedModel = 'gemini-2.5-pro';
const missingModel = 'anthropic--unlisted-model';
const apiBaseUrl = 'https://aicore.example.test';
const authUrl = 'https://oauth.example.test';
const deploymentBaseUrl = `${apiBaseUrl}/v2/inference/deployments`;

function deployment(name: string, scenarioId = 'foundation-models') {
  return {
    scenarioId,
    deploymentUrl: `${deploymentBaseUrl}/chat`,
    details: { resources: { backendDetails: { model: { name } } } },
  };
}

function mockAiCore(
  respond: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = new URL(input.toString());
      if (url.href === `${authUrl}/oauth/token`)
        return Response.json({ access_token: 'test-token' });
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer test-token',
      );
      expect(new Headers(init?.headers).get('AI-Resource-Group')).toBe(
        resourceGroup,
      );
      return respond(url, init);
    });
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    VCAP_SERVICES: undefined,
    AICORE_SERVICE_KEY: undefined,
    AICORE_AUTH_URL: authUrl,
    AICORE_CLIENT_ID: 'test-client',
    AICORE_CLIENT_SECRET: 'unused-test-placeholder',
    AICORE_BASE_URL: apiBaseUrl,
    LLM_AGENT_PROVIDER: provider,
    LLM_AGENT_RESOURCE_GROUP: resourceGroup,
    LLM_AGENT_MODEL: openAiModel,
    LLM_AGENT_REASONING_EFFORT: undefined,
    LLM_AGENT_EXECUTOR_REASONING_EFFORT: undefined,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  resetLlmCredentials();
  resetModelCatalog();
});

it('selects the SAP AI Core direct deployment provider from Hub configuration', async () => {
  const config = loadAgentConfig();
  const fetch = mockAiCore((url, init) => {
    if (url.pathname === '/v2/lm/deployments') {
      expect(url.searchParams.get('status')).toBe('RUNNING');
      return Response.json({ resources: [deployment(openAiModel)] });
    }
    expect(url.href).toBe(
      `${deploymentBaseUrl}/chat/chat/completions?api-version=2024-10-21`,
    );
    expect(init?.method).toBe('POST');
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  expect(config.llm).toMatchObject({ provider, resourceGroup });
  const llm = await makeHubLlm(config.llm, undefined);
  expect(await llm.chat([{ role: 'user', content: 'Hello' }])).toMatchObject({
    ok: true,
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('uses role reasoning effort and replays provider output in the Responses tool round-trip', async () => {
  process.env.LLM_AGENT_REASONING_EFFORT = 'low';
  process.env.LLM_AGENT_EXECUTOR_REASONING_EFFORT = 'high';
  const output = [
    { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque' },
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'lookup',
      arguments: '{}',
    },
  ];
  let calls = 0;
  mockAiCore((url, init) => {
    if (url.pathname === '/v2/lm/deployments')
      return Response.json({
        resources: [
          { ...deployment(openAiModel), configurationId: 'config-1' },
        ],
      });
    if (url.pathname === '/v2/lm/configurations/config-1')
      return Response.json({ executableId: 'azure-openai' });

    expect(url.href).toBe(`${deploymentBaseUrl}/chat/responses`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      reasoning: { effort: 'high' },
      tools: [{ type: 'function', name: 'lookup' }],
    });
    if (calls++ > 0) {
      expect(body).toMatchObject({
        input: [
          { role: 'user', content: 'Look this up' },
          ...output,
          { type: 'function_call_output', call_id: 'call-1', output: 'Found' },
        ],
      });
      return Response.json({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
        ],
      });
    }
    return Response.json({
      status: 'completed',
      output,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        output_tokens_details: { reasoning_tokens: 3 },
      },
    });
  });
  const llm = await makeHubLlm(
    { ...loadAgentConfig().llm, role: 'executor' },
    undefined,
  );
  const user: Message = { role: 'user', content: 'Look this up' };
  const tools = [
    { name: 'lookup', description: 'Look up a record', inputSchema: {} },
  ];
  const answer = await llm.chat([user], tools);
  expect(answer).toMatchObject({
    ok: true,
    value: {
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call-1', name: 'lookup', arguments: {} }],
      providerOutput: { protocol: 'openai.responses', items: output },
      usage: { reasoningTokens: 3 },
    },
  });
  if (!answer.ok) throw answer.error;
  const [call] = answer.value.toolCalls ?? [];
  if (!call) throw new Error('Expected a tool call');
  const continued = await llm.chat(
    [
      user,
      {
        role: 'assistant',
        content: answer.value.content,
        providerOutput: answer.value.providerOutput,
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: call.id, content: 'Found' },
    ],
    tools,
  );
  expect(continued).toMatchObject({ ok: true, value: { content: 'Done' } });
});

it('uses binding credentials ahead of the service key and individual variables', () => {
  const key = (base: string) =>
    JSON.stringify({ serviceurls: { AI_API_URL: base } });
  const bindingKey = key('https://binding.example.test');
  const envKey = key('https://key.example.test');
  process.env.VCAP_SERVICES = JSON.stringify({
    aicore: [{ credentials: JSON.parse(bindingKey) }],
  });
  process.env.AICORE_SERVICE_KEY = envKey;
  expect(readAiCoreServiceKey()).toBe(bindingKey);
  delete process.env.VCAP_SERVICES;
  expect(readAiCoreServiceKey()).toBe(envKey);
  delete process.env.AICORE_SERVICE_KEY;
  expect(JSON.parse(readAiCoreServiceKey())).toMatchObject({
    serviceurls: { AI_API_URL: apiBaseUrl },
  });
});

it('loads deployed chat model names into both catalog paths', async () => {
  process.env.LLM_AGENT_MODELS = 'catalog';
  const sonnet = 'anthropic--claude-4.6-sonnet';
  const reasoningModel = 'o3-mini';
  mockAiCore((url) => {
    expect(url.pathname).toBe('/v2/lm/deployments');
    expect(url.searchParams.get('status')).toBe('RUNNING');
    return Response.json({
      resources: [
        deployment(openAiModel),
        deployment(sonnet),
        deployment(sonnet),
        deployment(reasoningModel),
        deployment(unsupportedModel),
        deployment(embeddingModel),
        deployment('gpt-4.1-mini', 'orchestration'),
      ],
    });
  });

  const { llm } = loadAgentConfig();
  await ensureModelCatalog();
  expect(parseModelAllowlist()).toEqual(
    new Set([openAiModel, sonnet, reasoningModel]),
  );
  expect((await getAvailableModels(llm)).map(({ id }) => id)).toEqual([
    sonnet,
    openAiModel,
    reasoningModel,
  ]);
});

it.each([
  ['anthropic--claude-4.5-sonnet', 64_000, 'chat'],
  ['anthropic--claude-4.6-sonnet', 64_000, 'classifier'],
  ['anthropic--claude-4.6-opus', 128_000, 'tool-retriever'],
] as const)(
  'uses the documented output maximum for %s via Bedrock',
  async (model, maxTokens, component) => {
    expect(modelCapabilities(model)?.maxOutputTokens).toBe(maxTokens);
    const fetch = mockAiCore((url, init) => {
      if (url.pathname === '/v2/lm/deployments')
        return Response.json({ resources: [deployment(model)] });
      expect(url.href).toBe(`${deploymentBaseUrl}/chat/invoke`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
      });
      return Response.json({
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
      });
    });
    const llm = await makeHubLlm(
      { provider, model, resourceGroup, component },
      undefined,
    );
    expect(await llm.chat([{ role: 'user', content: 'Hello' }])).toMatchObject({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it.each([
  'LLM_AGENT_MODEL',
  'LLM_AGENT_MODELS',
  'LLM_AGENT_PLANNER_MODEL',
  'LLM_AGENT_COORDINATOR_MODEL',
  'LLM_AGENT_EXECUTOR_MODEL',
  'LLM_AGENT_CHECKER_MODEL',
  'LLM_AGENT_CLASSIFIER_MODEL',
  'LLM_AGENT_TOOL_RETRIEVAL_MODEL',
])('rejects an unsupported chat model in %s at startup', (setting) => {
  process.env.LLM_AGENT_MODELS = '';
  process.env[setting] = unsupportedModel;
  if (setting === 'LLM_AGENT_TOOL_RETRIEVAL_MODEL')
    process.env.LLM_AGENT_TOOL_RETRIEVAL = 'llm';
  expect(() => loadAgentConfig()).toThrow(BuildValidationError);
  expect(() => loadAgentConfig()).toThrow(
    'Unsupported chat model "gemini-2.5-pro" for LLM_AGENT_PROVIDER=sap-aicore-foundation. Supported families are anthropic--* (Bedrock), gpt-*, and o<digit>* (OpenAI chat).',
  );
});

it.each([
  'LLM_AGENT_MODEL',
  'LLM_AGENT_MODELS',
  'LLM_AGENT_PLANNER_MODEL',
  'LLM_AGENT_COORDINATOR_MODEL',
  'LLM_AGENT_EXECUTOR_MODEL',
  'LLM_AGENT_CHECKER_MODEL',
  'LLM_AGENT_CLASSIFIER_MODEL',
  'LLM_AGENT_TOOL_RETRIEVAL_MODEL',
])('rejects a missing Anthropic capability for %s at startup', (setting) => {
  process.env.LLM_AGENT_MODELS = 'catalog';
  process.env[setting] = missingModel;
  if (setting === 'LLM_AGENT_TOOL_RETRIEVAL_MODEL')
    process.env.LLM_AGENT_TOOL_RETRIEVAL = 'llm';
  expect(() => loadAgentConfig()).toThrow(
    /documented maxOutputTokens capability for model "anthropic--unlisted-model"/,
  );
});

it('rejects an unsupported Anthropic model selected after startup', async () => {
  await expect(
    makeHubLlm({ provider, model: missingModel, maxTokens: 8192 }, undefined),
  ).rejects.toThrow(BuildValidationError);
});

it('requires a configured chat model for the foundation provider', () => {
  delete process.env.LLM_AGENT_MODEL;
  delete process.env.SAP_CORE_AI_MODEL;
  expect(() => loadAgentConfig()).toThrow(
    'LLM_AGENT_MODEL must name a deployed model',
  );
});

it('requires an explicit SAP AI Core embedding model for vector RAG', () => {
  expect(() =>
    parseRagConfig({ LLM_AGENT_RAG_TYPE: 'vector' }, { provider }),
  ).toThrow('LLM_AGENT_EMBEDDING_MODEL must name a deployed embedding model');
});

it('uses the foundation-models REST embeddings deployment for vector RAG', async () => {
  const rag = parseRagConfig(
    {
      LLM_AGENT_RAG_TYPE: 'vector',
      LLM_AGENT_EMBEDDER: 'sap-ai-core',
      LLM_AGENT_EMBEDDING_MODEL: embeddingModel,
    },
    { provider, resourceGroup },
  );
  expect(rag.embedder).toEqual({
    kind: 'sap-ai-core',
    model: embeddingModel,
    resourceGroup,
    scenario: 'foundation-models',
  });
  const requests: {
    url: URL;
    method?: string;
    group?: string | string[];
    authorization?: string;
    body: string;
  }[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({
      url,
      method: req.method,
      group: req.headers['ai-resource-group'],
      authorization: req.headers.authorization,
      body: await text(req),
    });
    res.setHeader('Content-Type', 'application/json');
    switch (url.pathname) {
      case '/oauth/token':
        res.end(JSON.stringify({ access_token: 'test-token' }));
        break;
      case '/v2/lm/deployments':
        res.end(
          JSON.stringify({
            resources: [
              {
                id: 'embed',
                details: {
                  resources: {
                    backendDetails: { model: { name: embeddingModel } },
                  },
                },
              },
            ],
          }),
        );
        break;
      case '/v2/inference/deployments/embed/embeddings':
        res.end(JSON.stringify({ data: [{ embedding: [1, 2], index: 0 }] }));
        break;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP server');
    const origin = `http://127.0.0.1:${address.port}`;
    process.env.AICORE_AUTH_URL = origin;
    process.env.AICORE_BASE_URL = origin;

    const embedding = buildEmbedding(rag.embedder);
    expect(await embedding?.retrieval.embedQuery('search text')).toEqual({
      vector: [1, 2],
    });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      '/oauth/token',
      '/v2/lm/deployments',
      '/v2/inference/deployments/embed/embeddings',
    ]);
    const [, lookup, inference] = requests;
    expect(lookup.url.searchParams.get('scenarioId')).toBe('foundation-models');
    expect(lookup.url.searchParams.get('status')).toBe('RUNNING');
    expect(lookup).toMatchObject({
      group: resourceGroup,
      authorization: 'Bearer test-token',
    });
    expect(inference).toMatchObject({
      method: 'POST',
      group: resourceGroup,
      authorization: 'Bearer test-token',
    });
    expect(JSON.parse(inference.body)).toEqual({ input: 'search text' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
