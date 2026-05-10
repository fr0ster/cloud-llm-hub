export interface DumpForSignature {
  system?: string;
  dumpId?: string;
  runtimeError?: string;
  exceptionClass?: string;
  program?: string;
  include?: string;
  category?: string;
}

export function computeSignature(
  dump: DumpForSignature,
  fields: string[],
): string {
  return fields
    .map((f) => (dump as Record<string, unknown>)[f] ?? '')
    .map(String)
    .join('|');
}

// Stable Jira label derived from the dump signature — the same value across
// every recurrence of the same root cause. Used as the canonical dedup key
// when searching for an existing Jira ticket. Format: dump-sig-<sha1[0..16]>.
// Truncated SHA-1 keeps the label short and Jira-valid (no whitespace,
// no most punctuation), while collision risk over the dataset is negligible.
import { createHash } from 'node:crypto';
export function signatureLabel(signature: string): string {
  const hash = createHash('sha1').update(signature).digest('hex').slice(0, 16);
  return `dump-sig-${hash}`;
}

// Pure decision function for the discoverer's INSERT algorithm. Owns the
// canonical/slot rules from the spec; production code (CdsDumpRepository)
// pre-fetches the rows and the cached canonical-ticket lifecycle status,
// then calls this. Same function is exercised exhaustively by unit tests so
// the algorithm stays in one place.
//
// Inputs:
//   • canonical: latest jiraStatus='created' row in the group (or null);
//     statusCategoryKey is what the per-tick getIssue cache returned.
//   • slotRowsForCanonicalKey: ALL rows in the same group with
//     jiraIssueKey = canonical.jiraIssueKey, regardless of status. This
//     function decides which statuses count as "slot occupied" for the
//     open vs done branches; SQL stays simple.
export interface InsertDecisionInput {
  canonical: {
    jiraIssueKey: string;
    statusCategoryKey: 'open' | 'done';
  } | null;
  slotRowsForCanonicalKey: Array<{ jiraStatus: string }>;
}

export interface InsertDecisionOutput {
  jiraStatus: 'pending' | 'unheard';
  jiraIssueKey: string | null;
}

const OPEN_BRANCH_SLOT_STATUSES = new Set([
  'pending',
  'failed',
  'commented',
  'unheard',
]);
const CLOSED_BRANCH_SLOT_STATUSES = new Set(['pending', 'failed']);

export function decideJiraInsertStatus(
  input: InsertDecisionInput,
): InsertDecisionOutput {
  const { canonical, slotRowsForCanonicalKey } = input;
  if (canonical === null) {
    // No canonical ticket-creation row in this group — first cycle ever.
    // (First-cycle burst race documented as out-of-scope in the spec.)
    return { jiraStatus: 'pending', jiraIssueKey: null };
  }
  const slotStatuses =
    canonical.statusCategoryKey === 'done'
      ? CLOSED_BRANCH_SLOT_STATUSES
      : OPEN_BRANCH_SLOT_STATUSES;
  const slotTaken = slotRowsForCanonicalKey.some((r) =>
    slotStatuses.has(r.jiraStatus),
  );
  return {
    jiraStatus: slotTaken ? 'unheard' : 'pending',
    jiraIssueKey: canonical.jiraIssueKey,
  };
}

export interface DueDateConfig {
  first: number;
  recurring: number;
  frequent: number;
  low: number;
  high: number;
}

export function dueDateForCount(
  count: number,
  cfg: DueDateConfig,
  today = new Date(),
): string {
  let days: number;
  if (count >= cfg.high) days = cfg.frequent;
  else if (count >= cfg.low) days = cfg.recurring;
  else days = cfg.first;
  const d = new Date(today.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface AssigneeRuleRow {
  priority: number;
  active: boolean;
  system?: string;
  runtimeErrorPattern?: string;
  programPattern?: string;
  categoryPattern?: string;
  assigneeName?: string;
}

export interface DumpForRouting {
  system?: string;
  runtimeError?: string;
  program?: string;
  category?: string;
}

export function matchAssignee(
  dump: DumpForRouting,
  rules: AssigneeRuleRow[],
): string | undefined {
  const matches = rules
    .filter((r) => r.active)
    .filter((r) => !r.system || r.system === dump.system)
    .filter(
      (r) =>
        !r.runtimeErrorPattern ||
        matchesGlob(dump.runtimeError, r.runtimeErrorPattern),
    )
    .filter(
      (r) => !r.programPattern || matchesGlob(dump.program, r.programPattern),
    )
    .filter(
      (r) =>
        !r.categoryPattern || matchesGlob(dump.category, r.categoryPattern),
    )
    .sort((a, b) => a.priority - b.priority);
  const winner = matches[0];
  if (!winner) return undefined;
  return winner.assigneeName && winner.assigneeName.length > 0
    ? winner.assigneeName
    : undefined;
}

function matchesGlob(value: string | undefined, pattern: string): boolean {
  if (value === undefined) return false;
  const re = new RegExp(
    '^' +
      pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
      '$',
  );
  return re.test(value);
}
