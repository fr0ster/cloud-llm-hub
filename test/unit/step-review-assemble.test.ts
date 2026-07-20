import { assembleReviewedResponse } from '../../srv/lib/step-reviewer';

const T = { maxToolCalls: 1, minTokens: 1500 };
const base = (
  rawContent: string,
  toolCallCount: number,
  totalTokens: number,
) => ({
  task: 'Create domain ZX then activate it',
  rawContent,
  toolCallCount,
  totalTokens,
});
const neverReview = async () => {
  throw new Error('runReview should not have been called');
};

describe('assembleReviewedResponse', () => {
  it('C wins first: a completed-write claim with no write tool warns via C, no review', async () => {
    const raw =
      '[SmartAgent: Executing ReadDomain...]\nThe domain has been created.';
    const r = await assembleReviewedResponse(base(raw, 1, 9000), {
      enabled: true,
      thresholds: T,
      runReview: neverReview,
    });
    expect(r.writeGuardrailWarned).toBe(true);
    expect(r.reviewWarned).toBe(false);
    expect(r.content.toLowerCase()).toContain('write not verified');
  });

  it('disabled: no review, content unchanged', async () => {
    const raw = 'I checked and everything is fine.';
    const r = await assembleReviewedResponse(base(raw, 0, 10), {
      enabled: false,
      thresholds: T,
      runReview: neverReview,
    });
    expect(r).toEqual({
      content: raw,
      writeGuardrailWarned: false,
      reviewWarned: false,
      reviewFailed: false,
    });
  });

  it('not suspicious (tool-heavy, token-heavy): no review', async () => {
    const raw = '[SmartAgent: Executing ReadTable...]\nHere are the rows.';
    const r = await assembleReviewedResponse(base(raw, 5, 9000), {
      enabled: true,
      thresholds: T,
      runReview: neverReview,
    });
    expect(r.reviewWarned).toBe(false);
    expect(r.reviewFailed).toBe(false);
    expect(r.content).toBe(raw);
  });

  it('suspicious + possiblyFake: prepends the reviewer notice', async () => {
    const raw = 'Table T000 has 8 rows.'; // no write verb → C silent
    const r = await assembleReviewedResponse(base(raw, 0, 50), {
      enabled: true,
      thresholds: T,
      runReview: async () => ({
        possiblyFake: true,
        confidence: 'high',
        reasons: 'reported live data with zero tool calls',
      }),
    });
    expect(r.reviewWarned).toBe(true);
    expect(r.content.toLowerCase()).toContain('unverified');
    expect(r.content).toContain(raw);
  });

  it('suspicious + not fake: content unchanged', async () => {
    const raw = 'I need more detail to proceed.';
    const r = await assembleReviewedResponse(base(raw, 0, 50), {
      enabled: true,
      thresholds: T,
      runReview: async () => ({
        possiblyFake: false,
        confidence: 'low',
        reasons: 'ok',
      }),
    });
    expect(r.reviewWarned).toBe(false);
    expect(r.content).toBe(raw);
  });

  it('suspicious + review failed (null): flags reviewFailed, content unchanged', async () => {
    const raw = 'Done.';
    const r = await assembleReviewedResponse(base(raw, 0, 50), {
      enabled: true,
      thresholds: T,
      runReview: async () => null,
    });
    expect(r.reviewFailed).toBe(true);
    expect(r.reviewWarned).toBe(false);
    expect(r.content).toBe(raw);
  });

  it('fail-open: a runReview that THROWS is caught → reviewFailed, content unchanged', async () => {
    const raw = 'Done.';
    const r = await assembleReviewedResponse(base(raw, 0, 50), {
      enabled: true,
      thresholds: T,
      runReview: async () => {
        throw new Error('reviewer blew up');
      },
    });
    expect(r.reviewFailed).toBe(true);
    expect(r.reviewWarned).toBe(false);
    expect(r.content).toBe(raw);
  });
});
