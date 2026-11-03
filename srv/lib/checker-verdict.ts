import type { DialogueState, ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { z } from 'zod';

const verdictSchema = z.object({
  verdict: z.string(),
  claims: z
    .array(
      z.object({ quote: z.string(), evidence: z.string(), reason: z.string() }),
    )
    .optional(),
});
const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Bind negative verdicts before the dialogue library interprets worker output. */
export function bindCheckerVerdict(
  output: string,
  context: string,
  brief: string,
  records: ToolCallRecord[],
): string {
  let parsed: z.infer<typeof verdictSchema> | undefined;
  try {
    const json = output
      .trim()
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    const result = verdictSchema.safeParse(JSON.parse(json));
    if (result.success) parsed = result.data;
  } catch {
    // Legacy PASS remains accepted; a bare FAIL cannot carry evidence.
  }
  if (parsed?.verdict.toLowerCase() === 'pass' || /^PASS$/i.test(output.trim()))
    return output;

  // The library supplies each checked output before its tool-trace heading.
  // Do not allow a quote from the brief or tool evidence to stand in for it.
  const checked = [
    ...context.matchAll(
      /\[result to check: step [^\n]+\]\n([\s\S]*?)(?=\n\[tools used by task |\n\n\[result to check: step |$)/g,
    ),
  ].map((match) => normalize(match[1] ?? ''));
  const evidence = normalize(
    [
      context,
      brief,
      ...records.map((record) =>
        typeof record.result.content === 'string'
          ? record.result.content
          : JSON.stringify(record.result.content),
      ),
    ].join('\n'),
  );
  const claims =
    parsed?.verdict.toLowerCase() === 'fail' ? (parsed.claims ?? []) : [];
  let valid = 0;
  let reason =
    parsed?.verdict.toLowerCase() === 'fail' || /^FAIL$/i.test(output.trim())
      ? claims.length
        ? 'quote_absent'
        : 'claims_missing'
      : 'invalid_verdict';
  for (const claim of claims) {
    const quote = normalize(claim.quote);
    if (!quote || !checked.some((result) => result.includes(quote))) {
      reason = 'quote_absent';
      continue;
    }
    const excerpt = normalize(claim.evidence);
    if (
      !excerpt ||
      (excerpt !== 'none provided' && !evidence.includes(excerpt))
    ) {
      reason = 'evidence_absent';
      continue;
    }
    if (!normalize(claim.reason)) {
      reason = 'reason_missing';
      continue;
    }
    valid++;
  }
  // Every claim must bind; a fabricated claim cannot hitchhike on a valid one.
  if (valid > 0 && valid === claims.length) return output;
  cds.log('checker-verdict').warn('discarded checker verdict', {
    reason,
    claims: claims.length,
    validClaims: valid,
  });
  return `unusable verdict: ${reason}`;
}

/** The library maps malformed verdicts to fail; the hub keeps them undecided. */
export function clearUnusableCheckerFailures(state: DialogueState): void {
  if (!state.plan || typeof state.plan === 'string') return;
  let cleared = false;
  for (const step of state.plan.steps) {
    const task = state.tasks.find((task) => task.id === step.workTaskId);
    if (
      step.state === 'skipped' ||
      step.verdict !== 'fail' ||
      task?.result !== 'verdict' ||
      !task.output?.startsWith('unusable verdict: ')
    )
      continue;
    cleared = true;
    delete step.verdict;
    delete step.successfulWorkTaskId;
    step.state = 'pending';
    step.note = task.output;
  }
  if (cleared && state.plan.status !== 'waiting_user') {
    state.plan.status = 'active';
    state.planStatus = 'active';
  }
}

/** Reopen only unusable current attempts; retain explicit coordinator skips. */
export function unusableCheckerPlanSteps(state: DialogueState) {
  clearUnusableCheckerFailures(state);
  if (
    !state.plan ||
    typeof state.plan === 'string' ||
    !state.plan.steps.some(
      (step) =>
        step.state === 'pending' &&
        step.workTaskId &&
        step.note?.startsWith('unusable verdict: '),
    )
  )
    return undefined;
  return state.plan.steps.map((step) => ({
    id: step.id,
    goal: step.goal,
    worker: step.worker,
    result: step.result,
    items: step.items,
    dependsOn: step.dependsOn,
    state: step.state,
    note: step.note,
  }));
}
