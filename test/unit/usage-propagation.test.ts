import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type {
  IEmbedResult,
  IQueryEmbedder,
  IThrottleStrategy,
  IUsageControl,
  IUsageRecorder,
  TaskRecord,
  UsageContext,
} from '@mcp-abap-adt/llm-agent';
import * as llmAgent from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  type ILlm,
  type IMcpClient,
  type ISubAgent,
  type LlmResponse,
  type Message,
  requestShape,
  startOperation,
  type UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  PlannerToolsClient,
  SmartAgentBuilder,
  SmartAgentSubAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import cds from '@sap/cds';
import { OrchestrationEmbeddingClient } from '@sap-ai-sdk/orchestration';
import express from 'express';
import type { Door } from 'srv/lib/door';
import type {
  SessionConnectionFactory,
  SessionConnectionPool,
} from 'srv/lib/session-connection-pool';
import type {
  Lease,
  LeaseKind,
  LeaseRefusal,
  SessionRetention,
} from 'srv/lib/session-retention';
import type {
  AgentConfig,
  DestinationConfig,
  LlmProvider,
  RagConfig,
  RagType,
  SmartAgentMode,
} from '../../srv/agent-config';
import { executeStep } from '../../srv/agent-mcp';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { collectionRetrieval } from '../../srv/lib/collection-retrieval';
import { dialogueChat } from '../../srv/lib/dialogue-chat';
import {
  closeDialogue,
  type DialogueHandle,
  dialogueFor,
} from '../../srv/lib/dialogue-sessions';
import { guardLlmOnlyAgent } from '../../srv/lib/llm-only-guard';
import {
  type LongSession,
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { agentQueryEmbedder, buildEmbedding } from '../../srv/lib/providers';
import { SapAiCoreEmbedder } from '../../srv/lib/sap-ai-core-embedder';
import { lifecycleHooks } from '../../srv/lib/session-lifecycle';
import { sessionMiddleware } from '../../srv/lib/session-middleware';
import { reviewStep } from '../../srv/lib/step-reviewer';
import { readUsageConfig } from '../../srv/lib/usage/config';
import {
  initUsage,
  setUsageRuntimeForTest,
  type UsageRuntime,
} from '../../srv/lib/usage/runtime';
import { handleChatCompletions } from '../../srv/openai-handler';
import { fakePipelineLlm } from './helpers/usage-pipeline';

jest.mock('@mcp-abap-adt/llm-agent', (): typeof llmAgent => {
  const actual = jest.requireActual<typeof llmAgent>('@mcp-abap-adt/llm-agent');
  return {
    ...actual,
    startOperation: jest.fn(actual.startOperation),
    beginEmbeddingRequest: jest.fn(actual.beginEmbeddingRequest),
  };
});

const mockAuthenticatedUser = new AsyncLocalStorage<string>();
const mockWorkers = new Map<string, ISubAgent>();
let mockStepAgent:
  | Awaited<ReturnType<SmartAgentBuilder['build']>>['agent']
  | undefined;
let mockPlanner: Awaited<ReturnType<SmartAgentBuilder['build']>>['agent'];
const mockQuery = jest.fn(
  async (embedding: {
    toVector(): Promise<number[]>;
  }): Promise<{ ok: boolean; value: { text: string; score: number }[] }> => {
    await embedding.toVector();
    return { ok: true, value: [{ text: 'DOCUMENT_SENTINEL', score: 1 }] };
  },
);
let mockEmbedder: ReturnType<typeof agentQueryEmbedder> | undefined;
jest.mock('../../srv/lib/logging-config', (): object => ({
  applyLoggingConfig(): void {},
}));
jest.mock('@sap/cds', (): object => ({
  __esModule: true,
  default: {
    log: (): { info(): void; warn(): void; error(): void; debug(): void } => ({
      info(): void {},
      warn(): void {},
      error(): void {},
      debug(): void {},
    }),
    context: {
      get user() {
        return {
          id: mockAuthenticatedUser.getStore() ?? 'alice',
          is: (): boolean => true,
          roles: ['MCP_Developer'],
        };
      },
    },
  },
}));
jest.mock('../../srv/agent-config', (): object => ({
  ...jest.requireActual<typeof import('../../srv/agent-config')>(
    '../../srv/agent-config',
  ),
  getAgentConfig: (): {
    agent: {
      chatCoordinator: string;
      mode: SmartAgentMode;
      dialogue: {
        executors: number;
        executorPool: number;
        maxTasks: number;
        maxCorrections: number;
        followMaxMs: number;
      };
      planBudget?: {
        maxSteps?: number;
        maxRevisions?: number;
        maxDurationMs?: number;
      };
      maxIterations: number;
      toolResultMaxChars?: number;
      maxToolCalls?: number;
      ragType: RagType;
      historyRecencyWindow?: number;
      ragQueryK: number;
      toolGate?: 'classifier' | 'off';
      toolGateTimeoutMs?: number;
      skillRagK: number;
      sapRelevanceScore?: number;
      allowLlmOnlyFallback: boolean;
    };
    llm: {
      contextCapture?: 'off' | 'stats';
      provider: LlmProvider;
      model: string;
      classifierModel: string;
      plannerModel?: string;
      temperature: number;
      maxTokens: number;
      apiKey?: string;
      baseUrl?: string;
      resourceGroup?: string;
      whenThrottled: IThrottleStrategy;
    };
    mcp: {
      destination: string;
      endpoint?: string;
      systemDestinations: Record<string, string>;
    };
    rag: RagConfig;
    destinations: DestinationConfig;
  } => ({
    ...jest
      .requireActual<typeof import('../../srv/agent-config')>(
        '../../srv/agent-config',
      )
      .getAgentConfig(),
    agent: {
      ...jest
        .requireActual<typeof import('../../srv/agent-config')>(
          '../../srv/agent-config',
        )
        .getAgentConfig().agent,
      chatCoordinator: 'dialogue',
    },
  }),
}));
jest.mock('../../srv/lib/request-connection', (): object =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .requestConnectionMock(),
);
jest.mock('../../srv/lib/request-system-context', (): object =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .requestSystemMock(),
);
jest.mock('../../srv/lib/ai-core-models', (): object => ({
  getAvailableModels: async (): Promise<never[]> => [],
}));
jest.mock('../../srv/env-setup', (): object => ({}));
jest.mock('../../srv/agent-manager', (): object => ({
  ...jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .agentManagerMock(),
  getSmartAgent: async (): Promise<{
    agent:
      | Awaited<ReturnType<SmartAgentBuilder['build']>>['agent']
      | { deps: { ragStores: Record<string, never> } };
    workers: Map<string, ISubAgent>;
    recMcp: { getToolRecords: () => never[]; dropRequest(): void };
    criticLlm: Record<string, never>;
  }> => ({
    agent: mockStepAgent ?? { deps: { ragStores: {} } },
    workers: mockWorkers,
    recMcp: { getToolRecords: (): never[] => [], dropRequest(): void {} },
    criticLlm: {},
  }),
  buildPlannerAgent: async (): Promise<
    Awaited<ReturnType<SmartAgentBuilder['build']>>['agent']
  > => mockPlanner,
  releasePlannerAgent(): void {},
  setSessionDestination(): void {},
  runWithRequestConnection: <T>(_connection: object, fn: () => T): T => fn(),
  getQueryEmbedder: (): IQueryEmbedder | undefined => mockEmbedder,
  getCollectionRegistry: (): {
    getCollection: import('../../srv/rag-collections').CollectionRegistry['getCollection'];
    getEnabled: import('../../srv/rag-collections').CollectionRegistry['getEnabled'];
    listCollections: import('../../srv/rag-collections').CollectionRegistry['listCollections'];
    ready: Promise<void>;
    degradedOf: () => Promise<undefined>;
    getRagStores: () => Promise<Record<string, never>>;
    getRagStore: () => Promise<{
      query: jest.Mock<
        Promise<{ ok: boolean; value: { text: string; score: number }[] }>,
        [embedding: { toVector(): Promise<number[]> }],
        void
      >;
    }>;
  } => ({
    getCollection: async (id) => ({
      id,
      logicalId: id,
      displayName: id,
      description: '',
      scope: 'user',
      owner: 'alice',
      createdAt: new Date(0).toISOString(),
      documentCount: 1,
      sourceCount: 1,
    }),
    getEnabled: () => true,
    listCollections: async () => [],
    ready: Promise.resolve(),
    degradedOf: async (): Promise<undefined> => undefined,
    getRagStores: async (): Promise<Record<string, never>> => ({}),
    getRagStore: async (): Promise<{
      query: jest.Mock<
        Promise<{ ok: boolean; value: { text: string; score: number }[] }>,
        [embedding: { toVector(): Promise<number[]> }],
        void
      >;
    }> => ({ query: mockQuery }),
  }),
}));
jest.mock('../../srv/collection-ids', (): object => ({
  resolveRouteId: async (): Promise<string> => 'selected',
}));
jest.mock('../../srv/lib/session-connection-pool', (): object => ({
  SessionConnectionFactory: class {
    exposition = [];
    environment() {
      return [];
    }
    async refresh() {}
    async assertPrincipal() {}
  },
  SessionConnectionPool: class {
    async acquire() {
      return {
        connection: {},
        system: {},
        release: async (): Promise<void> => {},
      };
    }
    async closeAll() {}
  },
}));
jest.mock('../../srv/lib/gatekeeper', (): object => ({
  ...jest.requireActual<typeof import('../../srv/lib/gatekeeper')>(
    '../../srv/lib/gatekeeper',
  ),
  admitPipeline: async (): Promise<{
    admitted: {
      signal: AbortSignal;
      run: <T>(fn: () => T) => T;
      drain: () => Promise<void>;
      release(): void;
    };
  }> => ({
    admitted: {
      signal: new AbortController().signal,
      run: <T>(fn: () => T): T => fn(),
      drain: async (): Promise<void> => {},
      release(): void {},
    },
  }),
  admitBackground: async (): Promise<{
    admitted: {
      signal: AbortSignal;
      run: <T>(fn: () => T) => T;
      drain: () => Promise<void>;
      release(): void;
    };
  }> => ({
    admitted: {
      signal: new AbortController().signal,
      run: <T>(fn: () => T): T => fn(),
      drain: async (): Promise<void> => {},
      release(): void {},
    },
  }),
}));

const sink = memorySink({ limit: 10000 });
const recorder = createUsageRecorder({
  transport: directTransport(sink),
  flushMs: 100000,
});
let runtime: UsageRuntime;
const physical: Array<{
  options?: CallOptions;
  shape: ReturnType<typeof requestShape>;
}> = [];
function fakeLlm(
  answer: (messages: Message[], options?: CallOptions) => LlmResponse,
  beforeChat?: (options?: CallOptions) => Promise<void>,
): ILlm {
  return fakePipelineLlm(
    answer,
    async (
      messages: Message[],
      tools: Parameters<ILlm['chat']>[1],
      options?: CallOptions,
    ): Promise<void> => {
      if (beforeChat) await beforeChat(options);
      options?.usage?.record({
        kind: 'x.hub.request.physical',
        context: {},
        outcome: 'ok',
        values: { index: physical.length },
      });
      physical.push({ options, shape: requestShape(messages, tools) });
    },
  );
}
async function sdkResponse() {
  const response: Awaited<ReturnType<OrchestrationEmbeddingClient['embed']>> =
    new (
      await import('@sap-ai-sdk/orchestration')
    ).OrchestrationEmbeddingResponse({
      data: {
        final_result: {
          data: [{ embedding: [1, 2], index: 0, object: 'embedding' }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
      },
      headers: {},
      status: 200,
      request: {},
    });
  return response;
}

const plainAnswer = (): LlmResponse => ({
  content: 'RESULT_SENTINEL',
  finishReason: 'stop',
});
async function rows() {
  await recorder.flush(1000);
  const result: UsageRecord[] = [];
  for await (const row of sink.read({ from: 0, to: Number.MAX_SAFE_INTEGER }))
    result.push(row);
  return result;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise<void>(
      (resolve: (value: void | PromiseLike<void>) => void): NodeJS.Timeout =>
        setTimeout(resolve, 5),
    );
  }
  throw new Error('Pipeline did not settle');
}
beforeAll(async (): Promise<void> => {
  const enabled = await initUsage(
    readUsageConfig({
      LLM_AGENT_USAGE: 'on',
      LLM_AGENT_USAGE_SINKS: 'memory',
      LLM_AGENT_USAGE_USER_ID: 'plain',
    }),
    { recorderFactory: (): IUsageRecorder & IUsageControl => recorder },
  );
  if (!enabled) throw new Error('Expected usage runtime');
  runtime = enabled;
});
beforeEach((): void => {
  setUsageRuntimeForTest(runtime);
  physical.length = 0;
});
afterEach(async (): Promise<void> => {
  for (const user of ['alice', 'bob'])
    await closeDialogue(
      user,
      user === 'alice' ? 'usage-session' : 'bob-session',
      'explicit',
    );
  setUsageRuntimeForTest(undefined);
  jest.restoreAllMocks();
});
afterAll(async (): Promise<void> => {
  await runtime.close(1000);
});

test('real hub dialogue pipeline retains background context, two successive requests, two tasks and checker, concurrent sessions, and excludes content', async (): Promise<void> => {
  let release!: () => void;
  const waiting = new Promise<void>(
    (resolve: (value: void | PromiseLike<void>) => void): void => {
      release = resolve;
    },
  );
  const toolCalls: CallOptions[] = [];
  const mcp: IMcpClient = {
    async listTools(): Promise<{
      ok: true;
      value: {
        name: string;
        description: string;
        inputSchema: { type: string; properties: Record<string, never> };
      }[];
    }> {
      return {
        ok: true,
        value: [
          {
            name: 'read',
            description: 'read',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    },
    async callTool(
      name: string,
      _args: object,
      options: CallOptions | undefined,
    ): Promise<{
      ok: true;
      value: { content: { type: string; text: string }[] };
    }> {
      await waiting;
      options?.usage?.record({
        kind: 'x.hub.request.physical-tool',
        context: {},
        outcome: 'ok',
        values: { index: toolCalls.length },
      });
      if (options) toolCalls.push(options);
      options?.usage?.record({
        kind: 'tool.call',
        context: {},
        tool: name,
        dispatched: true,
        embedded: false,
        outcome: 'ok',
        transportOutcome: 'ok',
        toolOutcome: 'ok',
        durationMs: 1,
      });
      return {
        ok: true,
        value: { content: [{ type: 'text', text: 'TOOL_RESULT_SENTINEL' }] },
      };
    },
  };
  const executorLlm = fakeLlm(
    (messages: Message[]): LlmResponse =>
      messages.some((m: Message): boolean => m.role === 'tool')
        ? plainAnswer()
        : {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'read-call',
                name: 'read',
                arguments: { key: 'TOOL_ARGUMENT_SENTINEL' },
              },
            ],
          },
  );
  const worker = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: {
      classificationEnabled: false,
      ragTranslateEnabled: false,
      maxIterations: 5,
    },
  })
    .withMainLlm(executorLlm)
    .withMcpClients([mcp])
    .build();
  mockWorkers.set('executor', new SmartAgentSubAgent('executor', worker.agent));
  mockWorkers.set('checker', new SmartAgentSubAgent('checker', worker.agent));
  let delegates = 0;
  const plannerLlm = fakeLlm(
    (
      messages: Message[],
      options: CallOptions | undefined,
    ):
      | LlmResponse
      | {
          content: string;
          finishReason: 'tool_calls';
          toolCalls: {
            id: string;
            name: string;
            arguments: { worker: string; goal: string };
          }[];
        } => {
      const last = messages.at(-1);
      if (
        last?.role === 'tool' ||
        last?.content?.includes('[task events]') ||
        delegates >= 4
      )
        return plainAnswer();
      const count = options?.trace?.traceId === 'request-1' ? 2 : 1;
      return {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: Array.from(
          { length: count },
          (): {
            id: string;
            name: string;
            arguments: { worker: string; goal: string };
          } => {
            delegates++;
            return {
              id: `delegate-${delegates}`,
              name: 'delegate_task',
              arguments: {
                worker:
                  options?.trace?.traceId === 'request-2'
                    ? 'checker'
                    : 'executor',
                goal: 'PROMPT_SENTINEL',
              },
            };
          },
        ),
      };
    },
  );
  const builtPlanner = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: { classificationEnabled: false, ragTranslateEnabled: false },
  })
    .withMainLlm(plannerLlm)
    .withMcpClients([new PlannerToolsClient()])
    .withMode('hard')
    .build();
  mockPlanner = builtPlanner.agent;
  const alice = await dialogueFor('alice', 'usage-session', 'TEST');
  const bob = await dialogueFor('bob', 'bob-session', 'TEST');
  const embed = jest
    .spyOn(OrchestrationEmbeddingClient.prototype, 'embed')
    .mockResolvedValue(await sdkResponse());
  const embedding = buildEmbedding({
    kind: 'sap-ai-core',
    model: 'text-embedding-3-small',
  });
  if (!embedding) throw new Error('Expected embedding');
  const queryEmbedder = agentQueryEmbedder(embedding, 'collection-retrieval');
  let embeddingCalls = 0;
  mockEmbedder = {
    embedQuery(
      text: string,
      options: CallOptions | undefined,
    ): Promise<IEmbedResult> {
      options?.usage?.record({
        kind: 'x.hub.request.physical-embedding',
        context: {},
        outcome: 'ok',
        values: { index: embeddingCalls++ },
      });
      return queryEmbedder.embedQuery(text, options);
    },
  };
  const app = express();
  app.post(
    '/dialogue/:user/:id',
    async (
      req: express.Request<{ user: string; id: string }>,
      res: express.Response,
    ): Promise<void> => {
      const userId = req.params.user;
      const id = req.params.id;
      const handle = userId === 'alice' ? alice : bob;
      const usage = handle.usage?.with({ requestId: id, traceId: id });
      const retrieval = collectionRetrieval({ deps: { ragStores: {} } });
      const retrieved = await retrieval.retrieve(
        { headers: { 'x-rag-collections': 'selected' }, body: {} },
        [{ role: 'user', content: 'PROMPT_SENTINEL' }],
        userId,
        userId === 'alice' ? 'usage-session' : 'bob-session',
        cds.log('usage-test'),
        false,
        usage,
      );
      if (!retrieved.messages) throw new Error('Unexpected retrieval refusal');
      const session: LongSession = {
        userId,
        key: userId === 'alice' ? 'usage-session' : 'bob-session',
        createdAt: Date.now(),
        lastActivity: Date.now(),
        revived: false,
        destination: 'TEST',
      };
      const result = await dialogueChat(
        req,
        userId,
        session,
        'TEST',
        res,
      ).process(retrieved.messages, { trace: { traceId: id } });
      if (id === 'request-2') res.destroy();
      else res.json(result);
    },
  );
  const server = createServer(app);
  await new Promise<void>(
    (
      resolve: (value: void | PromiseLike<void>) => void,
    ): Server<typeof IncomingMessage, typeof ServerResponse> =>
      server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected local server address');
  const start = async (userId: string, id: string): Promise<void> => {
    const request = fetch(
      `http://127.0.0.1:${address.port}/dialogue/${userId}/${id}`,
      { method: 'POST' },
    );
    if (id === 'request-2') await expect(request).rejects.toThrow();
    else {
      const response = await request;
      expect(response.status).toBe(200);
      await response.text();
    }
  };
  try {
    await start('alice', 'request-1');
    await Promise.all([start('alice', 'request-2'), start('bob', 'request-b')]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(
      (
        resolve: (value: void | PromiseLike<void>) => void,
      ): Server<typeof IncomingMessage, typeof ServerResponse> =>
        server.close((): void => resolve()),
    );
  }
  // All requests ended while physical tool calls are still blocked.
  expect(toolCalls).toHaveLength(0);
  release();
  await until(
    (): boolean =>
      alice.session.snapshot().tasks.length === 3 &&
      alice.session
        .snapshot()
        .tasks.every((t: TaskRecord): boolean => t.state === 'done') &&
      bob.session
        .snapshot()
        .tasks.every((t: TaskRecord): boolean => t.state === 'done'),
  );
  const records = await rows();
  const embeddings = records.filter(
    (r: UsageRecord): boolean =>
      r.kind === 'embedding.call' &&
      ['usage-session', 'bob-session'].includes(r.context.sessionId ?? ''),
  );
  expect(embeddings).toHaveLength(embed.mock.calls.length);
  expect(embeddings).toHaveLength(3);
  for (const [index, row] of embeddings.entries()) {
    const probe = records.find(
      (r: UsageRecord): boolean =>
        r.kind === 'x.hub.request.physical-embedding' &&
        r.values.index === index,
    );
    expect(probe).toBeDefined();
    expect(row.context).toEqual(probe?.context);
    expect(row.context).toMatchObject({
      role: 'embedding',
      component: 'collection-retrieval',
      sessionId:
        row.context.userId === 'alice' ? 'usage-session' : 'bob-session',
    });
  }
  const tasks = records.filter((r: UsageRecord): boolean => r.kind === 'task');
  expect(tasks).toHaveLength(4);
  expect(toolCalls).toHaveLength(4);
  expect(
    records.filter(
      (r: UsageRecord): boolean => r.kind === 'tool.call' && !r.embedded,
    ),
  ).toHaveLength(4);
  const calls = records.filter(
    (r: UsageRecord): boolean => r.kind === 'llm.call',
  );
  expect(calls).toHaveLength(physical.length);
  for (const [index, call] of calls.entries()) {
    expect(call).toMatchObject(physical[index].shape);
    const probe = records.find(
      (r: UsageRecord): boolean =>
        r.kind === 'x.hub.request.physical' && r.values.index === index,
    );
    expect(probe).toBeDefined();
    expect(call.context).toEqual(probe?.context);
    if (call.context.requestId)
      expect(['request-1', 'request-2', 'request-b']).toContain(
        call.context.requestId,
      );
    expect(call.context).toMatchObject({
      userId: call.context.sessionId === 'bob-session' ? 'bob' : 'alice',
      sessionId:
        call.context.userId === 'bob' ? 'bob-session' : 'usage-session',
    });
    expect(call.context.role).toBeDefined();
    expect(call.context.turnId).toBeDefined();
  }
  for (const row of tasks) {
    expect(row.context).toMatchObject({
      sessionId:
        row.context.userId === 'alice' ? 'usage-session' : 'bob-session',
      taskId: expect.any(String),
      turnId: expect.any(String),
    });
    if (row.kind === 'task') expect(row.context.role).toBe(row.worker);
  }
  const physicalTools = records.filter(
    (r: UsageRecord): boolean => r.kind === 'tool.call' && !r.embedded,
  );
  expect(
    physicalTools.filter(
      (r: UsageRecord): boolean => r.context.userId === 'alice',
    ),
  ).toHaveLength(3);
  expect(
    physicalTools.filter(
      (r: UsageRecord): boolean => r.context.userId === 'bob',
    ),
  ).toHaveLength(1);
  for (const [index, row] of physicalTools.entries()) {
    const probe = records.find(
      (r: UsageRecord): boolean =>
        r.kind === 'x.hub.request.physical-tool' && r.values.index === index,
    );
    expect(probe).toBeDefined();
    expect(row.context).toEqual(probe?.context);
    expect(row.context.sessionId).toBe(
      row.context.userId === 'alice' ? 'usage-session' : 'bob-session',
    );
  }
  for (const row of [...calls, ...physicalTools]) {
    if (row.context.taskId)
      expect(
        tasks.some(
          (task: UsageRecord): boolean =>
            task.context.taskId === row.context.taskId &&
            task.context.userId === row.context.userId,
        ),
      ).toBe(true);
    else expect(row.context.turnId).toBeDefined();
  }
  expect(
    tasks.some(
      (r: UsageRecord): boolean =>
        r.kind === 'task' &&
        r.worker === 'checker' &&
        r.context.userId === 'alice',
    ),
  ).toBe(true);
  expect(JSON.stringify(records)).not.toMatch(
    /PROMPT_SENTINEL|TOOL_ARGUMENT_SENTINEL|TOOL_RESULT_SENTINEL|RESULT_SENTINEL|DOCUMENT_SENTINEL/,
  );
});

test('step reviewer and guard pass helper labels and preserve request shape', async (): Promise<void> => {
  const usage = runtime
    .forSession({ sessionId: 'helpers', userId: 'alice', destination: 'TEST' })
    .with({ requestId: 'helpers-request' });
  const llm = fakeLlm((): { content: string; finishReason: 'stop' } => ({
    content: '{"possiblyFake":false,"confidence":"high","reasons":"ok"}',
    finishReason: 'stop',
  }));
  await reviewStep(
    { task: 'PROMPT_SENTINEL', executedTools: [], content: 'RESULT_SENTINEL' },
    { llm, usage },
  );
  const agent = await new SmartAgentBuilder({ skipModelValidation: true })
    .withMainLlm(llm)
    .build();
  const guarded = guardLlmOnlyAgent(agent.agent, {
    decide: fakeLlm((): { content: string; finishReason: 'stop' } => ({
      content: '{"action":true}',
      finishReason: 'stop',
    })),
    why: 'waiting',
  });
  await guarded.process([{ role: 'user', content: 'PROMPT_SENTINEL' }], {
    usage,
  });
  const calls = (await rows()).filter(
    (r: UsageRecord): boolean =>
      r.kind === 'llm.call' && r.context.sessionId === 'helpers',
  );
  expect(
    calls.map((r: UsageRecord): (string | undefined)[] => [
      r.context.role,
      r.context.component,
    ]),
  ).toEqual([
    ['reviewer', 'step-reviewer'],
    ['classifier', 'llm-only-guard'],
  ]);
  for (const [index, call] of calls.entries())
    expect(call).toMatchObject(physical[index].shape);
  expect(JSON.stringify(calls)).not.toMatch(/PROMPT_SENTINEL|RESULT_SENTINEL/);
});

test('SAP embedder records sdk calls once for success, error and abort; call recorder wins over construction recorder', async (): Promise<void> => {
  const embed = jest.spyOn(OrchestrationEmbeddingClient.prototype, 'embed');
  const clientResponse = await sdkResponse();
  embed.mockResolvedValue(clientResponse);
  const usage = runtime.forSession({ sessionId: 'sap', userId: 'alice' });
  const sap = new SapAiCoreEmbedder({
    model: 'text-embedding-3-small',
    usage: runtime.recorder,
  });
  try {
    expect(await sap.embed('DOCUMENT_SENTINEL', { usage })).toEqual({
      vector: [1, 2],
    });
    embed.mockRejectedValueOnce(
      Object.assign(new Error('SECRET_SENTINEL'), { code: 'ERR_SDK' }),
    );
    await expect(sap.embed('DOCUMENT_SENTINEL', { usage })).rejects.toThrow(
      'SECRET_SENTINEL',
    );
    const ctrl = new AbortController();
    ctrl.abort();
    embed.mockRejectedValueOnce(
      new DOMException('SECRET_SENTINEL', 'AbortError'),
    );
    await expect(
      sap.embed('DOCUMENT_SENTINEL', { usage, signal: ctrl.signal }),
    ).rejects.toThrow();
    embed.mockRejectedValueOnce(new Error('SECRET_SENTINEL'));
    await expect(
      sap.embed('DOCUMENT_SENTINEL', { usage, signal: ctrl.signal }),
    ).rejects.toThrow('SECRET_SENTINEL');
    embed.mockRejectedValueOnce(
      new DOMException('SECRET_SENTINEL', 'AbortError'),
    );
    await expect(sap.embed('DOCUMENT_SENTINEL', { usage })).rejects.toThrow();
    const operation = startOperation();
    await sap.embed('DOCUMENT_SENTINEL', {
      usage,
      usageOp: operation,
    });
    const calls = (await rows()).filter(
      (r: UsageRecord): boolean =>
        r.kind === 'embedding.call' && r.context.sessionId === 'sap',
    );
    expect(calls[1]).toMatchObject({ errorCode: 'ERR_SDK' });
    expect(embed.mock.calls[2]).toEqual([{ input: 'DOCUMENT_SENTINEL' }]);
    expect(
      calls.map((r: UsageRecord): 'error' | 'ok' | 'aborted' => r.outcome),
    ).toEqual(['ok', 'error', 'aborted', 'aborted', 'aborted', 'ok']);
    for (const row of calls)
      expect(row).toMatchObject({
        granularity: 'sdk-call',
        retriesVisible: false,
        inputs: 1,
        inputChars: 17,
      });
    expect(calls[5]).toMatchObject({
      operationId: operation.operationId,
      physicalSeq: 0,
      inputTokens: 1,
      tokensSource: 'provider',
    });
    expect(JSON.stringify(calls)).not.toMatch(
      /DOCUMENT_SENTINEL|SECRET_SENTINEL/,
    );
  } finally {
    embed.mockRestore();
  }
});

test('usage off passes no recorder to helper LLMs and leaves answers unchanged', async (): Promise<void> => {
  setUsageRuntimeForTest(undefined);
  const llm = fakeLlm((): { content: string; finishReason: 'stop' } => ({
    content: '{"possiblyFake":false,"confidence":"high","reasons":"ok"}',
    finishReason: 'stop',
  }));
  expect(
    await reviewStep(
      { task: 'task', content: 'answer', executedTools: [] },
      { llm },
    ),
  ).toMatchObject({ possiblyFake: false });
  const agent = await new SmartAgentBuilder({ skipModelValidation: true })
    .withMainLlm(llm)
    .build();
  await guardLlmOnlyAgent(agent.agent, {
    decide: fakeLlm((): { content: string; finishReason: 'stop' } => ({
      content: '{"action":true}',
      finishReason: 'stop',
    })),
    why: 'waiting',
  }).process('PROMPT_SENTINEL');
  expect(physical).toHaveLength(2);
  for (const call of physical) expect(call.options?.usage).toBeUndefined();
});

test('query embedding labels concurrent calls without binding mutable provider context', async (): Promise<void> => {
  const embed = jest
    .spyOn(OrchestrationEmbeddingClient.prototype, 'embed')
    .mockResolvedValue(await sdkResponse());
  const embedding = buildEmbedding({
    kind: 'sap-ai-core',
    model: 'text-embedding-3-small',
  });
  if (!embedding) throw new Error('Expected embedding');
  const query = agentQueryEmbedder(embedding);
  await Promise.all(
    ['query-a', 'query-b'].map(
      (sessionId: string): Promise<IEmbedResult> =>
        query.embedQuery('DOCUMENT_SENTINEL', {
          usage: runtime.forSession({ sessionId, userId: sessionId }),
        }),
    ),
  );
  const calls = (await rows()).filter(
    (r: UsageRecord): boolean | undefined =>
      r.kind === 'embedding.call' && r.context.sessionId?.startsWith('query-'),
  );
  expect(calls).toHaveLength(embed.mock.calls.length);
  expect(calls.map((r: UsageRecord): UsageContext => r.context)).toEqual(
    ['query-a', 'query-b'].map(
      (
        id: string,
      ): {
        sessionId: string;
        userId: string;
        role: string;
        component: string;
      } => ({
        sessionId: id,
        userId: id,
        role: 'embedding',
        component: 'query-embedder',
      }),
    ),
  );
});

test('revived dialogues bind a new session recorder and usage off passes none to the real pipeline', async (): Promise<void> => {
  mockPlanner = (
    await new SmartAgentBuilder({
      skipModelValidation: true,
      agent: { classificationEnabled: false, ragTranslateEnabled: false },
    })
      .withMainLlm(fakeLlm(plainAnswer))
      .build()
  ).agent;
  const opened = await dialogueFor('alice', 'usage-session', 'TEST');
  await opened.session.send('first');
  await closeDialogue('alice', 'usage-session', 'shutdown');
  const revived = await dialogueFor('alice', 'usage-session', 'TEST');
  expect(revived.usage).toBeDefined();
  expect(revived.usage).not.toBe(opened.usage);
  await revived.session.send('second');
  await closeDialogue('alice', 'usage-session', 'explicit');
  const before = (await rows()).length;
  setUsageRuntimeForTest(undefined);
  physical.length = 0;
  const off = await dialogueFor('alice', 'usage-session', 'TEST');
  expect(off.usage).toBeUndefined();
  const answer = await off.session.send('same result');
  expect(answer.text).toBe('RESULT_SENTINEL');
  for (const call of physical) expect(call.options?.usage).toBeUndefined();
  expect((await rows()).length).toBe(before);
});

test('SAP usage off returns embeddings for an aborted caller without passing a signal to the SDK', async (): Promise<void> => {
  const off = await initUsage(readUsageConfig({ LLM_AGENT_USAGE: 'off' }));
  setUsageRuntimeForTest(off);
  const before = (await rows()).length;
  const response = await sdkResponse();
  const operation = jest.mocked(llmAgent.startOperation);
  const request = jest.mocked(llmAgent.beginEmbeddingRequest);
  operation.mockClear();
  request.mockClear();
  const tokenUsage = jest.spyOn(response, 'getTokenUsage');
  const embed = jest
    .spyOn(OrchestrationEmbeddingClient.prototype, 'embed')
    .mockResolvedValue(response);
  const sap = new SapAiCoreEmbedder({ model: 'text-embedding-3-small' });
  const ctrl = new AbortController();
  ctrl.abort();

  expect(await sap.embed('DOCUMENT_SENTINEL', { signal: ctrl.signal })).toEqual(
    {
      vector: [1, 2],
    },
  );
  expect(embed.mock.calls).toEqual([[{ input: 'DOCUMENT_SENTINEL' }]]);
  expect(operation).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(tokenUsage).not.toHaveBeenCalled();
  expect((await rows()).length).toBe(before);
});

test.each([
  ['openai', false],
  ['openai', true],
  ['anthropic', false],
  ['anthropic', true],
])(
  'real dialogue %s (stream=%s) correlates request and LLM records without retrieval or embedding',
  async (protocol: string | boolean, stream:
    | string
    | boolean): Promise<void> => {
    const before = (await rows()).length;
    const built = await new SmartAgentBuilder({
      skipModelValidation: true,
      agent: { classificationEnabled: false, ragTranslateEnabled: false },
    })
      .withMainLlm(fakeLlm(plainAnswer))
      .build();
    mockPlanner = guardLlmOnlyAgent(built.agent, {
      decide: fakeLlm((): { content: string; finishReason: 'stop' } => ({
        content: '{"action":false}',
        finishReason: 'stop',
      })),
      why: 'waiting',
    });
    const embed = jest
      .spyOn(OrchestrationEmbeddingClient.prototype, 'embed')
      .mockResolvedValue(await sdkResponse());
    const embedding = buildEmbedding({
      kind: 'sap-ai-core',
      model: 'text-embedding-3-small',
    });
    if (!embedding) throw new Error('Expected embedding');
    mockEmbedder = agentQueryEmbedder(embedding, 'collection-retrieval');
    const registry = new LongSessionRegistry(
      { ttlMs: 3600000, maxSessions: 10, maxPerUser: 10, queueLength: 3 },
      lifecycleHooks(),
    );
    const session = registry.open('alice', {
      key: 'handler-long-session',
      destination: 'TEST',
    });
    if ('refused' in session) throw new Error('Session refused');
    setLongSessionsForTest(registry);
    const app = express();
    app.use(express.json());
    app.use(
      sessionMiddleware({
        userIdOf: (): string => 'alice',
        resolveSession: async (
          user: string,
          key: string,
        ): Promise<LongSession | undefined> => registry.get(user, key),
      }),
    );
    app.post(
      '/chat/completions',
      protocol === 'openai' ? handleChatCompletions : handleAnthropicMessages,
    );
    const server = createServer(app);
    await new Promise<void>(
      (
        resolve: (value: void | PromiseLike<void>) => void,
      ): Server<typeof IncomingMessage, typeof ServerResponse> =>
        server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected address');
    try {
      for (let index = 0; index < 2; index++) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/chat/completions`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(2000),
            headers: {
              'content-type': 'application/json',
              'x-clh-session': session.key,
              'x-sap-destination': 'TEST',
              'x-rag-collections': 'selected',
            },
            body: JSON.stringify({
              model: 'm',
              stream,
              max_tokens: 100,
              messages: [{ role: 'user', content: 'PROMPT_SENTINEL' }],
            }),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('RESULT_SENTINEL');
      }
      const records = (await rows())
        .slice(before)
        .filter(
          (r: UsageRecord): boolean =>
            r.context.sessionId === session.key &&
            [
              'llm.call',
              'embedding.call',
              'x.hub.request',
              'x.hub.retrieval',
            ].includes(r.kind),
        );
      expect(embed).not.toHaveBeenCalled();
      expect(
        records.filter(
          (r: UsageRecord): boolean =>
            r.kind === 'embedding.call' || r.kind === 'x.hub.retrieval',
        ),
      ).toHaveLength(0);
      expect(records).toHaveLength(6);
      const requestIds = new Set(
        records.map(
          (r: UsageRecord): string | undefined => r.context.requestId,
        ),
      );
      expect(requestIds.size).toBe(2);
      for (const requestId of requestIds) {
        expect(requestId).toEqual(expect.any(String));
        const request = records.filter(
          (r: UsageRecord): boolean => r.context.requestId === requestId,
        );
        expect(request).toHaveLength(3);
        expect(
          request
            .filter(
              (r: UsageRecord): boolean =>
                r.kind === 'llm.call' || r.kind === 'embedding.call',
            )
            .map((r: UsageRecord): string | undefined => r.context.component)
            .sort(),
        ).toEqual(['llm-only-guard', 'tool-loop'].sort());
        for (const record of request)
          expect(record.context).toMatchObject({
            userId: 'alice',
            sessionId: session.key,
            requestId,
            traceId: requestId,
          });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(
        (
          resolve: (value: void | PromiseLike<void>) => void,
        ): Server<typeof IncomingMessage, typeof ServerResponse> =>
          server.close((): void => resolve()),
      );
      await closeDialogue('alice', session.key, 'explicit');
      setLongSessionsForTest(undefined);
    }
  },
);

test('concurrent long-session OpenAI requests isolate all foreground and background usage', async (): Promise<void> => {
  let release!: () => void;
  const backgroundGate = new Promise<void>((resolve: () => void): void => {
    release = resolve;
  });
  // Autonomous task-event turns are separate from either HTTP request. Keep
  // their transport calls outside the request attribution observation window.
  let releaseFollowup!: () => void;
  const followupGate = new Promise<void>((resolve: () => void): void => {
    releaseFollowup = resolve;
  });
  const beforeChat = async (options?: CallOptions): Promise<void> => {
    if (!options?.trace?.traceId) await followupGate;
  };
  const toolRequests: CallOptions[] = [];
  const mcp: IMcpClient = {
    async listTools(): Promise<{
      ok: true;
      value: {
        name: string;
        description: string;
        inputSchema: { type: string; properties: Record<string, never> };
      }[];
    }> {
      return {
        ok: true,
        value: [
          {
            name: 'read',
            description: 'read',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    },
    async callTool(
      name: string,
      _args: object,
      options?: CallOptions,
    ): Promise<{
      ok: true;
      value: { content: { type: string; text: string }[] };
    }> {
      if (options) toolRequests.push(options);
      await backgroundGate;
      options?.usage?.record({
        kind: 'tool.call',
        context: {},
        tool: name,
        dispatched: true,
        embedded: false,
        outcome: 'ok',
        transportOutcome: 'ok',
        toolOutcome: 'ok',
        durationMs: 1,
      });
      return {
        ok: true,
        value: { content: [{ type: 'text', text: 'TOOL_RESULT_SENTINEL' }] },
      };
    },
  };
  const worker = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: {
      classificationEnabled: false,
      ragTranslateEnabled: false,
      maxIterations: 5,
    },
  })
    .withMainLlm(
      fakeLlm(
        (messages: Message[]): LlmResponse =>
          messages.some((message: Message): boolean => message.role === 'tool')
            ? plainAnswer()
            : {
                content: '',
                finishReason: 'tool_calls',
                toolCalls: [{ id: 'read-call', name: 'read', arguments: {} }],
              },
      ),
    )
    .withMcpClients([mcp])
    .build();
  mockWorkers.set('executor', new SmartAgentSubAgent('executor', worker.agent));
  const planner = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: { classificationEnabled: false, ragTranslateEnabled: false },
  })
    .withMainLlm(
      fakeLlm((messages: Message[]): LlmResponse => {
        const last = messages.at(-1);
        return last?.role === 'tool' || last?.content?.includes('[task events]')
          ? plainAnswer()
          : {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: 'delegate',
                  name: 'delegate_task',
                  arguments: {
                    worker: 'executor',
                    goal: 'PROMPT_SENTINEL',
                  },
                },
              ],
            };
      }),
    )
    .withMcpClients([new PlannerToolsClient()])
    .withMode('hard')
    .build();
  const requestIds = new Map<string, string>();
  mockPlanner = guardLlmOnlyAgent(planner.agent, {
    decide: fakeLlm(
      (
        _messages: Message[],
        options?: CallOptions,
      ): { content: string; finishReason: 'stop' } => {
        const user = mockAuthenticatedUser.getStore();
        const requestId = options?.trace?.traceId;
        if (user && requestId) requestIds.set(user, requestId);
        return { content: '{"action":false}', finishReason: 'stop' };
      },
      beforeChat,
    ),
    why: 'waiting',
  });
  jest
    .spyOn(OrchestrationEmbeddingClient.prototype, 'embed')
    .mockResolvedValue(await sdkResponse());
  const embedding = buildEmbedding({
    kind: 'sap-ai-core',
    model: 'text-embedding-3-small',
  });
  if (!embedding) throw new Error('Expected embedding');
  const query = agentQueryEmbedder(embedding, 'collection-retrieval');
  let retrievalsStarted = 0;
  mockEmbedder = {
    async embedQuery(
      text: string,
      options?: Parameters<typeof query.embedQuery>[1],
    ): Promise<IEmbedResult> {
      retrievalsStarted++;
      return query.embedQuery(text, options);
    },
  };
  const registry = new LongSessionRegistry(
    { ttlMs: 3600000, maxSessions: 10, maxPerUser: 10, queueLength: 3 },
    lifecycleHooks(),
  );
  const cases = [
    {
      userId: 'alice',
      sessionId: 'concurrent-alice',
      prompt: 'CONCURRENT_ALICE_SENTINEL',
    },
    {
      userId: 'bob',
      sessionId: 'concurrent-bob',
      prompt: 'CONCURRENT_BOB_SENTINEL',
    },
  ];
  for (const entry of cases) {
    const session = registry.open(entry.userId, {
      key: entry.sessionId,
      destination: 'TEST',
    });
    if ('refused' in session) throw new Error('Session refused');
  }
  setLongSessionsForTest(registry);
  const app = express();
  app.use(express.json());
  app.use(
    (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ): void => {
      mockAuthenticatedUser.run(req.header('x-test-user') ?? 'anonymous', next);
    },
  );
  app.use(
    sessionMiddleware({
      userIdOf: (): string => mockAuthenticatedUser.getStore() ?? 'anonymous',
      resolveSession: async (
        user: string,
        key: string,
      ): Promise<LongSession | undefined> => registry.get(user, key),
    }),
  );
  app.post('/chat/completions', handleChatCompletions);
  const server = createServer(app);
  await new Promise<void>(
    (
      resolve: () => void,
    ): Server<typeof IncomingMessage, typeof ServerResponse> =>
      server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected address');
  const before = (await rows()).length;
  try {
    await Promise.all(
      cases.map(async (entry: (typeof cases)[number]): Promise<void> => {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/chat/completions`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
            headers: {
              'content-type': 'application/json',
              'x-test-user': entry.userId,
              'x-clh-session': entry.sessionId,
              'x-sap-destination': 'TEST',
              'x-rag-collections': 'selected',
            },
            body: JSON.stringify({
              model: 'm',
              messages: [{ role: 'user', content: entry.prompt }],
            }),
          },
        );
        const body = await response.text();
        if (response.status !== 200) throw new Error(body);
      }),
    );
    expect(retrievalsStarted).toBe(0);
    await until((): boolean => toolRequests.length === 2);
    const blocked = (await rows()).slice(before);
    expect(
      blocked.filter(
        (row: UsageRecord): boolean =>
          row.kind === 'task' || row.kind === 'tool.call',
      ),
    ).toHaveLength(0);
    release();
    const handles = await Promise.all(
      cases.map(
        (entry: (typeof cases)[number]): Promise<DialogueHandle> =>
          dialogueFor(entry.userId, entry.sessionId, 'TEST'),
      ),
    );
    await until((): boolean =>
      handles.every((handle: (typeof handles)[number]): boolean => {
        const tasks = handle.session.snapshot().tasks;
        return (
          tasks.length === 1 &&
          tasks.every(
            (task: (typeof tasks)[number]): boolean => task.state === 'done',
          )
        );
      }),
    );
    const records = (await rows()).slice(before);
    expect(requestIds.size).toBe(2);
    expect(new Set(requestIds.values()).size).toBe(2);
    for (const entry of cases) {
      const requestId = requestIds.get(entry.userId);
      expect(requestId).toEqual(expect.any(String));
      // Select by each identity independently so a swapped or partly mixed label
      // cannot disappear from the assertions through a session-only filter.
      const own = records.filter(
        (row: UsageRecord): boolean =>
          row.context.sessionId === entry.sessionId ||
          row.context.userId === entry.userId ||
          row.context.requestId === requestId,
      );
      expect(
        own.some(
          (row: UsageRecord): boolean =>
            row.kind === 'embedding.call' || row.kind === 'x.hub.retrieval',
        ),
      ).toBe(false);
      expect(
        own.some(
          (row: UsageRecord): boolean =>
            row.kind === 'llm.call' && row.context.role === 'classifier',
        ),
      ).toBe(true);
      expect(
        own.some(
          (row: UsageRecord): boolean =>
            row.kind === 'llm.call' &&
            row.context.role === 'planner' &&
            row.context.component === 'tool-loop' &&
            !row.context.taskId,
        ),
      ).toBe(true);
      expect(
        own.filter((row: UsageRecord): boolean => row.kind === 'task'),
      ).toHaveLength(1);
      expect(
        own.filter(
          (row: UsageRecord): boolean =>
            row.kind === 'tool.call' && !row.embedded,
        ),
      ).toHaveLength(1);
      for (const row of own) {
        expect(row.context).toMatchObject({
          sessionId: entry.sessionId,
          userId: entry.userId,
          requestId,
        });
        for (const other of cases.filter(
          (candidate: (typeof cases)[number]): boolean => candidate !== entry,
        )) {
          expect(row.context.sessionId).not.toBe(other.sessionId);
          expect(row.context.userId).not.toBe(other.userId);
          expect(row.context.requestId).not.toBe(requestIds.get(other.userId));
        }
      }
    }
    for (const row of records) {
      expect(
        cases.some(
          (entry: (typeof cases)[number]): boolean =>
            row.context.sessionId === entry.sessionId,
        ),
      ).toBe(true);
    }
  } finally {
    release();
    releaseFollowup();
    server.closeAllConnections();
    await new Promise<void>(
      (
        resolve: () => void,
      ): Server<typeof IncomingMessage, typeof ServerResponse> =>
        server.close((): void => resolve()),
    );
    for (const entry of cases)
      await closeDialogue(entry.userId, entry.sessionId, 'explicit');
    setLongSessionsForTest(undefined);
  }
});

