import {
  loadStepGateThresholds,
  loadStepReviewTimeoutMs,
  stepReviewEnabled,
} from '../../srv/lib/step-gate';

describe('loadStepGateThresholds', () => {
  it('uses defaults when unset', () => {
    expect(loadStepGateThresholds({})).toEqual({
      maxToolCalls: 1,
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
      ).toEqual({ maxToolCalls: 1 });
    }
  });
  it('accepts an explicit 0', () => {
    expect(
      loadStepGateThresholds({
        LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS: '0',
      } as NodeJS.ProcessEnv).maxToolCalls,
    ).toBe(0);
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
