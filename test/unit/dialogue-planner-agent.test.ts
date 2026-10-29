import { type ILlm, InMemoryRag } from '@mcp-abap-adt/llm-agent';
import {
  DIALOGUE_PLANNER_SYSTEM,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent-libs';
import type { AgentConfig } from '../../srv/agent-config';
import * as agentConfig from '../../srv/agent-config';
import {
  buildAgentForDestination,
  buildExecutorWorker,
  buildPlannerAgent,
  CHECKER_DESCRIPTION,
  EXECUTOR_DESCRIPTION,
  ExpositionFilteringRag,
  getCurrentPlannerModel,
  getSmartAgent,
  HUB_DIALOGUE_PLANNER_SYSTEM,
  HUB_DIALOGUE_STORAGE_RULES,
  initProviders,
  releasePlannerAgent,
} from '../../srv/agent-manager';
import {
  DialogueRagMcpClient,
  runWithDialogueRagTools,
} from '../../srv/lib/dialogue-rag-tools';
import { makeHubLlm } from '../../srv/lib/llm-factory';
import { startProviders } from '../../srv/lib/providers';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';
import { CollectionRegistry } from '../../srv/rag-collections';
import { runWithSessionId } from '../../srv/request-session';

test('planner supports planner and checker verification', () => {
  for (const rule of HUB_DIALOGUE_STORAGE_RULES.split('\n')) {
    expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(rule);
  }
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
    'The checker can read stored hub RAG records with rag_list when a check of stored results is planned.',
  );
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain('For check.by planner');
});

test('planner prepares a complete brief and asks before narrowing scope', () => {
  for (const rule of [
    'Every delegate_task is a brief: goal says what to achieve in one or two sentences',
    'what not to touch, where results are stored, priority order, scope',
    'ids, names, values',
    'the done criterion, and what to return',
    'The worker sees only the brief and its own tool results, not the dialogue',
    'Pass history only when',
    "Keep each step within one worker run's budget; split a step that does not fit.",
    'Skip a step, drop items, sample',
    'update_plan with status waiting_user and a question',
    'keep waiting until the user answers, never decide it yourself',
    'When the plan checks stored batch results',
    'as the requested storage format defines them',
    'fewer stored records fails the step',
    'when a check of stored results is planned',
    'When the request or a skill asks to keep results, store them where it says',
    'if the target or scope is unclear, ask the user',
    "without a named target means the hub's RAG collection (rag_add)",
  ])
    expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(rule);
  for (const rule of [
    'when a step lists many items, split it',
    'Prefer one item per step',
    'then one step per item; finally',
    "When a step's outcome is stored, the check step reads it back",
    'scratch data may use scope session',
    "When the user's wording is ambiguous about where or how to store",
  ])
    expect(HUB_DIALOGUE_PLANNER_SYSTEM).not.toContain(rule);
});

test('planner uses the structured board and library delegation contract', () => {
  for (const rule of [
    '[plan] is the task board truth',
    'Always delegate_task with step_id',
    'Use get_plan(',
    'Set status waiting_user with a nonempty question',
    'dependsOn for prerequisites',
  ])
    expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(rule);
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).not.toContain(
    'Start every turn by calling list_tasks',
  );
  expect(CHECKER_DESCRIPTION).toContain('"verdict":"pass"|"fail"');
});

test('shared worker descriptions do not advertise dialogue RAG tools', () => {
  expect(EXECUTOR_DESCRIPTION).not.toContain('rag_');
  expect(CHECKER_DESCRIPTION).not.toContain('rag_');
});

jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: jest.fn(),
}));
const config: AgentConfig = {
  llm: {
    provider: 'openai',
    model: 'test',
    classifierModel: 'test',
    temperature: 0,
    maxTokens: 2000,
    apiKey: 'fake',
    baseUrl: 'http://localhost',
    whenThrottled: new WaitIfShortEnough(20_000),
  },
  mcp: { destination: '', systemDestinations: {} },
  agent: {
    dialogue: {
      executors: 7,
      executorPool: 6,
      maxTasks: 50,
      maxCorrections: 2,
      followMaxMs: 1_800_000,
    },
    chatCoordinator: 'adaptive',
    mode: 'smart',
    maxIterations: 10,
    ragType: 'in-memory',
    ragQueryK: 5,
    skillRagK: 0,
    allowLlmOnlyFallback: false,
  },
  rag: {
    embedder: null,
    backends: {
      tools: 'in-memory',
      session: 'in-memory',
      persistent: 'in-memory',
    },
  },
  destinations: { source: 'btp' },
};

function llm(model: string) {
  const tools: string[][] = [];
  const messages: string[] = [];
  const agent: ILlm = {
    model,
    chat: async (_messages, opts) => {
      tools.push((opts ?? []).map((t) => t.name));
      messages.push(_messages.map((m) => m.content).join('\n'));
      return { ok: true, value: { content: model, finishReason: 'stop' } };
    },
    streamChat: async function* (_messages, opts) {
      tools.push((opts ?? []).map((t) => t.name));
      messages.push(_messages.map((m) => m.content).join('\n'));
      yield {
        ok: true as const,
        value: { content: model, finishReason: 'stop' as const },
      };
    },
  };
  return { agent, tools, messages };
}
test('hard planner sends all eight control tools, hub prompt, and follows getSmartAgent model hot-swap', async () => {
  const first = llm('first');
  const second = llm('second');
  jest.mocked(makeHubLlm).mockResolvedValue(first.agent);
  initProviders(await startProviders(config));
  const planner = await buildPlannerAgent(config);
  try {
    const result = await planner.process([{ role: 'user', content: 'hello' }]);
    expect(result.ok && result.value.content).toBe('first');
    expect(first.tools.flat().sort()).toEqual(
      [
        'delegate_task',
        'get_task',
        'get_plan',
        'list_tasks',
        'stop_task',
        'update_plan',
        'search_knowledge',
        'new_request',
      ].sort(),
    );
    expect(first.messages.join('\n')).toContain(HUB_DIALOGUE_PLANNER_SYSTEM);
    // Hub notes are not the user, and the library's fixed default is replaced.
    expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
      'notes come from the hub, not from the user',
    );
    expect(HUB_DIALOGUE_PLANNER_SYSTEM).not.toContain('(default: 3');
    expect(first.messages.join('\n')).toContain(
      'At most 7 tasks may run at the same time in this session; run fewer when steps are not independent.',
    );
    jest.mocked(makeHubLlm).mockResolvedValue(second.agent);
    await getSmartAgent('second');
    const swapped = await planner.process([{ role: 'user', content: 'again' }]);
    expect(swapped.ok && swapped.value.content).toBe('second');
    expect(second.tools.flat()).toContain('delegate_task');
    expect(getCurrentPlannerModel()).toBe('second');
  } finally {
    releasePlannerAgent(planner);
  }
});

test('dialogue tool-loop offers hub storage to executor and only readback to checker', async () => {
  const model = llm('worker');
  jest.mocked(makeHubLlm).mockResolvedValue(model.agent);
  const dialogueConfig: AgentConfig = {
    ...config,
    agent: { ...config.agent, chatCoordinator: 'dialogue', skillRagK: 0 },
  };
  initProviders(await startProviders(dialogueConfig));
  await getSmartAgent('worker');
  const handle = await buildAgentForDestination(
    {
      listTools: async () => ({ ok: true, value: [] }),
      callTool: jest.fn(),
    } as never,
    new ExpositionFilteringRag(new InMemoryRag()),
    dialogueConfig,
  );
  const workers = (
    handle as typeof handle & {
      workers: ReadonlyMap<string, import('@mcp-abap-adt/llm-agent').ISubAgent>;
    }
  ).workers;
  for (const name of ['executor', 'checker']) {
    model.tools.length = 0;
    await runWithSessionId(
      'dialogue-1',
      () =>
        runWithDialogueRagTools(() =>
          workers.get(name)?.run({
            task: 'Read stored analysis from the hub collection',
            history: [],
          }),
        ),
      [],
      'alice',
    );
    expect([...new Set(model.tools.flat())].sort()).toEqual(
      name === 'executor'
        ? ['rag_add', 'rag_correct', 'rag_deprecate', 'rag_list']
        : ['rag_list'],
    );
  }
  expect(model.messages.join('\n')).toContain(HUB_DIALOGUE_STORAGE_RULES);
  expect(model.messages.join('\n')).toContain(
    'If a step fails twice the same way, stop and report to the planner instead of retrying.',
  );
});

