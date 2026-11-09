import {
  clearRoleModels,
  getRoleModels,
  roleModelSettingsSchema,
  setRoleModels,
  validateRoleModelSettings,
} from '../../srv/lib/role-model-settings';

const ctx = {
  allow: new Set(['A', 'B']),
  channel: 'chat' as const,
  paramsEnabled: false,
};

afterEach(() => {
  for (const user of ['u1', 'u2'])
    for (const key of ['k1', 'k2']) clearRoleModels(user, key);
});

test('accepts a model on the allowlist per role', () => {
  const settings = {
    coordinator: { model: 'A' },
    planner: { model: 'B' },
    executor: { model: 'A' },
    checker: { model: 'B' },
  };
  expect(validateRoleModelSettings(settings, ctx)).toEqual({
    ok: true,
    value: settings,
  });
});

test('refuses a model outside the allowlist with field executor.model', () => {
  expect(
    validateRoleModelSettings({ executor: { model: 'foreign' } }, ctx),
  ).toEqual({
    ok: false,
    error: { field: 'executor.model', reason: expect.any(String) },
  });
});

test('refuses params when paramsEnabled is false with the stage 2 reason', () => {
  expect(
    validateRoleModelSettings({ planner: { model: 'A', params: {} } }, ctx),
  ).toEqual({
    ok: false,
    error: {
      field: 'planner.params',
      reason:
        'parameters per role arrive with llm-agent per-role call options (stage 2)',
    },
  });
});

test('refuses params without a model with field planner.params', () => {
  expect(
    validateRoleModelSettings(
      { planner: { params: { temperature: 0.5 } } },
      { ...ctx, paramsEnabled: true },
    ),
  ).toEqual({
    ok: false,
    error: { field: 'planner.params', reason: expect.any(String) },
  });
});

test('refuses coordinator on channel mcp with field coordinator', () => {
  for (const coordinator of [{ model: 'A' }, 'auto'] as const)
    expect(
      validateRoleModelSettings({ coordinator }, { ...ctx, channel: 'mcp' }),
    ).toEqual({
      ok: false,
      error: { field: 'coordinator', reason: expect.any(String) },
    });
});

test('auto and empty model clear a role, including a never-set role', () => {
  expect(
    validateRoleModelSettings(
      { executor: 'auto', planner: { model: '' }, checker: { model: 'auto' } },
      ctx,
    ),
  ).toEqual({ ok: true, value: {} });
  expect(validateRoleModelSettings({ executor: {} }, ctx)).toEqual({
    ok: true,
    value: {},
  });
});

test('refuses unknown role names and malformed nested fields', () => {
  const input = { executor: { model: 'A' }, reviewer: { model: 'B' } };
  expect(validateRoleModelSettings(input, ctx)).toEqual({
    ok: false,
    error: { field: 'reviewer', reason: expect.any(String) },
  });
  expect(
    roleModelSettingsSchema.safeParse({ reviewer: { model: 'A' } }).success,
  ).toBe(false);
  expect(
    roleModelSettingsSchema.safeParse({ executor: { extra: true } }).success,
  ).toBe(false);
  expect(
    roleModelSettingsSchema.safeParse({
      executor: { params: { temperature: 'hot' } },
    }).success,
  ).toBe(false);
});

test('nothing is applied when one role is invalid', () => {
  setRoleModels('u1', 'k1', { executor: { model: 'A' } });
  const result = validateRoleModelSettings(
    { executor: { model: 'B' }, checker: { model: 'foreign' } },
    ctx,
  );
  if (result.ok) setRoleModels('u1', 'k1', result.value);
  expect(result.ok).toBe(false);
  expect(getRoleModels('u1', 'k1')).toEqual({ executor: { model: 'A' } });
});

test('isolates sessions and protects stored values from mutation', () => {
  const settings = { executor: { model: 'A' } };
  setRoleModels('u1', 'k1', settings);
  settings.executor.model = 'B';
  const read = getRoleModels('u1', 'k1');
  if (read.executor) read.executor.model = 'B';
  expect(getRoleModels('u1', 'k1')).toEqual({ executor: { model: 'A' } });
  expect(getRoleModels('u1', 'k2')).toEqual({});
  expect(getRoleModels('u2', 'k1')).toEqual({});
});

test('clearRoleModels returns the session to defaults', () => {
  setRoleModels('u1', 'k1', { executor: { model: 'A' } });
  clearRoleModels('u1', 'k1');
  clearRoleModels('u1', 'k1');
  expect(getRoleModels('u1', 'k1')).toEqual({});
});
