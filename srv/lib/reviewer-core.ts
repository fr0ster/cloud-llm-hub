/**
 * Pure deterministic verdict for the reviewer layer: compares what the
 * response CLAIMS to have written against which write tools actually ran.
 *
 * Built on top of `write-guardrail`'s claim/tool detection (Task 3), this
 * module produces a structured `ReviewVerdict` instead of a text banner, so a
 * controller can act on individual issues (one per unverified op) rather than
 * a single yes/no flag.
 */

import {
  claimedWriteOps,
  opSatisfiedByTools,
  type WriteOp,
} from './write-guardrail';

export type ReviewIssue = {
  kind: 'unverified-write';
  claimedOp: WriteOp;
  expectedToolFamily: string;
  observedTools: string[];
};

export type ReviewVerdict = { ok: true } | { ok: false; issues: ReviewIssue[] };

const TOOL_FAMILY_LABEL: Record<WriteOp, string> = {
  created: 'Create*',
  updated: 'Update*',
  deleted: 'Delete*',
  activated: 'Activate*',
};

/** Deterministic verdict: one `ReviewIssue` per claimed write op unsatisfied by executed tools. */
export function evaluateDeterministic(
  content: string,
  executedTools: string[],
): ReviewVerdict {
  const issues: ReviewIssue[] = [];
  for (const op of claimedWriteOps(content)) {
    if (opSatisfiedByTools(op, executedTools)) continue;
    issues.push({
      kind: 'unverified-write',
      claimedOp: op,
      expectedToolFamily: TOOL_FAMILY_LABEL[op],
      observedTools: executedTools,
    });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
