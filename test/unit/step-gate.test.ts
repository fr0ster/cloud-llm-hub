import {
  loadStepGateThresholds,
  loadStepReviewTimeoutMs,
  stepIsSuspicious,
  stepReviewEnabled,
} from '../../srv/lib/step-gate';

const T = { maxToolCalls: 1, minTokens: 1500 };

describe('stepIsSuspicious', () => {
  it('flags a low tool-call count (hallucination / nothing ran)', () => {
    expect(stepIsSuspicious({ toolCallCount: 0, totalTokens: 9000 }, T)).toBe(
      true,
    );
    expect(stepIsSuspicious({ toolCallCount: 1, totalTokens: 9000 }, T)).toBe(
      true,
    );
  });
  it('flags low token spend even with more calls', () => {
    expect(stepIsSuspicious({ toolCallCount: 5, totalTokens: 800 }, T)).toBe(
      true,
    );
  });
  it('does NOT flag a 2-tool, token-heavy call at the default gate', () => {
    expect(stepIsSuspicious({ toolCallCount: 2, totalTokens: 9000 }, T)).toBe(
      false,
    );
  });
  it('does NOT flag a tool-heavy, token-heavy call', () => {
    expect(stepIsSuspicious({ toolCallCount: 5, totalTokens: 9000 }, T)).toBe(
      false,
    );
  });
});

describe('loadStepGateThresholds', () => {
  it('uses defaults when unset', () => {
    expect(loadStepGateThresholds({})).toEqual({
      maxToolCalls: 1,
      minTokens: 1500,
    });
  });
  it('reads valid env overrides', () => {
    expect(
      loadStepGateThresholds({
        LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS: '3',
        LLM_AGENT_STEP_REVIEW_MIN_TOKENS: '500',
      } as NodeJS.ProcessEnv),
    ).toEqual({ maxToolCalls: 3, minTokens: 500 });
  });
  it('falls back to defaults on empty / invalid / negative / non-integer', () => {
    for (const bad of ['', '  ', 'abc', '-1', '1.5']) {
      expect(
        loadStepGateThresholds({
          LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS: bad,
          LLM_AGENT_STEP_REVIEW_MIN_TOKENS: bad,
        } as NodeJS.ProcessEnv),
      ).toEqual({ maxToolCalls: 1, minTokens: 1500 });
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
