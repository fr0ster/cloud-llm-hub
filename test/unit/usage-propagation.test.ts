import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import {
  beginLlmRequest,
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
import { collectionRetrieval } from '../../srv/lib/collection-retrieval';
import { dialogueChat } from '../../srv/lib/dialogue-chat';
import { closeDialogue, dialogueFor } from '../../srv/lib/dialogue-sessions';
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

const mockAuthenticatedUser = new AsyncLocalStorage<string>();
const mockWorkers = new Map<string, ISubAgent>();
let mockPlanner: Awaited<ReturnType<SmartAgentBuilder['build']>>['agent'];
const mockQuery = jest.fn(
  async (embedding: { toVector(): Promise<number[]> }) => {
    await embedding.toVector();
    return { ok: true, value: [{ text: 'DOCUMENT_SENTINEL', score: 1 }] };
  },
);
let mockEmbedder: ReturnType<typeof agentQueryEmbedder> | undefined;
jest.mock('../../srv/lib/logging-config', () => ({ applyLoggingConfig() {} }));
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    context: {
      get user() {
        return {
          id: mockAuthenticatedUser.getStore() ?? 'alice',
          is: () => true,
          roles: ['MCP_Developer'],
        };
      },
    },
  },
}));
jest.mock('../../srv/agent-config', () => ({
  ...jest.requireActual<typeof import('../../srv/agent-config')>(
    '../../srv/agent-config',
  ),
  getAgentConfig: () => ({
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
jest.mock('../../srv/agent-manager', () => ({
  ...jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .agentManagerMock(),
  getSmartAgent: async () => ({
    agent: { deps: { ragStores: {} } },
    workers: mockWorkers,
    recMcp: { getToolRecords: () => [], dropRequest() {} },
    criticLlm: {},
  }),
  buildPlannerAgent: async () => mockPlanner,
  releasePlannerAgent() {},
  setSessionDestination() {},
  runWithRequestConnection: <T>(_connection: object, fn: () => T) => fn(),
  getQueryEmbedder: () => mockEmbedder,
  getCollectionRegistry: () => ({
    ready: Promise.resolve(),
    degradedOf: async () => undefined,
    getRagStores: async () => ({}),
    getRagStore: async () => ({ query: mockQuery }),
  }),
}));
jest.mock('../../srv/collection-ids', () => ({
  resolveRouteId: async () => 'selected',
}));
jest.mock('../../srv/lib/session-connection-pool', () => ({
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
      return { connection: {}, system: {}, release: async () => {} };
    }
    async closeAll() {}
  },
}));
jest.mock('../../srv/lib/gatekeeper', () => ({
  ...jest.requireActual<typeof import('../../srv/lib/gatekeeper')>(
    '../../srv/lib/gatekeeper',
  ),
  admitPipeline: async () => ({
    admitted: {
      signal: new AbortController().signal,
      run: <T>(fn: () => T) => fn(),
      drain: async () => {},
      release() {},
    },
  }),
  admitBackground: async () => ({
    admitted: {
      signal: new AbortController().signal,
      run: <T>(fn: () => T) => fn(),
      drain: async () => {},
      release() {},
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
  return {
    model: 'fake',
    async chat(messages, tools, options) {
      if (beforeChat) await beforeChat(options);
      options?.usage?.record({
        kind: 'x.hub.request.physical',
        context: {},
        outcome: 'ok',
        values: { index: physical.length },
      });
      physical.push({ options, shape: requestShape(messages, tools) });
      const call = beginLlmRequest(options, startOperation(options), {
        ...requestShape(messages, tools),
        provider: 'fake',
        model: 'fake',
        stream: false,
        granularity: 'request',
        retriesVisible: true,
      });
      try {
        return { ok: true, value: answer(messages, options) };
      } finally {
        call.end({ outcome: 'ok' });
      }
    },
    async *streamChat(messages, tools, options) {
      const result = await this.chat(messages, tools, options);
      if (result.ok)
        yield {
          ok: true,
          value: {
            content: result.value.content,
            finishReason: result.value.finishReason,
            toolCalls: result.value.toolCalls,
          },
        };
    },
  };
}
async function sdkResponse(
  count = 1,
  indexes = Array.from(
    { length: count },
    (_: undefined, index: number) => index,
  ),
) {
  const response: Awaited<ReturnType<OrchestrationEmbeddingClient['embed']>> =
    new (
      await import('@sap-ai-sdk/orchestration')
    ).OrchestrationEmbeddingResponse({
      data: {
        final_result: {
          data: Array.from(
            { length: count },
            (_: undefined, index: number) => ({
              embedding: count === 1 ? [1, 2] : [indexes[index], 2],
              index: indexes[index],
              object: 'embedding',
            }),
          ),
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
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Pipeline did not settle');
}
beforeAll(async () => {
  const enabled = await initUsage(
    readUsageConfig({
      LLM_AGENT_USAGE: 'on',
      LLM_AGENT_USAGE_SINKS: 'memory',
      LLM_AGENT_USAGE_USER_ID: 'plain',
    }),
    { recorderFactory: () => recorder },
  );
  if (!enabled) throw new Error('Expected usage runtime');
  runtime = enabled;
});
beforeEach(() => {
  setUsageRuntimeForTest(runtime);
  physical.length = 0;
});
afterEach(async () => {
  for (const user of ['alice', 'bob'])
    await closeDialogue(
      user,
      user === 'alice' ? 'usage-session' : 'bob-session',
      'explicit',
    );
  setUsageRuntimeForTest(undefined);
  jest.restoreAllMocks();
});
afterAll(async () => {
  await runtime.close(1000);
});

test('real hub dialogue pipeline retains background context, two successive requests, two tasks and checker, concurrent sessions, and excludes content', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const toolCalls: CallOptions[] = [];
  const mcp: IMcpClient = {
    async listTools() {
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
    async callTool(name, _args: object, options) {
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
  const executorLlm = fakeLlm((messages) =>
    messages.some((m) => m.role === 'tool')
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
  const plannerLlm = fakeLlm((messages, options) => {
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
      toolCalls: Array.from({ length: count }, () => {
        delegates++;
        return {
          id: `delegate-${delegates}`,
          name: 'delegate_task',
          arguments: {
            worker:
              options?.trace?.traceId === 'request-2' ? 'checker' : 'executor',
            goal: 'PROMPT_SENTINEL',
            history: 'all',
          },
        };
      }),
    };
  });
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
    embedQuery(text, options) {
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
  app.post('/dialogue/:user/:id', async (req, res) => {
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
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected local server address');
  const start = async (userId: string, id: string) => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // All requests ended while physical tool calls are still blocked.
  expect(toolCalls).toHaveLength(0);
  release();
  await until(
    () =>
      alice.session.snapshot().tasks.length === 3 &&
      alice.session.snapshot().tasks.every((t) => t.state === 'done') &&
      bob.session.snapshot().tasks.every((t) => t.state === 'done'),
  );
  const records = await rows();
  const embeddings = records.filter(
    (r) =>
      r.kind === 'embedding.call' &&
      ['usage-session', 'bob-session'].includes(r.context.sessionId ?? ''),
  );
  expect(embeddings).toHaveLength(embed.mock.calls.length);
  expect(embeddings).toHaveLength(3);
  for (const [index, row] of embeddings.entries()) {
    const probe = records.find(
      (r) =>
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
  const tasks = records.filter((r) => r.kind === 'task');
  expect(tasks).toHaveLength(4);
  expect(toolCalls).toHaveLength(4);
  expect(
    records.filter((r) => r.kind === 'tool.call' && !r.embedded),
  ).toHaveLength(4);
  const calls = records.filter((r) => r.kind === 'llm.call');
  expect(calls).toHaveLength(physical.length);
  for (const [index, call] of calls.entries()) {
    expect(call).toMatchObject(physical[index].shape);
    const probe = records.find(
      (r) => r.kind === 'x.hub.request.physical' && r.values.index === index,
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
    (r) => r.kind === 'tool.call' && !r.embedded,
  );
  expect(
    physicalTools.filter((r) => r.context.userId === 'alice'),
  ).toHaveLength(3);
  expect(physicalTools.filter((r) => r.context.userId === 'bob')).toHaveLength(
    1,
  );
  for (const [index, row] of physicalTools.entries()) {
    const probe = records.find(
      (r) =>
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
          (task) =>
            task.context.taskId === row.context.taskId &&
            task.context.userId === row.context.userId,
        ),
      ).toBe(true);
    else expect(row.context.turnId).toBeDefined();
  }
  expect(
    tasks.some(
      (r) =>
        r.kind === 'task' &&
        r.worker === 'checker' &&
        r.context.userId === 'alice',
    ),
  ).toBe(true);
  expect(JSON.stringify(records)).not.toMatch(
    /PROMPT_SENTINEL|TOOL_ARGUMENT_SENTINEL|TOOL_RESULT_SENTINEL|RESULT_SENTINEL|DOCUMENT_SENTINEL/,
  );
});

test('step reviewer and guard pass helper labels and preserve request shape', async () => {
  const usage = runtime
    .forSession({ sessionId: 'helpers', userId: 'alice', destination: 'TEST' })
    .with({ requestId: 'helpers-request' });
  const llm = fakeLlm(() => ({
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
    decide: fakeLlm(() => ({
      content: '{"action":true}',
      finishReason: 'stop',
    })),
    why: 'waiting',
  });
  await guarded.process([{ role: 'user', content: 'PROMPT_SENTINEL' }], {
    usage,
  });
  const calls = (await rows()).filter(
    (r) => r.kind === 'llm.call' && r.context.sessionId === 'helpers',
  );
  expect(calls.map((r) => [r.context.role, r.context.component])).toEqual([
    ['reviewer', 'step-reviewer'],
    ['classifier', 'llm-only-guard'],
  ]);
  for (const [index, call] of calls.entries())
    expect(call).toMatchObject(physical[index].shape);
  expect(JSON.stringify(calls)).not.toMatch(/PROMPT_SENTINEL|RESULT_SENTINEL/);
});

test('SAP embedder records sdk calls once for success, error, abort and batch; call recorder wins over construction recorder', async () => {
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
    embed.mockResolvedValueOnce(await sdkResponse(2));
    const operation = startOperation();
    await sap.embedBatch(['DOCUMENT_SENTINEL', 'DOCUMENT_SENTINEL'], {
      usage,
      usageOp: operation,
    });
    const calls = (await rows()).filter(
      (r) => r.kind === 'embedding.call' && r.context.sessionId === 'sap',
    );
    expect(calls[1]).toMatchObject({ errorCode: 'ERR_SDK' });
    expect(embed.mock.calls[2][1]?.signal).toBe(ctrl.signal);
    expect(calls.map((r) => r.outcome)).toEqual([
      'ok',
      'error',
      'aborted',
      'ok',
    ]);
    for (const [index, row] of calls.entries())
      expect(row).toMatchObject({
        granularity: 'sdk-call',
        retriesVisible: false,
        inputs: index === 3 ? 2 : 1,
        inputChars: index === 3 ? 34 : 17,
      });
    expect(calls[3]).toMatchObject({
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

test('usage off passes no recorder to helper LLMs and leaves answers unchanged', async () => {
  setUsageRuntimeForTest(undefined);
  const llm = fakeLlm(() => ({
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
    decide: fakeLlm(() => ({
      content: '{"action":true}',
      finishReason: 'stop',
    })),
    why: 'waiting',
  }).process('PROMPT_SENTINEL');
  expect(physical).toHaveLength(2);
  for (const call of physical) expect(call.options?.usage).toBeUndefined();
});

test('query embedding labels concurrent calls without binding mutable provider context', async () => {
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
    ['query-a', 'query-b'].map((sessionId) =>
      query.embedQuery('DOCUMENT_SENTINEL', {
        usage: runtime.forSession({ sessionId, userId: sessionId }),
      }),
    ),
  );
  const calls = (await rows()).filter(
    (r) =>
      r.kind === 'embedding.call' && r.context.sessionId?.startsWith('query-'),
  );
  expect(calls).toHaveLength(embed.mock.calls.length);
  expect(calls.map((r) => r.context)).toEqual(
    ['query-a', 'query-b'].map((id) => ({
      sessionId: id,
      userId: id,
      role: 'embedding',
      component: 'query-embedder',
    })),
  );
});

test('revived dialogues bind a new session recorder and usage off passes none to the real pipeline', async () => {
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

test('SAP batch reconstructs indexed vectors and rejects missing, duplicate and invalid indexes with error records', async () => {
  const embed = jest.spyOn(OrchestrationEmbeddingClient.prototype, 'embed');
  const sap = new SapAiCoreEmbedder({
    model: 'text-embedding-3-small',
    usage: runtime.forSession({ sessionId: 'sap-indexes', userId: 'alice' }),
  });
  embed.mockResolvedValueOnce(await sdkResponse(2, [1, 0]));
  expect(await sap.embedBatch(['first', 'second'])).toEqual([
    { vector: [0, 2] },
    { vector: [1, 2] },
  ]);
  for (const indexes of [[0], [0, 0], [0, 2], [0, -1], [0, 0.5]]) {
    embed.mockResolvedValueOnce(await sdkResponse(indexes.length, indexes));
    await expect(sap.embedBatch(['first', 'second'])).rejects.toThrow();
  }
  const records = (await rows()).filter(
    (r) => r.kind === 'embedding.call' && r.context.sessionId === 'sap-indexes',
  );
  expect(records.map((r) => r.outcome)).toEqual([
    'ok',
    'error',
    'error',
    'error',
    'error',
    'error',
  ]);
  expect(records).toHaveLength(embed.mock.calls.length);
});

test('successive long-session OpenAI requests share retrieval, guard and planner attribution through session middleware', async () => {
  const built = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: { classificationEnabled: false, ragTranslateEnabled: false },
  })
    .withMainLlm(fakeLlm(plainAnswer))
    .build();
  mockPlanner = guardLlmOnlyAgent(built.agent, {
    decide: fakeLlm(() => ({
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
      userIdOf: () => 'alice',
      resolveSession: async (user, key) => registry.get(user, key),
    }),
  );
  app.post('/chat/completions', handleChatCompletions);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
            messages: [{ role: 'user', content: 'PROMPT_SENTINEL' }],
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('RESULT_SENTINEL');
    }
    const records = (await rows()).filter(
      (r) =>
        r.context.sessionId === session.key &&
        (r.kind === 'llm.call' || r.kind === 'embedding.call'),
    );
    expect(embed).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(6);
    const requestIds = new Set(records.map((r) => r.context.requestId));
    expect(requestIds.size).toBe(2);
    for (const requestId of requestIds) {
      expect(requestId).toEqual(expect.any(String));
      const request = records.filter((r) => r.context.requestId === requestId);
      expect(request).toHaveLength(3);
      expect(request.map((r) => r.context.component).sort()).toEqual(
        ['collection-retrieval', 'llm-only-guard', undefined].sort(),
      );
      for (const record of request)
        expect(record.context).toMatchObject({
          userId: 'alice',
          sessionId: session.key,
          requestId,
        });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDialogue('alice', session.key, 'explicit');
    setLongSessionsForTest(undefined);
  }
});

test('concurrent long-session OpenAI requests isolate all foreground and background usage', async () => {
  let release!: () => void;
  const backgroundGate = new Promise<void>((resolve: () => void) => {
    release = resolve;
  });
  // Autonomous task-event turns are separate from either HTTP request. Keep
  // their transport calls outside the request attribution observation window.
  let releaseFollowup!: () => void;
  const followupGate = new Promise<void>((resolve: () => void) => {
    releaseFollowup = resolve;
  });
  const beforeChat = async (options?: CallOptions): Promise<void> => {
    if (!options?.trace?.traceId) await followupGate;
  };
  const toolRequests: CallOptions[] = [];
  const mcp: IMcpClient = {
    async listTools() {
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
    async callTool(name: string, _args: object, options?: CallOptions) {
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
      fakeLlm((messages: Message[]) =>
        messages.some((message: Message) => message.role === 'tool')
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
      fakeLlm((messages: Message[]) => {
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
                    history: 'all',
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
    decide: fakeLlm((_messages: Message[], options?: CallOptions) => {
      const user = mockAuthenticatedUser.getStore();
      const requestId = options?.trace?.traceId;
      if (user && requestId) requestIds.set(user, requestId);
      return { content: '{"action":false}', finishReason: 'stop' };
    }, beforeChat),
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
  let releaseRetrieval!: () => void;
  const retrievalGate = new Promise<void>((resolve: () => void) => {
    releaseRetrieval = resolve;
  });
  let retrievalsStarted = 0;
  mockEmbedder = {
    async embedQuery(
      text: string,
      options?: Parameters<typeof query.embedQuery>[1],
    ) {
      retrievalsStarted++;
      if (retrievalsStarted === 2) releaseRetrieval();
      await retrievalGate;
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
    ) => {
      mockAuthenticatedUser.run(req.header('x-test-user') ?? 'anonymous', next);
    },
  );
  app.use(
    sessionMiddleware({
      userIdOf: () => mockAuthenticatedUser.getStore() ?? 'anonymous',
      resolveSession: async (user: string, key: string) =>
        registry.get(user, key),
    }),
  );
  app.post('/chat/completions', handleChatCompletions);
  const server = createServer(app);
  await new Promise<void>((resolve: () => void) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected address');
  const before = (await rows()).length;
  try {
    await Promise.all(
      cases.map(async (entry: (typeof cases)[number]) => {
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
    expect(retrievalsStarted).toBe(2);
    await until(() => toolRequests.length === 2);
    const blocked = (await rows()).slice(before);
    expect(
      blocked.filter(
        (row: UsageRecord) => row.kind === 'task' || row.kind === 'tool.call',
      ),
    ).toHaveLength(0);
    release();
    const handles = await Promise.all(
      cases.map((entry: (typeof cases)[number]) =>
        dialogueFor(entry.userId, entry.sessionId, 'TEST'),
      ),
    );
    await until(() =>
      handles.every((handle: (typeof handles)[number]) => {
        const tasks = handle.session.snapshot().tasks;
        return (
          tasks.length === 1 &&
          tasks.every((task: (typeof tasks)[number]) => task.state === 'done')
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
        (row: UsageRecord) =>
          row.context.sessionId === entry.sessionId ||
          row.context.userId === entry.userId ||
          row.context.requestId === requestId,
      );
      expect(
        own.some(
          (row: UsageRecord) =>
            row.kind === 'embedding.call' &&
            row.context.component === 'collection-retrieval',
        ),
      ).toBe(true);
      expect(
        own.some(
          (row: UsageRecord) =>
            row.kind === 'llm.call' && row.context.role === 'classifier',
        ),
      ).toBe(true);
      expect(
        own.some(
          (row: UsageRecord) =>
            row.kind === 'llm.call' &&
            row.context.role === 'tool-loop' &&
            !row.context.taskId,
        ),
      ).toBe(true);
      expect(
        own.filter((row: UsageRecord) => row.kind === 'task'),
      ).toHaveLength(1);
      expect(
        own.filter(
          (row: UsageRecord) => row.kind === 'tool.call' && !row.embedded,
        ),
      ).toHaveLength(1);
      for (const row of own) {
        expect(row.context).toMatchObject({
          sessionId: entry.sessionId,
          userId: entry.userId,
          requestId,
        });
        for (const other of cases.filter(
          (candidate: (typeof cases)[number]) => candidate !== entry,
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
          (entry: (typeof cases)[number]) =>
            row.context.sessionId === entry.sessionId,
        ),
      ).toBe(true);
    }
  } finally {
    release();
    releaseFollowup();
    releaseRetrieval();
    server.closeAllConnections();
    await new Promise<void>((resolve: () => void) =>
      server.close(() => resolve()),
    );
    for (const entry of cases)
      await closeDialogue(entry.userId, entry.sessionId, 'explicit');
    setLongSessionsForTest(undefined);
  }
});
