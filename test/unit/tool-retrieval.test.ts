import {
  type IMcpClient,
  InMemoryRag,
  type McpTool,
  TOOL_RETRIEVAL_INVALID,
  type UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import { unwrapBuilderResult } from '@mcp-abap-adt/llm-agent-libs';
import { createUsageRecorder } from '@mcp-abap-adt/llm-usage';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import cds from '@sap/cds';
import { clearAgentConfig, loadAgentConfig } from '../../srv/agent-config';
import {
  configureDestinationAgentBuilder,
  ExpositionFilteringRag,
  initProviders,
} from '../../srv/agent-manager';
import { BuildValidationError } from '../../srv/lib/build-validation-error';
import { resolveExposition } from '../../srv/lib/exposition';
import { startProviders } from '../../srv/lib/providers';
import { bindTestCaller } from './helpers/bind-test-caller';

const originalFile: { strategy?: string; model?: string } | undefined =
  cds.env.toolRetrieval;

beforeEach(() => {
  const env = {
    ...process.env,
    LLM_AGENT_PROVIDER: 'openai',
    LLM_AGENT_API_KEY: 'test-key',
    LLM_AGENT_MODEL: 'main-model',
    LLM_AGENT_RAG_TYPE: 'in-memory',
  };
  jest.replaceProperty(process, 'env', env);
  delete process.env.LLM_AGENT_TOOL_RETRIEVAL;
  delete process.env.LLM_AGENT_TOOL_RETRIEVAL_MODEL;
  cds.env.toolRetrieval = undefined;
  clearAgentConfig();
});

afterEach(() => {
  jest.restoreAllMocks();
  cds.env.toolRetrieval = originalFile;
  clearAgentConfig();
});

describe('tool retrieval settings', () => {
  it('defaults to RAG with no model', () => {
    expect(loadAgentConfig().toolRetrieval).toEqual({ strategy: 'rag' });
  });

  it('lets environment variables override the config file per key', () => {
    cds.env.toolRetrieval = { strategy: 'llm', model: 'file-model' };
    expect(loadAgentConfig().toolRetrieval).toEqual({
      strategy: 'llm',
      model: 'file-model',
    });

    process.env.LLM_AGENT_TOOL_RETRIEVAL = 'rag';
    expect(loadAgentConfig().toolRetrieval).toEqual({
      strategy: 'rag',
      model: 'file-model',
    });

    process.env.LLM_AGENT_TOOL_RETRIEVAL_MODEL = 'env-model';
    expect(loadAgentConfig().toolRetrieval).toEqual({
      strategy: 'rag',
      model: 'env-model',
    });

    delete process.env.LLM_AGENT_TOOL_RETRIEVAL;
    expect(loadAgentConfig().toolRetrieval).toEqual({
      strategy: 'llm',
      model: 'env-model',
    });
  });

  it('fails startup validation for an invalid strategy or a missing LLM model', () => {
    process.env.LLM_AGENT_TOOL_RETRIEVAL = 'llm';
    expect(() => loadAgentConfig()).toThrow(BuildValidationError);
    expect(() => loadAgentConfig()).toThrow(
      'toolRetrieval.model (LLM_AGENT_TOOL_RETRIEVAL_MODEL) is required',
    );
    process.env.LLM_AGENT_TOOL_RETRIEVAL = 'invalid';
    expect(() => loadAgentConfig()).toThrow(
      'toolRetrieval.strategy (LLM_AGENT_TOOL_RETRIEVAL) must be rag or llm',
    );
  });
});

const sapTools: McpTool[] = [
  {
    name: 'GetTableContents',
    description: 'Read table rows',
    inputSchema: { type: 'object' },
  },
  {
    name: 'GetSqlQuery',
    description: 'Read through SQL',
    inputSchema: { type: 'object' },
  },
  {
    name: 'CreateDomain',
    description: 'Create a domain',
    inputSchema: { type: 'object' },
  },
];
const client: IMcpClient = {
  listTools: async () => ({ ok: true, value: sapTools }),
  callTool: async () => ({
    ok: true,
    value: { content: 'rows', isError: false },
  }),
};
async function buildAgent() {
  const config = loadAgentConfig();
  initProviders(await startProviders(config));
  const caller = await bindTestCaller({
    sessionId: 'tool-selection-session',
    userId: 'reader',
    isAdmin: false,
  });
  const store = new InMemoryRag();
  const query = jest.spyOn(store, 'query').mockResolvedValue({
    ok: true,
    value: [
      {
        text: 'Read table rows',
        metadata: { id: 'tool:GetTableContents', exposition: 'readonly' },
        score: 1,
      },
      {
        text: 'Create a domain',
        metadata: { id: 'tool:CreateDomain', exposition: 'high' },
        score: 1,
      },
    ],
  });
  const builder = await configureDestinationAgentBuilder(
    client,
    new ExpositionFilteringRag(store),
    config,
    { skipSkills: true },
  );
  return {
    handle: unwrapBuilderResult(await builder.build()),
    query,
    options: {
      ...caller,
      ragFilter: { exposition: resolveExposition(['MCP_Reader']) },
    },
  };
}

function recordModelCall(
  model: string,
  stream: boolean,
  options: Parameters<OpenAIProvider['chat']>[2],
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  },
) {
  options?.usage?.record({
    kind: 'llm.call',
    context: {},
    outcome: 'ok',
    durationMs: 1,
    operationId: model,
    physicalSeq: 1,
    outerAttempt: 1,
    providerAttempt: 1,
    granularity: 'request',
    retriesVisible: true,
    provider: 'openai',
    model,
    stream,
    tokensSource: 'provider',
    ...tokens,
  });
}