test('planner defines independently checkable results and paged enumeration', () => {
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
    'A step states the result it must produce, not how to produce it; the worker chooses the tools and the way.',
  );
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
    'Make each step a result one worker run can deliver and that can be checked on its own.',
  );
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
    'To process all items of a kind that do not fit one worker run: first one step that returns only their identifiers, page by page (for example 20 at a time); then steps per item or per batch that fit a worker run; plan the check the risk needs.',
  );
});

test.each(['adaptive', 'dialogue'] as const)(
  '%s tool loop sends capped text to the model',
  async (coordinator) => {
    const seen: string[] = [];
    const name = coordinator === 'dialogue' ? 'rag_list' : 'GetTable';
    const modelName = `cap-${coordinator}`;
    const response: ILlm['chat'] = async (messages, tools) => {
      const results = messages.filter((m) => m.role === 'tool');
      if (results.length) {
        seen.push(...results.map((m) => String(m.content)));
        return { ok: true, value: { content: 'done', finishReason: 'stop' } };
      }
      if (tools?.some((t) => t.name === name))
        return {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'read',
                name,
                arguments: { collection: 'results', id: 'large' },
              },
            ],
            finishReason: 'tool_calls',
          },
        };
      return {
        ok: true,
        value: { content: 'select read tool', finishReason: 'stop' },
      };
    };
    const model: ILlm = {
      model: modelName,
      chat: response,
      streamChat: async function* (messages, tools, options) {
        yield await response(messages, tools, options);
      },
    };
    jest.mocked(makeHubLlm).mockResolvedValue(model);
    const cappedConfig: AgentConfig = {
      ...config,
      agent: {
        ...config.agent,
        chatCoordinator: coordinator,
        mode: 'hard',
        toolResultMaxChars: 100,
      },
    };
    initProviders(await startProviders(cappedConfig));
    await getSmartAgent(modelName);
    const registry = new CollectionRegistry();
    const inner = {
      listTools: async () => ({
        ok: true as const,
        value: [
          { name: 'GetTable', description: 'Read table', inputSchema: {} },
        ],
      }),
      callTool: async () => ({
        ok: true as const,
        value: { content: 'x'.repeat(1000), isError: false },
      }),
    };
    const client =
      coordinator === 'dialogue'
        ? new RecordingMcpClient(
            new DialogueRagMcpClient(inner, () => registry),
            undefined,
            100,
          )
        : inner;
    const worker = await buildExecutorWorker(
      client,
      new ExpositionFilteringRag(new InMemoryRag()),
      cappedConfig,
    );
    await runWithSessionId(
      'cap-test',
      () =>
        runWithDialogueRagTools(async () => {
          if (coordinator === 'dialogue')
            await client.callTool('rag_add', {
              collection: 'results',
              id: 'large',
              text: 'x'.repeat(1000),
            });
          await worker.run({
            task: `Use ${name} to read the result`,
            history: [],
          });
        }),
      [],
      'alice',
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join('\n')).toContain('[result truncated: 100 of');
    expect(seen.join('\n')).not.toContain('x'.repeat(101));
  },
);

