import cds from '@sap/cds';
import {
  validateAgentProfileRecord,
  workerProfile,
} from '../../srv/lib/agent-profile-records';
import {
  parseModelAllowlist,
  resolveAgentModel,
  resolveRequestModel,
} from '../../srv/lib/model-policy';

describe('model policy', () => {
  const allow = parseModelAllowlist({
    LLM_AGENT_MODEL: 'worker',
    LLM_AGENT_PLANNER_MODEL: 'planner',
    LLM_AGENT_MODELS: ' A, B, A, ',
  });
  test('deploy defaults are always allowed', () => {
    expect([...allow]).toEqual(['A', 'B', 'worker', 'planner']);
    expect([...parseModelAllowlist({ LLM_AGENT_MODEL: 'worker' })]).toEqual([
      'worker',
    ]);
  });
  test('request models are isolated choices; foreign client ids are ignored', () => {
    expect(resolveRequestModel('A', allow)).toEqual({ model: 'A' });
    expect(resolveRequestModel('B', allow)).toEqual({ model: 'B' });
    expect(resolveRequestModel('claude-sonnet-4', allow)).toEqual({
      ignored: 'claude-sonnet-4',
    });
    expect(resolveRequestModel(undefined, allow)).toEqual({});
  });
  test('worker override precedes profile and fallback; disallowed choices fail', () => {
    expect(resolveAgentModel({}, allow, 'worker')).toEqual({
      ok: true,
      value: 'worker',
    });
    expect(resolveAgentModel({ profile: 'B' }, allow, 'worker')).toEqual({
      ok: true,
      value: 'B',
    });
    expect(
      resolveAgentModel({ requested: 'A', profile: 'B' }, allow, 'worker'),
    ).toEqual({ ok: true, value: 'A' });
    expect(
      resolveAgentModel({ requested: 'foreign' }, allow, 'worker'),
    ).toEqual({ ok: false, error: 'MODEL_NOT_ALLOWED' });
  });
});

test('profile models are profile-only; stale stored model is ignored on load', () => {
  const document = {
    id: 'executor',
    text: 'Execute',
    metadata: {
      canonicalKey: 'executor',
      kind: 'profile',
      name: 'executor',
      description: '',
      tools: 'all',
      result: 'report',
      model: 'foreign-model',
    },
  };
  expect(() => validateAgentProfileRecord(document)).toThrow(
    'model outside allowlist',
  );
  const warn = jest
    .spyOn(cds.log('agent-profiles'), 'warn')
    .mockImplementation(() => {});
  try {
    const loaded = validateAgentProfileRecord(document, 'load');
    expect(workerProfile(loaded)?.model).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(() =>
      validateAgentProfileRecord({
        id: 'coordinator',
        text: '',
        metadata: {
          canonicalKey: 'coordinator',
          kind: 'coordinator',
          name: 'coordinator',
          model: 'foreign-model',
        },
      }),
    ).toThrow();
  } finally {
    warn.mockRestore();
  }
});