function mockMainModel() {
  const offered: Array<Parameters<OpenAIProvider['streamChat']>[1]> = [];
  const main = jest
    .spyOn(OpenAIProvider.prototype, 'streamChat')
    .mockImplementation(async function* (
      this: OpenAIProvider,
      _messages,
      tools,
      options,
    ) {
      offered.push(tools);
      recordModelCall(this.model, true, options, {
        inputTokens: 20,
        outputTokens: 2,
      });
      yield {
        content: 'Done',
        finishReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 },
      };
    });
  return { main, offered };
}

const selectedTool = expect.objectContaining({
  function: expect.objectContaining({ name: 'GetTableContents' }),
});

it('uses the existing exposition-filtered tool RAG by default', async () => {
  const { offered } = mockMainModel();
  const selection = jest.spyOn(OpenAIProvider.prototype, 'chat');
  const { handle, query, options } = await buildAgent();
  try {
    expect(
      await handle.agent.process('Read table rows', options),
    ).toMatchObject({ ok: true, value: { content: 'Done' } });
    expect(offered[0]).toContainEqual(selectedTool);
    expect(offered[0]).not.toContainEqual(
      expect.objectContaining({
        function: expect.objectContaining({ name: 'CreateDomain' }),
      }),
    );
    expect(query).toHaveBeenCalled();
    expect(selection).not.toHaveBeenCalled();
  } finally {
    await handle.close();
  }
});

it.each([
  ['{"tools":["GetTableContents"]}', true],
  ['{"tools":["CreateDomain"]}', false],
  ['invalid JSON', false],
])(
  'validates LLM tool selection and attributes usage for %s',
  async (content, valid) => {
    process.env.LLM_AGENT_TOOL_RETRIEVAL = 'llm';
    process.env.LLM_AGENT_TOOL_RETRIEVAL_MODEL = 'selection-model';
    const records: UsageRecord[] = [];
    const usage = createUsageRecorder({
      transport: {
        send: async (batch) => {
          records.push(...batch);
        },
        close: async () => {},
      },
    });
    const tokens = {
      promptTokens: 10,
      cachedInputTokens: 4,
      completionTokens: 1,
      totalTokens: 11,
    };
    const select = jest
      .spyOn(OpenAIProvider.prototype, 'chat')
      .mockImplementation(async function (
        this: OpenAIProvider,
        _messages,
        _tools,
        options,
      ) {
        recordModelCall(this.model, false, options, {
          inputTokens: tokens.promptTokens,
          outputTokens: tokens.completionTokens,
          cachedInputTokens: tokens.cachedInputTokens,
        });
        return { content, finishReason: 'stop', usage: tokens };
      });
    const { main, offered } = mockMainModel();
    const { handle, query, options } = await buildAgent();
    try {
      const run = await handle.agent.process('Read table rows', {
        ...options,
        usage: usage.with({ role: 'executor', component: 'chat' }),
      });
      if (valid) {
        expect(run).toMatchObject({ ok: true, value: { content: 'Done' } });
        expect(offered).toEqual([[selectedTool]]);
      } else {
        expect(run).toMatchObject({
          ok: false,
          error: { code: TOOL_RETRIEVAL_INVALID },
        });
        expect(main).not.toHaveBeenCalled();
      }
      expect(select).toHaveBeenCalledTimes(1);
      const catalogue = select.mock.calls[0][0][1].content;
      expect(catalogue).toContain(JSON.stringify(sapTools[0]));
      expect(catalogue).toContain(JSON.stringify(sapTools[1]));
      expect(catalogue).not.toContain('CreateDomain');
      expect(query).not.toHaveBeenCalled();
      await usage.close(1000);
      expect(records.filter((record) => record.kind === 'llm.call')).toEqual([
        expect.objectContaining({
          model: 'selection-model',
          context: expect.objectContaining({
            role: 'tool-retriever',
            component: 'tool-retriever',
          }),
          inputTokens: tokens.promptTokens,
          outputTokens: tokens.completionTokens,
          cachedInputTokens: tokens.cachedInputTokens,
        }),
        ...(valid
          ? [
              expect.objectContaining({
                model: 'main-model',
                inputTokens: 20,
                outputTokens: 2,
              }),
            ]
          : []),
      ]);
    } finally {
      await handle.close();
      await usage.close(1000);
    }
  },
);
