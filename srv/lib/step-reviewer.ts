import type { ILlm, ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import {
  evaluateDeterministic,
  parseToolOutcome,
  type ReviewIssue,
  type ReviewVerdict,
  type ToolOutcome,
} from './reviewer-core';
import { loadStepReviewTimeoutMs, stepReviewEnabled } from './step-gate';

export type StepReview = {
  possiblyFake: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasons: string;
};

/**
 * What the critic is asked.
 *
 * The first version asked a NAME question: it carried a table saying "create
 * needs a Create* tool, activate needs Activate*", and then flagged an
 * activation claim backed by a lone `CreateDataElement`. It did what it was
 * told. Patching a results rule on top left the table standing, so the prompt
 * contradicted itself — hence this rewrite around a single question: does each
 * asserted outcome match what the executed tools REPORTED?
 *
 * The unsure-then-flag bias is narrowed rather than kept whole. It was written
 * for a reviewer of writes, but applied to every answer it turns ordinary
 * ambiguity into a notice, and a notice nobody trusts protects nobody.
 */
const SYSTEM = [
  'You are a REVIEWER of an ABAP executor agent — NOT its assistant.',
  'You answer exactly ONE question: does the RESPONSE deliver what the USER',
  'REQUEST asked for?',
  'Compare them directly. A response has NOT delivered the request when it acts',
  'on a different object, performs a different operation, does only part of what',
  'was asked, or answers a question that was not the one asked — however',
  'confidently it reads.',
  'Do NOT reason about tools. Which tools ran, whether one was missing, and what',
  'they returned are checked separately and are none of your concern. Never flag',
  'a response because a tool you expected is absent.',
  'A response that openly says it did NOT or could NOT do the task, asks for',
  'clarification, or reports an error truthfully HAS delivered an honest answer',
  'to the request — possiblyFake=false.',
  'Anything the user established earlier in CONVERSATION SO FAR is available to',
  'the response; using it is not an invention.',
  'When you are genuinely unsure, do not flag. A warning on a correct answer',
  'costs more than it saves.',
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
  /** What the USER asked, in their own words. The composed task is the
   *  coordinator's restatement, and a restatement can drift. */
  request?: string;
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
    ...(input.request ? [`USER REQUEST:\n${input.request}\n`] : []),
    `TASK (as composed for the executor):\n${input.task || '(not recorded)'}`,
    `\nTOOLS ACTUALLY EXECUTED (in order): ${tools}`,
    `\nEXECUTOR RESPONSE:\n${input.content}`,
    '\nDoes the response deliver what the user asked for? Return the strict JSON',
    'verdict.',
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
    request?: string;
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
 * Two independent checks, neither standing in for the other.
 *
 * `evaluateDeterministic` (write-claim vs. tool-RESULT ground truth) answers
 * what tools prove: it is authoritative, free, and needs no judgement.
 * `reviewStep` answers the one thing no comparison of tool records can — does
 * the response deliver what the USER asked for — and runs on every step. Per-trace
 * token totals are no longer captured (the reviewer now grounds on tool
 * RESULTS, not the request logger), so the gate is tool-call-count only.
 * Any LLM-found problem is merged in as an `unsupported-claim` issue; a
 * throwing/timed-out critic fails open — the deterministic verdict is
 * returned unchanged, never with a fabricated issue.
 */
export async function evaluateGated(input: {
  content: string;
  records: ToolCallRecord[];
  llm: ILlm;
  /** What the USER asked, verbatim. */
  request?: string;
  /** The coordinator's composed task. Empty means the caller did not record it. */
  task?: string;
  /** The turns before this one, so a fact the user supplied is not "unsupported". */
  history?: ReviewTurn[];
}): Promise<ReviewVerdict> {
  if (!stepReviewEnabled(process.env)) return { ok: true };

  const deterministic = evaluateDeterministic(input.content, input.records);

  // No gate. There used to be one, counting tool calls as a proxy for "little
  // was done, so be suspicious" — and it was wrong in both directions: at one
  // call it summoned a judge to every honest single-tool create, at zero it
  // left the critic only the cases the deterministic check already answers for
  // free. The proxy made sense while the critic reasoned about tools. It no
  // longer does: the critic answers whether the response delivered what the
  // user asked, which is worth asking of every step whatever ran during it.
  //
  // The cost is one LLM call per step, accepted deliberately. The kill switch
  // above turns off the whole guard when it is not.
  // Outcomes, not names — the same ground truth `evaluateDeterministic` reads.
  const executedTools = input.records.map(parseToolOutcome);
  let review: StepReview | null;
  try {
    review = await reviewStep(
      {
        request: input.request,
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
