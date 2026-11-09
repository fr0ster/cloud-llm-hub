import {
  clearRoleModels,
  setRoleModels,
} from '../../srv/lib/role-model-settings';
import {
  currentRoleModel,
  effectiveRoleModels,
  roleOfProfile,
  withRoleModels,
} from '../../srv/lib/role-models-scope';

let previousAllowlist: string | undefined;
beforeEach(() => {
  previousAllowlist = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'A,B';
});
afterEach(() => {
  if (previousAllowlist === undefined) delete process.env.LLM_AGENT_MODELS;
  else process.env.LLM_AGENT_MODELS = previousAllowlist;
});

test('role scopes isolate concurrent sessions and restore nested settings', async () => {
  await Promise.all(
    ['A', 'B'].map((model) =>
      withRoleModels({ executor: { model } }, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(currentRoleModel('executor')).toBe(model);
        await withRoleModels({}, async () =>
          expect(currentRoleModel('executor')).toBeUndefined(),
        );
        expect(currentRoleModel('executor')).toBe(model);
      }),
    ),
  );
  expect(currentRoleModel('executor')).toBeUndefined();
  expect(roleOfProfile({ result: 'verdict' })).toBe('checker');
  expect(roleOfProfile({ result: 'report' })).toBe('executor');
});

test('effectiveRoleModels reports source per role', () => {
  const saved = { ...process.env };
  process.env.LLM_AGENT_MODEL = 'deploy';
  process.env.LLM_AGENT_PLANNER_MODEL = 'planner';
  process.env.LLM_AGENT_COORDINATOR_MODEL = 'coordinator';
  setRoleModels('scope-user', 'key', { executor: { model: 'user' } });
  try {
    expect(effectiveRoleModels('scope-user', 'key')).toMatchObject({
      coordinator: { model: 'coordinator', source: 'env' },
      planner: { model: 'planner', source: 'env' },
      executor: { model: 'user', source: 'user' },
      checker: { model: null, source: 'coordinator' },
    });
    expect(effectiveRoleModels('other', 'key').executor).toMatchObject({
      model: null,
      source: 'coordinator',
    });
    delete process.env.LLM_AGENT_PLANNER_MODEL;
    expect(effectiveRoleModels('scope-user', 'key').planner).toMatchObject({
      model: 'deploy',
      source: 'deploy',
    });
  } finally {
    process.env = saved;
    clearRoleModels('scope-user', 'key');
  }
});

test.each(['coordinator', 'planner', 'executor', 'checker'] as const)(
  '%s rejects a stored model removed from the current allowlist',
  async (role) => {
    await withRoleModels({ [role]: { model: 'A' } }, async () => {
      expect(currentRoleModel(role)).toBe('A');
      process.env.LLM_AGENT_MODELS = 'B';
      expect(() => currentRoleModel(role)).toThrow(
        `${role}.model: MODEL_NOT_ALLOWED`,
      );
    });
  },
);

test.each([
  ['sap-model', 'sap-model'],
  [undefined, 'gpt-4o-mini'],
])(
  'effective deploy model uses SAP_CORE_AI_MODEL=%s or the built-in fallback',
  (sapModel, expected) => {
    const saved = { ...process.env };
    delete process.env.LLM_AGENT_MODEL;
    delete process.env.LLM_AGENT_COORDINATOR_MODEL;
    delete process.env.LLM_AGENT_PLANNER_MODEL;
    if (sapModel === undefined) delete process.env.SAP_CORE_AI_MODEL;
    else process.env.SAP_CORE_AI_MODEL = sapModel;
    try {
      expect(effectiveRoleModels('fallback-user', 'default')).toMatchObject({
        coordinator: { model: expected, source: 'deploy' },
        planner: { model: expected, source: 'deploy' },
      });
    } finally {
      process.env = saved;
    }
  },
);
