import type { ILlm } from '@mcp-abap-adt/llm-agent';
import type { AgentConfig } from '../../srv/agent-config';
import {
  buildPlannerAgent,
  getSmartAgent,
  HUB_DIALOGUE_PLANNER_SYSTEM,
  initProviders,
  releasePlannerAgent,
} from '../../srv/agent-manager';
import { makeHubLlm } from '../../srv/lib/llm-factory';
import { startProviders } from '../../srv/lib/providers';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';

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
