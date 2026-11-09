import { loadSessionConfig } from '../../srv/lib/session-config';

describe('loadSessionConfig', () => {
  it('defaults', () => {
    expect(loadSessionConfig({}, 'vector')).toEqual({
      ttlMs: 3600000,
      maxSessions: 50,
      maxPerUser: 5,
      queueLength: 2,
      store: 'none',
      storePath: '.data/sessions.db',
      plainApi: false,
      plainMcp: false,
    });
  });

  it('store follows a persistent session backend', () => {
    expect(loadSessionConfig({}, 'hana-vector').store).toBe('hana-vector');
    expect(loadSessionConfig({}, 'pg-vector').store).toBe('pg-vector');
    expect(loadSessionConfig({}, 'qdrant').store).toBe('none');
  });

  it('explicit store wins', () => {
    expect(
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: 'sqlite' }, 'hana-vector')
        .store,
    ).toBe('sqlite');
  });

  it('an empty store value reads as not set', () => {
    expect(
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: '' }, 'pg-vector').store,
    ).toBe('pg-vector');
  });

  it('malformed numbers throw', () => {
    expect(() =>
      loadSessionConfig({ LLM_AGENT_SESSION_TTL_MS: '10m' }, 'vector'),
    ).toThrow(/LLM_AGENT_SESSION_TTL_MS/);
    expect(() =>
      loadSessionConfig({ LLM_AGENT_MAX_SESSIONS_PER_USER: '0' }, 'vector'),
    ).toThrow(/LLM_AGENT_MAX_SESSIONS_PER_USER/);
    expect(() =>
      loadSessionConfig({ LLM_AGENT_MAX_SESSIONS: '1e3' }, 'vector'),
    ).toThrow(/LLM_AGENT_MAX_SESSIONS/);
  });

  it('reads set numbers', () => {
    const cfg = loadSessionConfig(
      {
        LLM_AGENT_SESSION_TTL_MS: '60000',
        LLM_AGENT_MAX_SESSIONS: '10',
        LLM_AGENT_MAX_SESSIONS_PER_USER: '2',
        LLM_AGENT_SESSION_QUEUE: '7',
        LLM_AGENT_SESSION_STORE_PATH: '/tmp/s.db',
      },
      'vector',
    );
    expect(cfg).toMatchObject({
      ttlMs: 60000,
      maxSessions: 10,
      maxPerUser: 2,
      queueLength: 7,
      storePath: '/tmp/s.db',
    });
  });

  it('per-user cap above total throws', () => {
    expect(() =>
      loadSessionConfig(
        { LLM_AGENT_MAX_SESSIONS: '2', LLM_AGENT_MAX_SESSIONS_PER_USER: '3' },
        'vector',
      ),
    ).toThrow(/LLM_AGENT_MAX_SESSIONS_PER_USER/);
  });

  it('unknown store throws', () => {
    expect(() =>
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: 'qdrant' }, 'vector'),
    ).toThrow(/LLM_AGENT_SESSION_STORE/);
  });

  it('plain switches', () => {
    expect(
      loadSessionConfig(
        { LLM_AGENT_PLAIN_API: 'true', LLM_AGENT_PLAIN_MCP: 'true' },
        'vector',
      ),
    ).toMatchObject({ plainApi: true, plainMcp: true });
    expect(
      loadSessionConfig(
        { LLM_AGENT_PLAIN_API: '1', LLM_AGENT_PLAIN_MCP: 'TRUE' },
        'vector',
      ),
    ).toMatchObject({ plainApi: false, plainMcp: false });
  });
});

import { loadAgentConfig } from '../../srv/agent-config';
import {
  effectiveExecutionLimits,
  historyBudgetOptions,
  runLimitOptions,
  withExecutionLimits,
} from '../../srv/lib/execution-limits';
import {
  currentRoleModel,
  effectiveRoleModels,
  withRoleModels,
} from '../../srv/lib/role-models-scope';

