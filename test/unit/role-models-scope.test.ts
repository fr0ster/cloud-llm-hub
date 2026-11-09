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
    expect(effectiveRoleModels('scope-user', 'key')).toEqual({
      coordinator: { model: 'coordinator', source: 'env' },
      planner: { model: 'planner', source: 'env' },
      executor: { model: 'user', source: 'user' },
      checker: { model: null, source: 'coordinator' },
    });
    expect(effectiveRoleModels('other', 'key').executor).toEqual({
      model: null,
      source: 'coordinator',
    });
    delete process.env.LLM_AGENT_PLANNER_MODEL;
    expect(effectiveRoleModels('scope-user', 'key').planner).toEqual({
      model: 'deploy',
      source: 'deploy',
    });
  } finally {
    process.env = saved;
    clearRoleModels('scope-user', 'key');
  }
});
