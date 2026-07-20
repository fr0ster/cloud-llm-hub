/**
 * Executor honesty guardrail for the stateless `execute_step` surface.
 *
 * The executor is a pure executor: the planner (Claude Code) decides steps, the
 * executor runs ONE and reports back. When a caller's role lacks the write tools
 * (the Create/Update/Delete/Activate families are `high` = MCP_Developer), the
 * executor can still be nudged — by a stray instruction or its own reasoning —
 * to NARRATE a create it never performed, reporting fabricated success upward.
 *
 * This is a deterministic net on the tool side: if the response asserts a
 * completed write but NO write tool actually ran, prepend an explicit
 * "unverified" banner so the controller (and any human) sees the mismatch the
 * tool trace already proves. Additive — the original text is preserved, so a
 * rare false positive only adds a caution, never destroys content.
 */

const EXEC_MARKER = /\[SmartAgent: Executing ([A-Za-z0-9_]+)\.\.\.\]/g;

// Also matches the compact-mode handler names (HandlerCreate/Update/Delete/
// Activate, exposed when LLM_AGENT_INCLUDE_COMPACT=true) — else a real write via
// HandlerCreate would be falsely bannered as "no write tool".
const WRITE_TOOL = /^(?:Handler)?(?:Create|Update|Delete|Activate)/;

// Completed-write assertions. Passive forms need a completion cue (has been /
// was / successfully); active/first-person forms are matched directly. All
// exclude "Created by/on/in/at" and "Created:" metadata so a read-back's
// "Created by: X on <date>" never matches.
const CLAIM_PATTERNS: RegExp[] = [
  /\b(?:has|have)\s+been\s+(?:successfully\s+)?(?:created|updated|deleted|activated)\b/i,
  /\b(?:was|were|is)\s+(?:successfully\s+|now\s+)?(?:created|updated|deleted|activated)\b(?!\s+(?:by|on|in|at))/i,
  /\b(?:created|updated|deleted|activated)\s+successfully\b/i,
  // Active first-person: "I created", "I have created", "I've created",
  // "I successfully created" — but NOT "I cannot/need to create" (infinitive).
  /\bI(?:(?:'|’)ve|\s+(?:have|successfully|just|now))*\s+(?:created|updated|deleted|activated)\b/i,
  // Heading/status line "Created domain X", "✅ Created …" at a line start —
  // excludes "Created by/on/:" metadata and mid-sentence "created" prose.
  /(?:^|\n)\s*(?:[✅✔✓*\-•]\s*)?(?:created|updated|deleted|activated)\b(?!\s*:|\s+(?:by|on|in|at))/im,
  // RU/UK past participles ("создан", "створено") — excluded when part of a
  // longer word ("создание" = creation) or a "Создан:" metadata label.
  /(?:успешно|успішно)?\s*(?:создан|создано|создана|созданы|обновлен|обновлено|обновлена|удал[её]н|удалено|удалена|активирован|активировано|створено|створений|створена|оновлено|оновлений|видалено|видалений|активовано)(?![а-яіїєґ’':])/i,
];

const WARNING =
  '⚠️ WRITE NOT VERIFIED: the response below claims an object was ' +
  'created/updated/deleted/activated, but NO write tool ' +
  '(Create*/Update*/Delete*/Activate*) actually ran — so nothing was written. ' +
  'This usually means your role has read-only access (no MCP_Developer). ' +
  'Treat the claim as UNVERIFIED.';

/** Tool names the executor actually invoked, in order, from the content markers. */
export function extractExecutedTools(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(EXEC_MARKER)) out.push(m[1]);
  return out;
}

/** True if any executed tool is a write tool (Create/Update/Delete/Activate). */
export function hasWriteTool(tools: string[]): boolean {
  return tools.some((t) => WRITE_TOOL.test(t));
}

/** True if the text asserts a COMPLETED write (not metadata, not an instruction). */
export function claimsCompletedWrite(content: string): boolean {
  return CLAIM_PATTERNS.some((re) => re.test(content));
}

/**
 * Prepend an "unverified" banner iff the response claims a completed write yet
 * no write tool ran. Returns the (possibly annotated) content and a `warned`
 * flag for server-side logging.
 */
export function applyWriteGuardrail(content: string): {
  content: string;
  warned: boolean;
} {
  if (hasWriteTool(extractExecutedTools(content))) {
    return { content, warned: false };
  }
  if (!claimsCompletedWrite(content)) {
    return { content, warned: false };
  }
  return { content: `${WARNING}\n\n${content}`, warned: true };
}
