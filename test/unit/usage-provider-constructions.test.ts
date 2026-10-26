import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import type {
  CallOptions,
  IUsageRecorder,
  Message,
  UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import { createUsageRecorder } from '@mcp-abap-adt/llm-usage';
import {
  OrchestrationClient,
  OrchestrationEmbeddingClient,
  OrchestrationEmbeddingResponse,
  OrchestrationResponse,
} from '@sap-ai-sdk/orchestration';
import axios, { type AxiosAdapter, AxiosHeaders } from 'axios';
import express from 'express';
import ts from 'typescript';
import type { EmbedderConfig } from '../../srv/agent-config';
import { executeStep } from '../../srv/agent-mcp';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { makeHubLlm, resetLlmCredentials } from '../../srv/lib/llm-factory';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import {
  agentQueryEmbedder,
  buildEmbedding,
  prefetchEmbedder,
} from '../../srv/lib/providers';
import { lifecycleHooks } from '../../srv/lib/session-lifecycle';
import { readUsageConfig } from '../../srv/lib/usage/config';
import { initUsage, setUsageRuntimeForTest } from '../../srv/lib/usage/runtime';
import { handleChatCompletions } from '../../srv/openai-handler';
import { harness } from './helpers/channel-harness';

jest.mock('../../srv/lib/logging-config', () => ({ applyLoggingConfig() {} }));
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    get context() {
      return {
        user: jest.requireActual<typeof import('./helpers/channel-harness')>(
          './helpers/channel-harness',
        ).harness.user,
      };
    },
  },
}));
jest.mock('../../srv/agent-manager', () =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .agentManagerMock(),
);
jest.mock('../../srv/agent-config', () =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .agentConfigMock(),
);
jest.mock('../../srv/lib/request-connection', () =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .requestConnectionMock(),
);
jest.mock('../../srv/lib/request-system-context', () =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .requestSystemMock(),
);
jest.mock('../../srv/lib/ai-core-models', () => ({
  getAvailableModels: async () => [],
}));
jest.mock('../../srv/env-setup', () => ({}));

test.each([true, false])(
  'plain OpenAI/Anthropic requests and agent MCP execute_step propagate session context (usage: %s)',
  async (enabled: boolean) => {
    harness.reset();
    const runtime = enabled
      ? await initUsage(
          readUsageConfig({
            LLM_AGENT_USAGE: 'on',
            LLM_AGENT_USAGE_SINKS: 'memory',
            LLM_AGENT_USAGE_USER_ID: 'plain',
          }),
        )
      : undefined;
    setUsageRuntimeForTest(runtime);
    const registry = new LongSessionRegistry(
      { ttlMs: 3600000, maxSessions: 10, maxPerUser: 10, queueLength: 3 },
      lifecycleHooks(),
    );
    setLongSessionsForTest(registry);
    const session = registry.open('alice', {
      key: 'ls-usage',
      destination: 'DEST',
    });
    if ('refused' in session) throw new Error('Session refused');
    const observed: CallOptions[] = [];
    harness.process = async (_messages: Message[], options: CallOptions) => {
      observed.push(options);
      options.usage?.record({
        kind: 'tool.call',
        context: {},
        outcome: 'ok',
        tool: 'fake',
        dispatched: true,
        embedded: false,
        transportOutcome: 'ok',
        durationMs: 1,
      });
      return { ok: true, value: { content: 'done', stopReason: 'stop' } };
    };
    const app = express();
    app.use(express.json());
    app.post('/openai', handleChatCompletions);
    app.post('/anthropic', handleAnthropicMessages);
    app.post('/mcp', async (req, res) => {
      res.json(
        await executeStep(
          req,
          { userId: 'alice', exposition: undefined },
          { session: session.key, task: 'PROMPT_SENTINEL' },
        ),
      );
    });
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected local address');
    try {
      for (const path of ['openai', 'anthropic', 'mcp']) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/${path}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: 'clh_session=s-usage',
              'x-sap-destination': 'DEST',
            },
            body: JSON.stringify({
              model: 'm',
              max_tokens: 100,
              messages: [{ role: 'user', content: 'PROMPT_SENTINEL' }],
            }),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('done');
      }
      expect(observed).toHaveLength(3);
      for (const options of observed)
        expect(Boolean(options.usage)).toBe(enabled);
      if (runtime) {
        await runtime.close(1000);
        const records: UsageRecord[] = [];
        for await (const row of runtime
          .reader()
          .read({ from: 0, to: Number.MAX_SAFE_INTEGER }))
          if (row.kind === 'tool.call') records.push(row);
        expect(records).toHaveLength(3);
        expect(records.map((r) => r.context.sessionId)).toEqual([
          's-usage',
          's-usage',
          'ls-usage',
        ]);
        for (const record of records)
          expect(record.context).toMatchObject({
            userId: 'alice',
            destination: 'DEST',
            requestId: expect.any(String),
            traceId: expect.any(String),
          });
        expect(JSON.stringify(records)).not.toContain('PROMPT_SENTINEL');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setLongSessionsForTest(undefined);
      setUsageRuntimeForTest(undefined);
      await runtime?.close(1000);
    }
  },
);