describe('deploy configuration parity', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = {
      LLM_AGENT_MODEL: 'main',
      LLM_AGENT_MODELS: 'main,worker,session',
    };
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('LLM_AGENT_EXECUTOR_MODEL overrides the delegate_task model for every session', async () => {
    process.env.LLM_AGENT_EXECUTOR_MODEL = 'worker';
    expect(loadAgentConfig().llm).toMatchObject({ executorModel: 'worker' });
    for (const key of ['a', 'b']) {
      await withRoleModels({}, async () =>
        expect(currentRoleModel('executor') ?? 'delegate').toBe('worker'),
      );
      expect(effectiveRoleModels('user', key).executor).toEqual({
        model: 'worker',
        source: 'config',
      });
    }
  });
  it('a session executor setting overrides LLM_AGENT_EXECUTOR_MODEL', async () => {
    process.env.LLM_AGENT_EXECUTOR_MODEL = 'worker';
    await withRoleModels({ executor: { model: 'session' } }, async () =>
      expect(currentRoleModel('executor')).toBe('session'),
    );
  });
  it('LLM_AGENT_CHECKER_MODEL outside the allowlist fails startup naming the variable', () => {
    process.env.LLM_AGENT_CHECKER_MODEL = 'invalid';
    expect(() => loadAgentConfig()).toThrow(/LLM_AGENT_CHECKER_MODEL/);
  });
  it('LLM_AGENT_EXECUTOR_MAX_ITERATIONS=off gives the executor no iteration limit; the coordinator keeps LLM_AGENT_MAX_ITERATIONS', () => {
    process.env.LLM_AGENT_MAX_ITERATIONS = '7';
    process.env.LLM_AGENT_EXECUTOR_MAX_ITERATIONS = 'off';
    expect(loadAgentConfig()).toHaveProperty(
      'limits.executor.maxIterations',
      'off',
    );
    withExecutionLimits({}, () => {
      expect(
        runLimitOptions('executor', { maxIterations: 10 }).maxIterations,
      ).toBe(Infinity);
      expect(
        runLimitOptions('coordinator', { maxIterations: 10 }).maxIterations,
      ).toBe(7);
    });
    expect(
      effectiveExecutionLimits('user', 'key')['executor.maxIterations'],
    ).toEqual({ value: 'off', source: 'config' });
  });
  it('LLM_AGENT_HISTORY_TOKEN_BUDGET unset keeps 8000', () => {
    loadAgentConfig();
    expect(historyBudgetOptions()).toEqual({ tokenBudget: 8000 });
  });
  it('no new variable is required: only LLM_AGENT_MODEL set still starts', () => {
    process.env = { LLM_AGENT_MODEL: 'main' };
    expect(loadAgentConfig().llm.model).toBe('main');
  });
  it.each([
    'LLM_AGENT_MAX_ITERATIONS',
    'LLM_AGENT_MAX_TOOL_CALLS',
    'LLM_AGENT_TOOL_RESULT_MAX_CHARS',
    'LLM_AGENT_HISTORY_TOKEN_BUDGET',
    ...['COORDINATOR', 'EXECUTOR', 'CHECKER'].flatMap((role) => [
      `LLM_AGENT_${role}_MAX_ITERATIONS`,
      `LLM_AGENT_${role}_MAX_TOOL_CALLS`,
    ]),
  ])('%s accepts off and rejects malformed limits at startup', (name) => {
    process.env[name] = 'off';
    expect(() => loadAgentConfig()).not.toThrow();
    for (const value of [
      '0x10',
      '1.5',
      '-1',
      'NaN',
      '9007199254740992',
      '12oops',
    ]) {
      process.env[name] = value;
      expect(() => loadAgentConfig()).toThrow(name);
    }
  });
  it('checker configuration overrides delegation and session settings override configuration', async () => {
    process.env.LLM_AGENT_CHECKER_MODEL = 'worker';
    expect(loadAgentConfig().llm.checkerModel).toBe('worker');
    await withRoleModels({}, async () =>
      expect(currentRoleModel('checker')).toBe('worker'),
    );
    await withRoleModels({ checker: { model: 'session' } }, async () =>
      expect(currentRoleModel('checker')).toBe('session'),
    );
    expect(effectiveRoleModels('user', 'key').checker).toEqual({
      model: 'worker',
      source: 'config',
    });
    process.env.LLM_AGENT_EXECUTOR_MODEL = 'invalid';
    expect(() => loadAgentConfig()).toThrow('LLM_AGENT_EXECUTOR_MODEL');
  });
  it('global off limits reach every role without restoring library limits', () => {
    process.env.LLM_AGENT_MAX_ITERATIONS = 'off';
    process.env.LLM_AGENT_MAX_TOOL_CALLS = 'off';
    process.env.LLM_AGENT_TOOL_RESULT_MAX_CHARS = 'off';
    const config = loadAgentConfig();
    expect(config.agent.toolResultMaxChars).toBe(0);
    for (const role of ['coordinator', 'executor', 'checker'] as const) {
      expect(
        runLimitOptions(role, { maxIterations: 10, maxToolCalls: 30 }),
      ).toEqual({ maxIterations: Infinity, maxToolCalls: undefined });
      expect(
        effectiveExecutionLimits('user', 'key')[`${role}.maxToolCalls`],
      ).toEqual({ value: 'off', source: 'config' });
    }
  });
  it('session limits override configuration per value and history off removes the budget', () => {
    process.env.LLM_AGENT_EXECUTOR_MAX_ITERATIONS = '4';
    process.env.LLM_AGENT_EXECUTOR_MAX_TOOL_CALLS = '9';
    process.env.LLM_AGENT_HISTORY_TOKEN_BUDGET = 'off';
    withExecutionLimits({ executor: { maxIterations: 2 } }, () => {
      expect(runLimitOptions('executor', { maxIterations: 10 })).toEqual({
        maxIterations: 2,
        maxToolCalls: 9,
      });
      expect(historyBudgetOptions()).toBeUndefined();
    });
  });
});