test('real MCP agent tool loop correlates request, LLM and dispatched MCP records', async (): Promise<void> => {
  const before = (await rows()).length;
  const mcp: IMcpClient = {
    async listTools(): Promise<{
      ok: true;
      value: {
        name: string;
        description: string;
        inputSchema: { type: string; properties: Record<string, never> };
      }[];
    }> {
      return {
        ok: true,
        value: [
          {
            name: 'read',
            description: 'read',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    },
    async callTool(
      name: string,
      _args: object,
      options?: CallOptions,
    ): Promise<{
      ok: true;
      value: { content: { type: string; text: string }[] };
    }> {
      options?.usage?.record({
        kind: 'tool.call',
        context: {},
        tool: name,
        dispatched: true,
        embedded: false,
        outcome: 'ok',
        transportOutcome: 'ok',
        toolOutcome: 'ok',
        durationMs: 1,
      });
      return {
        ok: true,
        value: { content: [{ type: 'text', text: 'tool result' }] },
      };
    },
  };
  const built = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: { classificationEnabled: false, ragTranslateEnabled: false },
  })
    .withMainLlm(
      fakeLlm(
        (messages: Message[]): LlmResponse =>
          messages.some((message: Message): boolean => message.role === 'tool')
            ? plainAnswer()
            : {
                content: '',
                finishReason: 'tool_calls',
                toolCalls: [{ id: 'read-call', name: 'read', arguments: {} }],
              },
      ),
    )
    .withMcpClients([mcp])
    .build();
  mockStepAgent = built.agent;
  const registry = new LongSessionRegistry(
    { ttlMs: 60000, maxSessions: 10, maxPerUser: 10, queueLength: 3 },
    lifecycleHooks(),
  );
  const session = registry.open('alice', {
    key: 'mcp-correlation',
    destination: 'TEST',
  });
  if ('refused' in session) throw new Error('Session refused');
  setLongSessionsForTest(registry);
  const app = express();
  app.use(express.json());
  app.post(
    '/',
    async (req: express.Request, res: express.Response): Promise<void> => {
      res.json(
        await executeStep(
          req,
          { userId: 'alice', exposition: undefined },
          { task: 'run', session: session.key },
        ),
      );
    },
  );
  const server = createServer(app);
  await new Promise<void>(
    (
      resolve: () => void,
    ): Server<typeof IncomingMessage, typeof ServerResponse> =>
      server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(await response.text()).toContain('RESULT_SENTINEL');
    const records = (await rows())
      .slice(before)
      .filter((record: UsageRecord): boolean =>
        ['x.hub.request', 'llm.call', 'tool.call'].includes(record.kind),
      );
    expect(
      records.map(
        (
          record: UsageRecord,
        ):
          | 'task'
          | 'llm.call'
          | 'embedding.call'
          | 'tool.call'
          | `x.${string}` => record.kind,
      ),
    ).toEqual(
      expect.arrayContaining(['x.hub.request', 'llm.call', 'tool.call']),
    );
    const request = records.find(
      (record: UsageRecord): boolean => record.kind === 'x.hub.request',
    );
    expect(request?.context.requestId).toEqual(expect.any(String));
    for (const record of records)
      expect(record.context).toMatchObject({
        requestId: request?.context.requestId,
        traceId: request?.context.requestId,
        sessionId: session.key,
      });
  } finally {
    mockStepAgent = undefined;
    server.closeAllConnections();
    await new Promise<void>(
      (
        resolve: () => void,
      ): Server<typeof IncomingMessage, typeof ServerResponse> =>
        server.close((): void => resolve()),
    );
    await registry.closeAll('explicit');
    setLongSessionsForTest(undefined);
  }
});
