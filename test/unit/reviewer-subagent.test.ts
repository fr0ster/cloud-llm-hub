import { ReviewerSubAgent } from '../../srv/lib/reviewer-subagent';

describe('ReviewerSubAgent', () => {
  // This portable unit hardcodes totalTokens/toolCallCount to 0 (real counts
  // come from the future finalizer's `getSummary`), so `evaluateGated`'s token
  // gate is always "suspicious" here and the LLM critic always runs. Use a
  // benign stub verdict so the deterministic check (the thing under test)
  // is never overridden by a spurious LLM finding.
  const benignLlm = {
    chat: jest.fn(async () => ({
      ok: true as const,
      value: {
        content:
          '{"possiblyFake": false, "confidence": "low", "reasons": "ok"}',
      },
    })),
    streamChat: async function* () {},
  };

  it('has the expected identity and capabilities', () => {
    const agent = new ReviewerSubAgent({
      executedToolNames: () => [],
      llm: benignLlm as never,
    });
    expect(agent.name).toBe('reviewer');
    expect(agent.capabilities).toEqual({ contextPolicy: 'optional' });
  });

  it('flags a false activation claim without ever setting errorClass', async () => {
    const agent = new ReviewerSubAgent({
      executedToolNames: () => ['CreateDomain'],
      llm: benignLlm as never,
    });
    const result = await agent.run({
      task: 'Create domain ZDEMO_D_MATNR then activate it',
      context: 'The domain has been created and activated successfully.',
      trace: { traceId: 't-1' },
    });
    expect(result.errorClass).toBeUndefined();
    const verdict = result.metadata?.verdict as {
      ok: boolean;
      issues?: unknown[];
    };
    expect(verdict.ok).toBe(false);
    expect(verdict.issues).toEqual([
      expect.objectContaining({
        kind: 'unverified-write',
        claimedOp: 'activated',
      }),
    ]);
  });

  it('passes a clean create+activate report with no errorClass', async () => {
    const agent = new ReviewerSubAgent({
      executedToolNames: () => ['CreateDomain', 'ActivateDomain'],
      llm: benignLlm as never,
    });
    const result = await agent.run({
      task: 'Create domain ZDEMO_D_MATNR then activate it',
      context: 'The domain has been created and activated successfully.',
      trace: { traceId: 't-2' },
    });
    expect(result.errorClass).toBeUndefined();
    expect(result.metadata?.verdict).toEqual({ ok: true });
  });

  it('falls back to input.task when input.context is absent', async () => {
    const agent = new ReviewerSubAgent({
      executedToolNames: () => [],
      llm: benignLlm as never,
    });
    const result = await agent.run({
      task: 'Nothing to report, no writes attempted.',
    });
    expect(result.errorClass).toBeUndefined();
    expect(result.output).toBe('Nothing to report, no writes attempted.');
    expect(result.metadata?.verdict).toEqual({ ok: true });
  });

  it('never sets errorClass, even when the review is a problem verdict (Verified fact 2)', async () => {
    const agent = new ReviewerSubAgent({
      executedToolNames: () => [],
      llm: benignLlm as never,
    });
    const result = await agent.run({
      task: 'Delete domain ZDEMO_D_MATNR',
      context: 'The domain has been deleted.',
    });
    const verdict = result.metadata?.verdict as { ok: boolean };
    expect(verdict.ok).toBe(false);
    expect(result.errorClass).toBeUndefined();
    expect(result.epicFailTrace).toBeUndefined();
  });
});
