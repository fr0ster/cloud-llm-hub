import { type ILlm, InMemoryRag } from '@mcp-abap-adt/llm-agent';
import type { AgentConfig } from '../../srv/agent-config';
import {
  buildAgentForDestination,
  buildPlannerAgent,
  CHECKER_DESCRIPTION,
  EXECUTOR_DESCRIPTION,
  ExpositionFilteringRag,
  getSmartAgent,
  HUB_DIALOGUE_PLANNER_SYSTEM,
  HUB_DIALOGUE_STORAGE_RULES,
  initProviders,
  releasePlannerAgent,
} from '../../srv/agent-manager';
import { runWithDialogueRagTools } from '../../srv/lib/dialogue-rag-tools';
import { makeHubLlm } from '../../srv/lib/llm-factory';
import { startProviders } from '../../srv/lib/providers';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';
import { runWithSessionId } from '../../srv/request-session';

test('verification always belongs to the checker', () => {
  for (const rule of HUB_DIALOGUE_STORAGE_RULES.split('\n')) {
    expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(rule);
  }
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
    'The checker can read stored hub RAG records with rag_list; use it to verify stored results.',
  );
  expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(
    'Delegate every verification or check step to the checker worker, never to the executor; the checker only reads and checks.',
  );
});

test('planner prepares a complete brief and discloses narrowed scope', () => {
  for (const rule of [
    'Every delegate_task is a brief: goal says what to achieve in one or two sentences',
    'what not to touch, where results are stored, priority order, scope',
    'ids, names, values',
    'the done criterion, and what to return',
    'The worker sees only the brief and its own tool results, not the dialogue',
    'Pass history only when',
    'when a step lists many items, split it',
    'sampling, a subset, a different order',
    'tell the user in your reply',
  ])
    expect(HUB_DIALOGUE_PLANNER_SYSTEM).toContain(rule);
});

test('planner grounds task reports in tool results and delegates the next step immediately', () => {
  for (const rule of [
    'Start every turn by calling list_tasks; report tasks only as list_tasks returns them.',
    'A task exists only after delegate_task has returned its id; never name a task id that list_tasks or delegate_task did not return, and never say that work started unless delegate_task returned its id in this turn.',
    'When the plan has a next step and no task is running, delegate it in this same turn; never end a turn with a promise to start work later.',
  ])
    expect(HUB_DIALOGUE_PLANNER_SYSTEM.split('\n')).toContain(rule);
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
    dialogue: { executors: 7, executorPool: 6, maxTasks: 50 },
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
test('hard planner sends all five control tools, hub prompt, and follows getSmartAgent model hot-swap', async () => {
  const first = llm('first');
  const second = llm('second');
  jest.mocked(makeHubLlm).mockResolvedValue(first.agent);
  initProviders(await startProviders(config));
  const planner = await buildPlannerAgent(config);
  try {
    const result = await planner.process([{ role: 'user', content: 'hello' }]);
    expect(result.ok && result.value.content).toBe('first');
    expect(first.tools.flat()).toEqual(
      expect.arrayContaining([
        'delegate_task',
        'get_task',
        'list_tasks',
        'stop_task',
        'update_plan',
      ]),
    );
    expect(new Set(first.tools.flat()).size).toBe(5);
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
