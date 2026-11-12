const taskCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};

import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { ReviewerSubAgent } from '../../srv/lib/reviewer-subagent';

function record(
  name: string,
  content: string | Record<string, unknown>,
): ToolCallRecord {
  return { call: { id: '', name, arguments: {} }, result: { content } };
}

describe('ReviewerSubAgent', () => {
  it('has the expected identity and capabilities', () => {
    const agent = new ReviewerSubAgent({
      getToolRecords: () => [],
    });
    expect(agent.name).toBe('reviewer');
    expect(agent.capabilities).toEqual({ contextPolicy: 'optional' });
  });

  it('flags a false activation claim (status:inactive) without ever setting errorClass', async () => {
    const agent = new ReviewerSubAgent({
      getToolRecords: () => [
        record('CreateDomain', '{"success":true,"status":"inactive"}'),
      ],
    });
    const result = await agent.run({
      caller: taskCaller,
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

  it('passes a clean create+activate report (status:active) with no errorClass', async () => {
    const agent = new ReviewerSubAgent({
      getToolRecords: () => [
        record('CreateDomain', '{"success":true,"status":"active"}'),
      ],
    });
    const result = await agent.run({
      caller: taskCaller,
      task: 'Create domain ZDEMO_D_MATNR then activate it',
      context: 'The domain has been created and activated successfully.',
      trace: { traceId: 't-2' },
    });
    expect(result.errorClass).toBeUndefined();
    expect(result.metadata?.verdict).toEqual({ ok: true });
  });

  it('falls back to input.task when input.context is absent', async () => {
    const agent = new ReviewerSubAgent({
      getToolRecords: () => [],
    });
    const result = await agent.run({
      caller: taskCaller,
      task: 'Nothing to report, no writes attempted.',
    });
    expect(result.errorClass).toBeUndefined();
    expect(result.output).toBe('Nothing to report, no writes attempted.');
    expect(result.metadata?.verdict).toEqual({ ok: true });
  });

  it('never sets errorClass, even when the review is a problem verdict (Verified fact 2)', async () => {
    const agent = new ReviewerSubAgent({
      getToolRecords: () => [],
      hadWriteCapability: () => true,
    });
    const result = await agent.run({
      caller: taskCaller,
      task: 'Delete domain ZDEMO_D_MATNR',
      context: 'The domain has been deleted.',
    });
    const verdict = result.metadata?.verdict as { ok: boolean };
    expect(verdict.ok).toBe(false);
    expect(result.errorClass).toBeUndefined();
    expect(result.epicFailTrace).toBeUndefined();
  });
});