const mockConstructions: Array<{ name: string; usage?: IUsageRecorder }> = [];
jest.mock('@mcp-abap-adt/openai-llm', () => {
  const actual = jest.requireActual<typeof import('@mcp-abap-adt/openai-llm')>(
    '@mcp-abap-adt/openai-llm',
  );
  return {
    ...actual,
    OpenAIProvider: class extends actual.OpenAIProvider {
      constructor(
        config: ConstructorParameters<typeof actual.OpenAIProvider>[0],
      ) {
        super(config);
        mockConstructions.push({ name: 'OpenAIProvider', usage: config.usage });
      }
    },
  };
});
jest.mock('@mcp-abap-adt/anthropic-llm', () => {
  const actual = jest.requireActual<
    typeof import('@mcp-abap-adt/anthropic-llm')
  >('@mcp-abap-adt/anthropic-llm');
  return {
    ...actual,
    AnthropicProvider: class extends actual.AnthropicProvider {
      constructor(
        config: ConstructorParameters<typeof actual.AnthropicProvider>[0],
      ) {
        super(config);
        mockConstructions.push({
          name: 'AnthropicProvider',
          usage: config.usage,
        });
      }
    },
  };
});
jest.mock('@mcp-abap-adt/deepseek-llm', () => {
  const actual = jest.requireActual<
    typeof import('@mcp-abap-adt/deepseek-llm')
  >('@mcp-abap-adt/deepseek-llm');
  return {
    ...actual,
    DeepSeekProvider: class extends actual.DeepSeekProvider {
      constructor(
        config: ConstructorParameters<typeof actual.DeepSeekProvider>[0],
      ) {
        super(config);
        mockConstructions.push({
          name: 'DeepSeekProvider',
          usage: config.usage,
        });
      }
    },
  };
});
jest.mock('@mcp-abap-adt/sap-aicore-llm', () => {
  const actual = jest.requireActual<
    typeof import('@mcp-abap-adt/sap-aicore-llm')
  >('@mcp-abap-adt/sap-aicore-llm');
  return {
    ...actual,
    SapCoreAIProvider: class extends actual.SapCoreAIProvider {
      constructor(
        config: ConstructorParameters<typeof actual.SapCoreAIProvider>[0],
      ) {
        super(config);
        mockConstructions.push({
          name: 'SapCoreAIProvider',
          usage: config.usage,
        });
      }
    },
  };
});
jest.mock('@mcp-abap-adt/openai-embedder', () => {
  const actual = jest.requireActual<
    typeof import('@mcp-abap-adt/openai-embedder')
  >('@mcp-abap-adt/openai-embedder');
  return {
    ...actual,
    OpenAiEmbedder: class extends actual.OpenAiEmbedder {
      constructor(
        config: ConstructorParameters<typeof actual.OpenAiEmbedder>[0],
      ) {
        super(config);
        mockConstructions.push({ name: 'OpenAiEmbedder', usage: config.usage });
      }
    },
  };
});
jest.mock('@mcp-abap-adt/ollama-embedder', () => {
  const actual = jest.requireActual<
    typeof import('@mcp-abap-adt/ollama-embedder')
  >('@mcp-abap-adt/ollama-embedder');
  return {
    ...actual,
    OllamaEmbedder: class extends actual.OllamaEmbedder {
      constructor(
        config: ConstructorParameters<typeof actual.OllamaEmbedder>[0],
      ) {
        super(config);
        mockConstructions.push({ name: 'OllamaEmbedder', usage: config.usage });
      }
    },
  };
});
jest.mock('../../srv/lib/sap-ai-core-embedder', () => {
  const actual = jest.requireActual<
    typeof import('../../srv/lib/sap-ai-core-embedder')
  >('../../srv/lib/sap-ai-core-embedder');
  return {
    ...actual,
    SapAiCoreEmbedder: class extends actual.SapAiCoreEmbedder {
      constructor(
        config: ConstructorParameters<typeof actual.SapAiCoreEmbedder>[0],
      ) {
        super(config);
        mockConstructions.push({
          name: 'SapAiCoreEmbedder',
          usage: config.usage,
        });
      }
    },
  };
});

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

