import type { DialogueState, ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { type CheckerVerdict, verdictSchema } from './checker-verdict-schema';
import { submitVerdictTool } from './checker-verdict-tool';

export { type CheckerVerdict, verdictSchema } from './checker-verdict-schema';

export function parseCheckerVerdict(
  output: string,
): CheckerVerdict | undefined {
  try {
    const result = verdictSchema.safeParse(
      JSON.parse(
        output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'),
      ),
    );
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function recordedCheckerVerdict(
  records: ToolCallRecord[],
): CheckerVerdict | undefined {
  for (const record of [...records].reverse()) {
    if (record.call.name !== submitVerdictTool.name || record.result.isError)
      continue;
    const result = verdictSchema.safeParse(record.call.arguments);
    if (result.success) return result.data;
  }
  return undefined;
}

export function checkerVerdictInput(
  output: string,
  records: ToolCallRecord[],
): string {
  const verdict = recordedCheckerVerdict(records);
  return verdict ? JSON.stringify(verdict) : output;
}

export function needsCheckerVerdictRetry(
  output: string,
  records: ToolCallRecord[],
): boolean {
  return (
    !recordedCheckerVerdict(records) &&
    !parseCheckerVerdict(output) &&
    !/^PASS$/i.test(output.trim())
  );
}
const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

export interface CheckerInputs {
  checkedOutputs: string[];
  checkedToolResults: string[];
  dependencyOutputs: string[];
  briefContext: string;
  briefGoal: string;
  records: ToolCallRecord[];
}

/** Resolve provenance from task identities, never from worker-authored headings. */
export function checkerInputs(
  state: DialogueState | undefined,
  taskId: string,
  briefGoal: string,
  records: ToolCallRecord[],
  briefContext = '',
): CheckerInputs {
  const steps = typeof state?.plan === 'object' ? state.plan.steps : [];
  const step = steps.find((entry) => entry.workTaskId === taskId);
  const checkedIds = new Set(Object.values(step?.checkedTaskIds ?? {}));
  const dependencyIds = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const dependency = steps.find((entry) => entry.id === id);
    if (dependency?.successfulWorkTaskId)
      dependencyIds.add(dependency.successfulWorkTaskId);
    for (const parent of dependency?.dependsOn ?? []) visit(parent);
  };
  for (const id of step?.dependsOn ?? []) visit(id);
  return {
    checkedOutputs: (state?.tasks ?? [])
      .filter((task) => checkedIds.has(task.id))
      .map((task) => task.output ?? ''),
    checkedToolResults: (state?.tasks ?? [])
      .filter((task) => checkedIds.has(task.id))
      .flatMap((task) =>
        (task.toolTrace?.entries ?? []).map((entry) => entry.resultExcerpt),
      ),
    dependencyOutputs: (state?.tasks ?? [])
      .filter((task) => dependencyIds.has(task.id) && !checkedIds.has(task.id))
      .map((task) => task.output ?? ''),
    briefContext,
    briefGoal,
    records,
  };
}

/** Bind negative verdicts before the dialogue library interprets worker output. */
export function bindCheckerVerdict(
  output: string,
  inputs: CheckerInputs,
): string {
  const parsed = parseCheckerVerdict(output);
  if (/^PASS$/i.test(output.trim())) return output;
  if (!parsed) {
    cds.log('checker-verdict').warn('discarded checker verdict', {
      reason: 'invalid_envelope',
      claims: 0,
      validClaims: 0,
    });
    return 'unusable verdict: invalid_envelope';
  }
  if (parsed.verdict === 'pass') return output;

  const checked = inputs.checkedOutputs.map(normalize);
  const evidence = normalize(
    [
      ...inputs.dependencyOutputs,
      ...inputs.checkedToolResults,
      inputs.briefContext,
      inputs.briefGoal,
      ...inputs.records.map((record) =>
        typeof record.result.content === 'string'
          ? record.result.content
          : Array.isArray(record.result.content)
            ? record.result.content
                .map((part) =>
                  part.type === 'text' && typeof part.text === 'string'
                    ? part.text
                    : JSON.stringify(part),
                )
                .join('\n')
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
