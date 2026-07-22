import type { ILlm, ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import {
  evaluateDeterministic,
  type ReviewIssue,
  type ReviewVerdict,
} from './reviewer-core';
import {
  loadStepGateThresholds,
  loadStepReviewTimeoutMs,
  stepReviewEnabled,
} from './step-gate';

export type StepReview = {
  possiblyFake: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasons: string;
};

const SYSTEM = [
  'You are a strict, skeptical REVIEWER of an ABAP executor agent — NOT its',
  'assistant. The executor was asked to do a task and produced a response.',
  'Assume it MAY have hallucinated: claimed results it never actually produced.',
  'Ground your judgement ONLY in the tools it ACTUALLY executed. A real ABAP',
  'operation needs the matching MCP tool: create needs a Create* tool, activate',
  'needs Activate*, delete needs Delete*, update needs Update*, read needs',
  'Read*/Get*.',
  'Flag possiblyFake=true ONLY when the executor ASSERTS an outcome or result',
  'the executed tools do not support — e.g. claims created/activated but no',
  'Create*/Activate* ran, or states a concrete system fact or success after zero',
  'tool calls.',
  'Do NOT flag an HONEST report of non-accomplishment: if the executor openly',
  'says it did NOT or could NOT do the task, asks for clarification, or reports',
  'an error truthfully, and makes NO false success claim, that is honest —',
  'possiblyFake=false, even with zero tools.',
  'If you are genuinely UNSURE whether a claim is supported, still flag it',
  '(possiblyFake=true) but say so explicitly in "reasons" and use a LOWER',
  '"confidence" — never hide a real doubt.',
  'Reply with STRICT JSON ONLY, no prose:',
  '{"possiblyFake": boolean, "confidence": "low"|"medium"|"high", "reasons": string}',
].join(' ');

export function buildReviewMessages(input: {
  task: string;
  executedTools: string[];
  content: string;
}): { role: 'system' | 'user'; content: string }[] {
  const tools = input.executedTools.length
    ? input.executedTools.join(', ')
    : '(none)';
  const user = [
    `TASK:\n${input.task}`,
    `\nTOOLS ACTUALLY EXECUTED (in order): ${tools}`,
    `\nEXECUTOR RESPONSE:\n${input.content}`,
    '\nDid the executor actually accomplish the task, judged ONLY by the executed',
    'tools? Return the strict JSON verdict.',
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

/** Yield each COMPLETE balanced `{…}` object in order (ignores braces in strings). */
function* balancedJsonObjects(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start < 0) return;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) {
      // Unterminated from `start` — skip past this `{` and keep looking; a later
      // `{…}` may still be a complete, valid verdict.
      i = start + 1;
      continue;
    }
    yield text.slice(start, end + 1);
    i = end + 1;
  }
}

function toReview(raw: unknown): StepReview | null {
  const o = raw as Record<string, unknown>;
  if (typeof o.possiblyFake !== 'boolean') return null;
  if (
    o.confidence !== 'low' &&
    o.confidence !== 'medium' &&
    o.confidence !== 'high'
  ) {
    return null;
  }
  if (typeof o.reasons !== 'string') return null;
  return {
    possiblyFake: o.possiblyFake,
    confidence: o.confidence,
    reasons: o.reasons,
  };
}

/**
 * Scan every balanced `{…}` object in the text and return the FIRST that parses
 * AND validates as a verdict — so a stray `Note: {example}` before the real JSON
 * does not defeat parsing. `null` if none validate (→ caller fails open).
 */
export function parseReviewVerdict(text: string): StepReview | null {
  for (const json of balancedJsonObjects(text)) {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      continue;
    }
    const v = toReview(raw);
    if (v) return v;
  }
  return null;
}

export async function reviewStep(
  input: { task: string; executedTools: string[]; content: string },
  deps: { llm: ILlm; timeoutMs?: number },
): Promise<StepReview | null> {
  const timeoutMs = deps.timeoutMs ?? 8000;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race the chat against a hard timeout — a reviewer that ignores the signal
  // must still never block execute_step. `null` from the timeout branch fails open.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      deps.llm.chat(buildReviewMessages(input), undefined, {
        signal: ctrl.signal,
      }),
      timeout,
    ]);
    if (res === null || !res.ok) return null;
    return parseReviewVerdict(res.value.content);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Deterministic-first, LLM-gated verdict for a step's response.
 *
 * Kill switch: when `stepReviewEnabled(process.env)` is false (operator set
 * `LLM_AGENT_STEP_REVIEW_ENABLED` to a non-'true' value), the ENTIRE guard —
 * both the deterministic write-claim check and the LLM critic — is bypassed
 * and `{ ok: true }` is returned unconditionally. Enabled by default.
 *
 * `evaluateDeterministic` (write-claim vs. tool-RESULT ground truth) runs
 * unconditionally — it is authoritative and free, independent of tool-call
 * volume. The LLM critic (`reviewStep`) is spent ONLY when the tool-call
 * count is at or below `maxToolCalls` (near-zero tool calls for a real op is
 * suspicious); a step above the threshold never reaches the LLM. Per-trace
 * token totals are no longer captured (the reviewer now grounds on tool
 * RESULTS, not the request logger), so the gate is tool-call-count only.
 * Any LLM-found problem is merged in as an `unsupported-claim` issue; a
 * throwing/timed-out critic fails open — the deterministic verdict is
 * returned unchanged, never with a fabricated issue.
 */
export async function evaluateGated(input: {
  content: string;
  records: ToolCallRecord[];
  toolCallCount: number;
  llm: ILlm;
}): Promise<ReviewVerdict> {
  if (!stepReviewEnabled(process.env)) return { ok: true };

  const deterministic = evaluateDeterministic(input.content, input.records);
  const thresholds = loadStepGateThresholds(process.env);
  const suspicious = input.toolCallCount <= thresholds.maxToolCalls;
  if (!suspicious) return deterministic;

  const executedTools = input.records.map((r) => r.call.name);
  let review: StepReview | null;
  try {
    review = await reviewStep(
      { task: '', executedTools, content: input.content },
      { llm: input.llm, timeoutMs: loadStepReviewTimeoutMs(process.env) },
    );
  } catch {
    review = null;
  }
  if (!review?.possiblyFake) return deterministic;

  const llmIssue: ReviewIssue = {
    kind: 'unsupported-claim',
    confidence: review.confidence,
    reasons: review.reasons,
  };
  return {
    ok: false,
    issues: deterministic.ok ? [llmIssue] : [...deterministic.issues, llmIssue],
  };
}