test.each([true, false])(
  'every concrete LLM/embedder construction receives the runtime recorder only when enabled (%s)',
  async (enabled: boolean) => {
    const runtime = enabled
      ? await initUsage(
          readUsageConfig({
            LLM_AGENT_USAGE: 'on',
            LLM_AGENT_USAGE_SINKS: 'memory',
          }),
        )
      : undefined;
    setUsageRuntimeForTest(runtime);
    mockConstructions.length = 0;
    try {
      for (const provider of [
        'openai',
        'anthropic',
        'deepseek',
        'sap-ai-sdk',
      ]) {
        if (
          provider === 'openai' ||
          provider === 'anthropic' ||
          provider === 'deepseek' ||
          provider === 'sap-ai-sdk'
        )
          await makeHubLlm(
            { provider, apiKey: 'test', model: 'test', contextCapture: 'off' },
            0,
          );
      }
      for (const kind of ['openai', 'ollama', 'sap-ai-core']) {
        if (kind === 'openai' || kind === 'ollama' || kind === 'sap-ai-core') {
          await prefetchEmbedder({ kind, model: 'text-embedding-3-small' });
          buildEmbedding({
            kind,
            model: 'text-embedding-3-small',
            apiKey: 'test',
          });
        }
      }
      const expected = [
        'AnthropicProvider',
        'DeepSeekProvider',
        'OllamaEmbedder',
        'OpenAIProvider',
        'OpenAIProvider',
        'OpenAiEmbedder',
        'SapAiCoreEmbedder',
        'SapCoreAIProvider',
      ];
      expect(mockConstructions.map((c) => c.name).sort()).toEqual(expected);
      for (const construction of mockConstructions)
        expect(construction.usage).toBe(runtime?.recorder);

      // Enumerate concrete providers from their imports, rather than an allowlist
      // of filenames: a new construction anywhere under srv must be covered here.
      const constructions: string[] = [];
      for (const path of files(join(process.cwd(), 'srv'))) {
        const source = ts.createSourceFile(
          path,
          readFileSync(path, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        const providers = new Set<string>();
        for (const statement of source.statements) {
          if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier)
          )
            continue;
          const module = statement.moduleSpecifier.text;
          if (
            !(
              /@mcp-abap-adt\/.*(?:-llm|-embedder)$/.test(module) ||
              module.endsWith('/sap-ai-core-embedder')
            )
          )
            continue;
          const bindings = statement.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            for (const element of bindings.elements)
              if (!element.isTypeOnly) providers.add(element.name.text);
        }
        const visit = (node: ts.Node): void => {
          if (
            ts.isNewExpression(node) &&
            ts.isIdentifier(node.expression) &&
            providers.has(node.expression.text)
          )
            constructions.push(
              `${relative(process.cwd(), path).replaceAll('\\', '/')}:${node.expression.text}`,
            );
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      expect(constructions.sort()).toEqual([
        'srv/lib/llm-factory.ts:AnthropicProvider',
        'srv/lib/llm-factory.ts:DeepSeekProvider',
        'srv/lib/llm-factory.ts:OpenAIProvider',
        'srv/lib/llm-factory.ts:SapCoreAIProvider',
        'srv/lib/providers.ts:OllamaEmbedder',
        'srv/lib/providers.ts:OpenAiEmbedder',
        'srv/lib/providers.ts:SapAiCoreEmbedder',
      ]);
    } finally {
      setUsageRuntimeForTest(undefined);
      await runtime?.close(1000);
    }
  },
);

test.each(['construction', 'override', 'off'])(
  'constructed providers record physical transport calls exactly once (%s)',
  async (mode) => {
    let control: ReturnType<typeof createUsageRecorder> | undefined;
    const runtime =
      mode === 'off'
        ? undefined
        : await initUsage(
            readUsageConfig({
              LLM_AGENT_USAGE: 'on',
              LLM_AGENT_USAGE_SINKS: 'memory',
              LLM_AGENT_USAGE_USER_ID: 'plain',
            }),
            {
              recorderFactory: (options) => {
                control = createUsageRecorder(options);
                return control;
              },
            },
          );
    setUsageRuntimeForTest(runtime);
    const originalKey = process.env.AICORE_SERVICE_KEY;
    process.env.AICORE_SERVICE_KEY = 'test';
    jest
      .spyOn(
        await import('@mcp-abap-adt/sap-aicore-auth'),
        'serviceKeyCredential',
      )
      .mockReturnValue({
        credential: { kind: 'bearer', token: async () => 'test' },
        apiBaseUrl: 'https://sap.example',
      });
    resetLlmCredentials();
    const originalAdapter = axios.defaults.adapter;
    const axiosCalls: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      axiosCalls.push(config.url ?? '');
      const data =
        config.url === '/messages'
          ? {
              id: 'm',
              content: [{ type: 'text', text: 'done' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : {
              id: 'm',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'done' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            };
      return {
        data,
        status: 200,
        statusText: 'OK',
        headers: new AxiosHeaders(),
        config,
      };
    };
    axios.defaults.adapter = adapter;
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: string | URL | Request) => {
        const url = input.toString();
        if (url.includes('/api/'))
          return Response.json({ embedding: [1, 2], embeddings: [[1, 2]] });
        if (url.includes('embeddings'))
          return Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
        throw new Error(`Unexpected embedding transport URL: ${url}`);
      });
    const sdkLlm = jest
      .spyOn(OrchestrationClient.prototype, 'chatCompletion')
      .mockResolvedValue(
        new OrchestrationResponse({
          data: {
            final_result: {
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'done' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
          },
          headers: {},
          status: 200,
          request: {},
        }),
      );
    const sdkEmbed = jest
      .spyOn(OrchestrationEmbeddingClient.prototype, 'embed')
      .mockResolvedValue(
        new OrchestrationEmbeddingResponse({
          data: {
            final_result: {
              data: [{ index: 0, embedding: [1, 2], object: 'embedding' }],
              usage: { prompt_tokens: 1, total_tokens: 1 },
            },
          },
          headers: {},
          status: 200,
          request: {},
        }),
      );
    const options: CallOptions =
      mode === 'override'
        ? {
            usage: runtime
              ?.forSession({
                sessionId: 'call-session',
                userId: 'call-user',
                destination: 'CALL',
              })
              .with({ requestId: 'call-request' }),
          }
        : {};
    const records: UsageRecord[] = [];
    const readRecords = async () => {
      if (!runtime) return;
      await control?.flush(1000);
      records.length = 0;
      for await (const record of runtime
        .reader()
        .read({ from: 0, to: Number.MAX_SAFE_INTEGER }))
        records.push(record);
    };
    let expected = 0;
    const check = async () => {
      expected++;
      expect(
        axiosCalls.length +
          transport.mock.calls.length +
          sdkLlm.mock.calls.length +
          sdkEmbed.mock.calls.length,
      ).toBe(expected);
      await readRecords();
      expect(records).toHaveLength(mode === 'off' ? 0 : expected);
      for (const record of records) {
        expect(record.outcome).toBe('ok');
        if (mode === 'override')
          expect(record.context).toMatchObject({
            sessionId: 'call-session',
            userId: 'call-user',
            destination: 'CALL',
            requestId: 'call-request',
          });
        else expect(record.context.sessionId).toBeUndefined();
      }
    };
    try {
      for (const provider of [
        'openai',
        'anthropic',
        'deepseek',
        'sap-ai-sdk',
      ]) {
        if (
          provider !== 'openai' &&
          provider !== 'anthropic' &&
          provider !== 'deepseek' &&
          provider !== 'sap-ai-sdk'
        )
          throw new Error('Invalid provider');
        const llm = await makeHubLlm(
          {
            provider,
            apiKey: 'test',
            model: 'test',
            contextCapture: 'off',
            baseURL:
              provider === 'anthropic'
                ? 'https://anthropic.example'
                : 'https://llm.example',
          },
          0,
        );
        const response = await llm.chat(
          [{ role: 'user', content: 'hello' }],
          undefined,
          options,
        );
        if (!response.ok)
          throw new Error(
            provider +
              ': ' +
              String(response.error) +
              ' cause: ' +
              String(response.error.cause),
          );
        expect(response).toMatchObject({
          ok: true,
          value: { content: 'done' },
        });
        await check();
      }
      for (const kind of ['openai', 'ollama', 'sap-ai-core']) {
        if (kind !== 'openai' && kind !== 'ollama' && kind !== 'sap-ai-core')
          throw new Error('Invalid embedder');
        const config: EmbedderConfig = {
          kind,
          model: 'text-embedding-3-small',
          apiKey: 'test',
        };
        await prefetchEmbedder(config);
        const embedding = buildEmbedding(config);
        if (!embedding) throw new Error('Expected embedder');
        expect(
          (await embedding.embedder.embed('hello', options)).vector,
        ).toEqual([1, 2]);
        await check();
        expect(
          (await embedding.retrieval.embedDocument('hello', options)).vector,
        ).toEqual([1, 2]);
        await check();
        expect(
          (await agentQueryEmbedder(embedding).embedQuery('hello', options))
            .vector,
        ).toEqual([1, 2]);
        await check();
      }
    } finally {
      axios.defaults.adapter = originalAdapter;
      jest.restoreAllMocks();
      resetLlmCredentials();
      if (originalKey === undefined) delete process.env.AICORE_SERVICE_KEY;
      else process.env.AICORE_SERVICE_KEY = originalKey;
      setUsageRuntimeForTest(undefined);
      await runtime?.close(1000);
      await control?.close(1000);
    }
  },
);

test('SAP-only prefetch and construction never load optional OpenAI or Ollama embedder modules', async () => {
  const loaded: string[] = [];
  jest.doMock('@mcp-abap-adt/openai-embedder', () => {
    loaded.push('openai');
    return jest.requireActual<typeof import('@mcp-abap-adt/openai-embedder')>(
      '@mcp-abap-adt/openai-embedder',
    );
  });
  jest.doMock('@mcp-abap-adt/ollama-embedder', () => {
    loaded.push('ollama');
    return jest.requireActual<typeof import('@mcp-abap-adt/ollama-embedder')>(
      '@mcp-abap-adt/ollama-embedder',
    );
  });
  try {
    await jest.isolateModulesAsync(async () => {
      const providers = await import('../../srv/lib/providers');
      const config: EmbedderConfig = {
        kind: 'sap-ai-core',
        model: 'text-embedding-3-small',
      };
      await providers.prefetchEmbedder(config);
      expect(providers.buildEmbedding(config)).not.toBeNull();
      expect(loaded).toEqual([]);
      expect(() =>
        providers.buildEmbedding({ kind: 'openai', model: 'm' }),
      ).toThrow('not prefetched');
      expect(() =>
        providers.buildEmbedding({ kind: 'ollama', model: 'm' }),
      ).toThrow('not prefetched');
      expect(loaded).toEqual([]);
    });
  } finally {
    jest.dontMock('@mcp-abap-adt/openai-embedder');
    jest.dontMock('@mcp-abap-adt/ollama-embedder');
  }
});
