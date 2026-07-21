/**
 * Channel-neutral rendering of a `ReviewVerdict` into a human-readable notice.
 *
 * `FinalizerInput` has no `channel` field (execute_step / /v1/chat / /v1/messages
 * all share the same `NoticeFinalizer`), so this renders ONE canonical notice —
 * any per-channel reformatting is a handler-layer concern, out of scope here.
 *
 * The notice begins with the exact ASCII marker `UNVERIFIED_WRITE:` (no emoji,
 * no leading spaces) so consumers can reliably `grep` for it.
 */

import type { ReviewIssue, ReviewVerdict } from './reviewer-core';

function describeIssue(issue: ReviewIssue): string {
  if (issue.kind === 'unverified-write') {
    const observed = issue.observedTools.length
      ? issue.observedTools.join(', ')
      : '(none)';
    return (
      `claims "${issue.claimedOp}" but no ${issue.expectedToolFamily} tool ran ` +
      `(executed tools: ${observed})`
    );
  }
  return `unsupported claim (confidence: ${issue.confidence}): ${issue.reasons}`;
}

/**
 * Renders a problem verdict into a channel-neutral notice string beginning
 * with `UNVERIFIED_WRITE:`. Returns `''` for an ok verdict (no notice).
 */
export function renderNotice(verdict: ReviewVerdict): string {
  if (verdict.ok) return '';
  const details = verdict.issues.map(describeIssue).join('; ');
  return `UNVERIFIED_WRITE: the response above may be unverified — ${details}. Verify against the system before relying on it.`;
}