test.each([undefined, 7])(
  'planner preserves or applies tool-call budget %s',
  async (maxToolCalls) => {
    const model = llm(`budget-${maxToolCalls}`);
    jest.mocked(makeHubLlm).mockResolvedValue(model.agent);
    const budgetConfig = {
      ...config,
      agent: { ...config.agent, maxToolCalls },
    };
    initProviders(await startProviders(budgetConfig));
    const apply = jest.spyOn(SmartAgentBuilder.prototype, 'withMaxToolCalls');
    const planner = await buildPlannerAgent(budgetConfig);
    try {
      if (maxToolCalls === undefined) expect(apply).not.toHaveBeenCalled();
      else expect(apply).toHaveBeenCalledWith(maxToolCalls);
    } finally {
      releasePlannerAgent(planner);
      apply.mockRestore();
    }
  },
);

test('planner prompt allows skipping only with user agreement', () => {
  for (const prompt of [DIALOGUE_PLANNER_SYSTEM, HUB_DIALOGUE_PLANNER_SYSTEM]) {
    expect(prompt).not.toContain('skip them with a reason');
    expect(prompt).not.toContain(
      'Use skipped with a note explaining why instead of silently dropping steps.',
    );
    expect(prompt).toContain(
      'Skipping, removing pending steps or reducing declared items requires a user response',
    );
  }
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
    "Skip a step, drop items, sample or otherwise narrow the user's scope only after asking the user",
  );
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
    'A [check] note is not user agreement.',
  );
});

test('independent planner model survives request hot-swap and rebuilds', async () => {
  const plannerModel = llm('independent-planner');
  const mainModel = llm('independent-main');
  const independentConfig: AgentConfig = {
    ...config,
    llm: { ...config.llm, plannerModel: 'independent-planner' },
  };
  const configSpy = jest
    .spyOn(agentConfig, 'getAgentConfig')
    .mockReturnValue(independentConfig);
  jest.mocked(makeHubLlm).mockResolvedValue(plannerModel.agent);
  const planner = await buildPlannerAgent(independentConfig);
  let rebuilt: Awaited<ReturnType<typeof buildPlannerAgent>> | undefined;
  try {
    expect(makeHubLlm).toHaveBeenLastCalledWith(
      {
        contextCapture: config.llm.contextCapture,
        provider: config.llm.provider,
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl,
        component: 'chat',
        model: 'independent-planner',
        maxTokens: config.llm.maxTokens,
        resourceGroup: config.llm.resourceGroup,
        whenThrottled: config.llm.whenThrottled,
      },
      config.llm.temperature,
    );
    expect(getCurrentPlannerModel()).toBe('independent-planner');
    const first = await planner.process([{ role: 'user', content: 'hello' }]);
    expect(first.ok && first.value.content).toBe('independent-planner');

    jest.mocked(makeHubLlm).mockResolvedValue(mainModel.agent);
    await getSmartAgent('independent-main');
    expect(makeHubLlm).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'independent-main' }),
      config.llm.temperature,
    );
    expect(getCurrentPlannerModel()).toBe('independent-planner');
    const afterSwap = await planner.process([
      { role: 'user', content: 'again' },
    ]);
    expect(afterSwap.ok && afterSwap.value.content).toBe('independent-planner');

    const calls = jest.mocked(makeHubLlm).mock.calls.length;
    rebuilt = await buildPlannerAgent(independentConfig);
    expect(jest.mocked(makeHubLlm).mock.calls).toHaveLength(calls);
    const afterRebuild = await rebuilt.process([
      { role: 'user', content: 'hello' },
    ]);
    expect(afterRebuild.ok && afterRebuild.value.content).toBe(
      'independent-planner',
    );
  } finally {
    releasePlannerAgent(planner);
    if (rebuilt) releasePlannerAgent(rebuilt);
    configSpy.mockRestore();
  }
});
