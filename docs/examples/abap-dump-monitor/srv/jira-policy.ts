export interface DumpForSignature {
  system?: string;
  dumpId?: string;
  runtimeError?: string;
  exceptionClass?: string;
  program?: string;
  include?: string;
  category?: string;
}

export function computeSignature(dump: DumpForSignature, fields: string[]): string {
  return fields.map(f => (dump as Record<string, unknown>)[f] ?? '').map(String).join('|');
}

export interface DueDateConfig {
  first: number; recurring: number; frequent: number; low: number; high: number;
}

export function dueDateForCount(count: number, cfg: DueDateConfig, today = new Date()): string {
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

export function matchAssignee(dump: DumpForRouting, rules: AssigneeRuleRow[]): string | undefined {
  const matches = rules
    .filter(r => r.active)
    .filter(r => !r.system || r.system === dump.system)
    .filter(r => !r.runtimeErrorPattern || matchesGlob(dump.runtimeError, r.runtimeErrorPattern))
    .filter(r => !r.programPattern || matchesGlob(dump.program, r.programPattern))
    .filter(r => !r.categoryPattern || matchesGlob(dump.category, r.categoryPattern))
    .sort((a, b) => a.priority - b.priority);
  const winner = matches[0];
  if (!winner) return undefined;
  return winner.assigneeName && winner.assigneeName.length > 0 ? winner.assigneeName : undefined;
}

function matchesGlob(value: string | undefined, pattern: string): boolean {
  if (value === undefined) return false;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(value);
}
