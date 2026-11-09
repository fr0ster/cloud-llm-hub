import type { ILlm, IMcpClient } from '@mcp-abap-adt/llm-agent';
import {
  PlannerToolsClient,
  runInPlannerScope,
  SessionManager,
  SmartAgentBuilder,
  SmartAgentSubAgent,
  TaskBoard,
} from '@mcp-abap-adt/llm-agent-libs';
import { closeDialogue } from '../../srv/lib/dialogue-sessions';
import {
  clearExecutionLimits,
  currentLimit,
  currentSessionLimit,
  effectiveExecutionLimits,
  getExecutionLimits,
  historyBudgetOptions,
  runLimitOptions,
  setExecutionLimits,
  validateExecutionLimits,
  withExecutionLimits,
} from '../../srv/lib/execution-limits';
import { withToolResultCap } from '../../srv/lib/tool-result-cap';

const client: IMcpClient = {
  listTools: async () => ({
    ok: true,
    value: [
      {
        name: 'tick',
        description: 'Advance',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }),
  callTool: async () => ({ ok: true, value: { content: 'x'.repeat(1000) } }),
};

async function loopingRun(
  maxIterations: number | 'off',
  toolRounds = 12,
  maxToolCalls: number | 'off' = 'off',
) {
  return withExecutionLimits(
    { executor: { maxIterations, maxToolCalls } },
    async () => {
      let rounds = 0;
      const chat: ILlm['chat'] = async () => {
        rounds++;
        return {
          ok: true,
          value:
            rounds <= toolRounds
              ? {
                  content: '',
                  toolCalls: [
                    { id: String(rounds), name: 'tick', arguments: {} },
                  ],
                  finishReason: 'tool_calls',
                }
              : { content: 'done', finishReason: 'stop' },
        };
      };
      const llm: ILlm = {
        chat,
        streamChat: async function* (messages, tools, opts) {
          yield await chat(messages, tools, opts);
        },
      };
      const handle = await new SmartAgentBuilder({
        skipModelValidation: true,
        agent: {
          ...runLimitOptions('executor', { maxIterations: 10 }),
          classificationEnabled: false,
          ragTranslateEnabled: false,
        },
      })
        .withMainLlm(llm)
        .withMcpClients([client])
        .withClassification(false)
        .withMode('hard')
        .build();
      const result = await handle.agent.process('Run the requested rounds');
      return { rounds, result };
    },
  );
}

test('maxIterations off lets an executor run past 10 iterations', async () => {
  const { rounds, result } = await loopingRun('off');
  expect(rounds).toBe(13);
  expect(result.ok && result.value.content).toBe('done');
});
test('maxIterations 3 ends the executor run after 3 iterations with the existing budget-exhausted result', async () => {
  const { rounds, result } = await loopingRun(3);
  expect(rounds).toBe(3);
  expect(result.ok && result.value.content).toBe('');
  expect(result.ok && result.value.toolCallCount).toBe(3);
});
test('checker and executor limits are independent', async () => {
  await Promise.all(
    [3, 7].map((maxIterations) =>
      withExecutionLimits(
        { executor: { maxIterations }, checker: { maxIterations: 2 } },
        async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(currentLimit('executor', 'maxIterations')).toBe(maxIterations);
          expect(currentLimit('checker', 'maxIterations')).toBe(2);
        },
      ),
    ),
  );
  expect(currentLimit('executor', 'maxIterations')).toBeUndefined();
});
test('toolResultMaxChars off returns the full tool result; a number caps it', async () => {
  const shared = withToolResultCap(client, 100);
  for (const limit of ['off', 20] as const)
    await withExecutionLimits({ toolResultMaxChars: limit }, async () => {
      const result = await shared.callTool('tick', {});
      expect(result.ok && result.value.content).toEqual(
        limit === 'off'
          ? 'x'.repeat(1000)
          : expect.stringContaining('20 of 1000'),
      );
    });
});
test('historyTokenBudget off builds the SessionManager without a token budget', async () => {
  await withExecutionLimits({ historyTokenBudget: 'off' }, async () => {
    const { buildLlmOnlyAgent, initProviders, closeSmartAgent } = await import(
      '../../srv/agent-manager'
    );
    const { getAgentConfig, clearAgentConfig } = await import(
      '../../srv/agent-config'
    );
    const { startProviders } = await import('../../srv/lib/providers');
    const saved = { ...process.env };
    process.env.LLM_AGENT_PROVIDER = 'openai';
    process.env.LLM_AGENT_MODEL = 'test';
    clearAgentConfig();
    const config = getAgentConfig();
    initProviders(await startProviders(config));
    const manager = jest.spyOn(
      SmartAgentBuilder.prototype,
      'withSessionManager',
    );
    const build = jest.spyOn(SmartAgentBuilder.prototype, 'build');
    try {
      const handle = await buildLlmOnlyAgent(config, 'waiting');
      expect(handle.agent['deps'].sessionManager).toBeUndefined();
      expect(build).toHaveBeenCalled();
      expect(manager).not.toHaveBeenCalled();
    } finally {
      manager.mockRestore();
      build.mockRestore();
      await closeSmartAgent();
      process.env = saved;
      clearAgentConfig();
    }
  });
  const options = historyBudgetOptions();
  if (!options) throw new Error('Expected the default history budget');
  const manager = new SessionManager(options);
  manager.addTokens(8000);
  expect(manager.isOverBudget()).toBe(true);
});
test('planStepBudget is refused with the stage 2 reason while libraryLimitsEnabled is false', () => {
  expect(
    validateExecutionLimits(
      { planStepBudget: 'off' },
      { libraryLimitsEnabled: false },
    ),
  ).toEqual({
    ok: false,
    error: {
      field: 'planStepBudget',
      reason:
        'run and plan-step budgets arrive with llm-agent library limits (stage 2)',
    },
  });
});
test('limits are isolated per session and cleared on session close', async () => {
  setExecutionLimits('u1', 'k1', { executor: { maxIterations: 3 } });
  expect(getExecutionLimits('u1', 'k2')).toEqual({});
  expect(getExecutionLimits('u2', 'k1')).toEqual({});
  await closeDialogue('u1', 'k1', 'shutdown', false);
  expect(getExecutionLimits('u1', 'k1')).toEqual({});
});
test('an absent field keeps the configured value; effectiveExecutionLimits reports source config', () => {
  const saved = process.env.LLM_AGENT_MAX_ITERATIONS;
  process.env.LLM_AGENT_MAX_ITERATIONS = '17';
  try {
    expect(
      effectiveExecutionLimits('u', 'k')['executor.maxIterations'],
    ).toEqual({ value: 17, source: 'config' });
  } finally {
    if (saved === undefined) delete process.env.LLM_AGENT_MAX_ITERATIONS;
    else process.env.LLM_AGENT_MAX_ITERATIONS = saved;
  }
});
test('a stopped task ends a run whose maxIterations is off', async () => {
  await withExecutionLimits(
    { executor: { maxIterations: 'off', maxToolCalls: 'off' } },
    async () => {
      let rounds = 0;
      let board: TaskBoard;
      const chat: ILlm['chat'] = async () => {
        rounds++;
        if (rounds === 12) {
          const stopped = await runInPlannerScope(
            { board, getPlan: () => undefined, setPlan() {} },
            () =>
              new PlannerToolsClient().callTool('stop_task', {
                task_id: board.list()[0].id,
              }),
          );
          expect(stopped.ok).toBe(true);
        }
        return {
          ok: true,
          value: {
            content: '',
            toolCalls: [{ id: String(rounds), name: 'tick', arguments: {} }],
            finishReason: 'tool_calls',
          },
        };
      };
      const llm: ILlm = {
        chat,
        streamChat: async function* (messages, tools, opts) {
          yield await chat(messages, tools, opts);
        },
      };
      const handle = await new SmartAgentBuilder({
        skipModelValidation: true,
        agent: {
          ...runLimitOptions('executor', { maxIterations: 10 }),
          classificationEnabled: false,
          ragTranslateEnabled: false,
        },
      })
        .withMainLlm(llm)
        .withMcpClients([client])
        .withClassification(false)
        .withMode('hard')
        .build();
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      board = new TaskBoard({
        workers: new Map([
          ['executor', new SmartAgentSubAgent('executor', handle.agent)],
        ]),
        stallNoticeMs: undefined,
        scheduleTimer: () => () => {},
        onEvent: (event) => {
          if (
            event.task.state === 'stopped' ||
            event.task.state === 'failed' ||
            event.task.state === 'done'
          )
            finish();
        },
      });
      const started = board.start({
        worker: 'executor',
        goal: 'Loop until stopped',
      });
      expect(started.ok).toBe(true);
      await finished;
      await board.stopAll();
      expect(rounds).toBe(12);
      expect(board.list()[0].state).toBe('stopped');
    },
  );
});

test('maxToolCalls off removes the library default; a number exhausts the budget', async () => {
  const unlimited = await loopingRun('off', 35);
  expect(unlimited.rounds).toBe(36);
  expect(unlimited.result.ok && unlimited.result.value.content).toBe('done');
  const limited = await loopingRun('off', 12, 3);
  expect(limited.result).toMatchObject({
    ok: true,
    value: { budgetExhausted: true, maxToolCalls: 3, toolCallCount: 3 },
  });
});

test('validation names invalid and unknown fields without changing stored limits', () => {
  setExecutionLimits('validate', 'key', { coordinator: { maxIterations: 4 } });
  for (const input of [
    { executor: { maxIterations: 0 } },
    { executor: { maxToolCalls: -1 } },
    { historyTokenBudget: 1.5 },
    { planner: { maxIterations: 2 } },
  ]) {
    const result = validateExecutionLimits(input, {
      libraryLimitsEnabled: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).not.toBe('');
    expect(getExecutionLimits('validate', 'key')).toEqual({
      coordinator: { maxIterations: 4 },
    });
  }
  clearExecutionLimits('validate', 'key');
});

test('store and active scopes snapshot limits and restore nested scopes', async () => {
  const limits = { executor: { maxIterations: 4 } };
  setExecutionLimits('snapshot', 'key', limits);
  limits.executor.maxIterations = 9;
  const saved = getExecutionLimits('snapshot', 'key');
  expect(saved.executor?.maxIterations).toBe(4);
  await withExecutionLimits(saved, async () => {
    if (saved.executor) saved.executor.maxIterations = 10;
    expect(currentLimit('executor', 'maxIterations')).toBe(4);
    await withExecutionLimits({}, async () =>
      expect(currentLimit('executor', 'maxIterations')).toBeUndefined(),
    );
    expect(currentLimit('executor', 'maxIterations')).toBe(4);
  });
  expect(getExecutionLimits('snapshot', 'key').executor?.maxIterations).toBe(4);
  clearExecutionLimits('snapshot', 'key');
});
