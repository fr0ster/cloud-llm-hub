import type { ILlm, ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import {
  evaluateDeterministic,
  parseToolOutcome,
  type ReviewIssue,
  type ReviewVerdict,
  type ToolOutcome,
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
  'Judge a tool by its RESULT, not by its name. A create or update tool that',
  'reports status=active DID activate the object as part of its own call — a',
  'separate Activate* tool is NOT required, and demanding one is wrong.',
  'Tool evidence is required for claims about the SAP SYSTEM. It is NOT required',
  'for anything already established in CONVERSATION SO FAR: restating, using or',
  'reasoning from what the user themselves supplied earlier is supported by the',
  'conversation, and needs no tool. Judge such an answer on whether it matches',
  'the conversation — possiblyFake=false when it does.',
  'If you are genuinely UNSURE whether a claim is supported, still flag it',
  '(possiblyFake=true) but say so explicitly in "reasons" and use a LOWER',
  '"confidence" — never hide a real doubt.',
  'Reply with STRICT JSON ONLY, no prose:',
  '{"possiblyFake": boolean, "confidence": "low"|"medium"|"high", "reasons": string}',
].join(' ');

/**
 * One executed tool, as ground truth rather than a name.
 *
 * The critic used to be handed names alone and reasoned from them: told that
 * only `CreateDataElement` ran, it declared the executor's "activated" claim
 * unsupported because no `Activate*` appeared. But a create tool activates as
 * part of its own call, and says so in its RESULT. The deterministic layer has
 * always read that envelope; the critic never saw it.
 */
function describeTool(t: string | ToolOutcome): string {
  if (typeof t === 'string') return t;
  const parts = [t.ok ? 'ok' : 'failed'];
  if (t.status) parts.push(`status=${t.status}`);
  if (t.error) parts.push(`error=${t.error}`);
  return `${t.name} → ${parts.join(', ')}`;
}

/** How many earlier turns the reviewer is shown, and how much of each. */
const HISTORY_TURNS = 10;
const HISTORY_CHARS = 600;

/**
 * The conversation the step belongs to, rendered for the reviewer.
 *
 * Without it the reviewer judged every answer as if it were the first thing
 * ever said. Asked "what is my favourite number" after the user had supplied
 * it, the executor answered correctly and was flagged high-confidence fake: a
 * concrete statement after zero tool calls is exactly its rule, and the turn
 * that made the statement true was not in front of it.
 */
function renderHistory(history: ReviewTurn[]): string {
  return history
    .slice(-HISTORY_TURNS)
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : '';
      const clipped =
        text.length > HISTORY_CHARS ? `${text.slice(0, HISTORY_CHARS)}…` : text;
      return `${m.role}: ${clipped}`;
    })
    .join('\n');
}

/** One earlier turn — only the parts the reviewer can use. */
export type ReviewTurn = { role: string; content?: unknown };

export function buildReviewMessages(input: {
  task: string;
  /** Names OR outcomes. A bare name cannot say whether the tool succeeded, and
   *  a create tool that activates as part of its own call reports that only in
   *  its RESULT. */
  executedTools: (string | ToolOutcome)[];
  content: string;
  history?: ReviewTurn[];
}): { role: 'system' | 'user'; content: string }[] {
  const tools = input.executedTools.length
    ? input.executedTools.map(describeTool).join('; ')
    : '(none)';
  const history = input.history?.length ? renderHistory(input.history) : '';
  const user = [
    ...(history ? [`CONVERSATION SO FAR:\n${history}\n`] : []),
    `TASK:\n${input.task || '(not recorded)'}`,
    `\nTOOLS ACTUALLY EXECUTED (in order): ${tools}`,
    `\nEXECUTOR RESPONSE:\n${input.content}`,
    '\nDid the executor actually accomplish the task? Judge system claims ONLY by',
    'the executed tools, and everything else by the conversation above. Return the',
    'strict JSON verdict.',
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
  input: {
    task: string;
    executedTools: (string | ToolOutcome)[];
    content: string;
    history?: ReviewTurn[];
  },
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
  /** What the executor was asked. Empty means the caller did not record it. */
  task?: string;
  /** The turns before this one, so a fact the user supplied is not "unsupported". */
  history?: ReviewTurn[];
}): Promise<ReviewVerdict> {
  if (!stepReviewEnabled(process.env)) return { ok: true };

  const deterministic = evaluateDeterministic(input.content, input.records);
  const thresholds = loadStepGateThresholds(process.env);
  const suspicious = input.toolCallCount <= thresholds.maxToolCalls;
  if (!suspicious) return deterministic;

  // Outcomes, not names — the same ground truth `evaluateDeterministic` reads.
  const executedTools = input.records.map(parseToolOutcome);
  let review: StepReview | null;
  try {
    review = await reviewStep(
      {
        task: input.task ?? '',
        executedTools,
        content: input.content,
        history: input.history,
      },
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
