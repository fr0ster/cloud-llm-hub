import {
  loadStepGateThresholds,
  loadStepReviewTimeoutMs,
  stepReviewEnabled,
} from '../../srv/lib/step-gate';

describe('loadStepGateThresholds', () => {
  // Zero, deliberately: suspicious means claimed work with NOTHING called to do
  // it, which is the rule the reviewer's own prompt states. At 1 the gate
  // summoned the critic on every single-tool step, and a compact create that
  // activates itself is a single-tool step — it called a correct answer fake.
  it('spends the critic only when no tool ran at all', () => {
    expect(loadStepGateThresholds({})).toEqual({
      maxToolCalls: 0,
    });
  });
  it('reads valid env overrides', () => {
    expect(
      loadStepGateThresholds({
        LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS: '3',
      } as NodeJS.ProcessEnv),
    ).toEqual({ maxToolCalls: 3 });
  });
  it('falls back to defaults on empty / invalid / negative / non-integer', () => {
    for (const bad of ['', '  ', 'abc', '-1', '1.5']) {
      expect(
        loadStepGateThresholds({
          LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS: bad,
        } as NodeJS.ProcessEnv),
      ).toEqual({ maxToolCalls: 0 });
    }
  });
  it('accepts an explicit widening', () => {
    // An operator who wants the old behaviour back sets it to 1.
    expect(
      loadStepGateThresholds({
        LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS: '1',
      } as NodeJS.ProcessEnv).maxToolCalls,
    ).toBe(1);
  });
});

describe('stepReviewEnabled', () => {
  it('is enabled when unset or exactly "true"', () => {
    expect(stepReviewEnabled({})).toBe(true);
    expect(
      stepReviewEnabled({
        LLM_AGENT_STEP_REVIEW_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
  it('is disabled for any other value', () => {
    for (const v of ['false', '0', 'no', '']) {
      expect(
        stepReviewEnabled({
          LLM_AGENT_STEP_REVIEW_ENABLED: v,
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });
});

describe('loadStepReviewTimeoutMs', () => {
  it('defaults to 8000 when unset', () => {
    expect(loadStepReviewTimeoutMs({})).toBe(8000);
  });
  it('reads a valid positive integer', () => {
    expect(
      loadStepReviewTimeoutMs({
        LLM_AGENT_STEP_REVIEW_TIMEOUT_MS: '3000',
      } as NodeJS.ProcessEnv),
    ).toBe(3000);
  });
  it('falls back on empty / non-integer / trailing-junk / <= 0', () => {
    for (const bad of ['', '  ', '1.5', '10abc', '0', '-5', 'abc']) {
      expect(
        loadStepReviewTimeoutMs({
          LLM_AGENT_STEP_REVIEW_TIMEOUT_MS: bad,
        } as NodeJS.ProcessEnv),
      ).toBe(8000);
    }
  });
});
