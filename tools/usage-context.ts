/**
 * Analyse LLM context sizes in an administrator's downloaded usage SQLite file.
 *
 * Groups calls by role, model and component, with per-session retrieval sizes.
 * Msg KB counts message characters; Ctx KB adds separate tool definition characters.
 * KB means characters / 1024, not bytes. Part tokens are proportional estimates.
 * USAGE_RECORDS.at stores INTEGER epoch milliseconds.
 * Percentiles use the nearest-rank method; missing numeric counters count as zero.
 *
 *   npm run usage:context -- usage.sqlite
 *   npm run usage:context -- usage.sqlite --session ls-123 --calls
 *   npm run usage:context -- usage.sqlite --since 2026-10-01T00:00:00Z --json
 */
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface UsageRow {
  at: number;
  kind: string;
  session_id: string | null;
  role: string | null;
  record_json: string;
}
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function number(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
function string(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}
export interface Parts {
  system: number;
  user: number;
  assistant: number;
  toolResults: number;
  toolDefinitions: number;
}
export interface ContextRecord {
  kind: string;
  at: string;
  session: string;
  request: string;
  turn: string;
  role: string;
  model: string;
  component: string;
  inputTokens: number;
  outputTokens: number;
  inputChars: number;
  parts: Parts;
  injections: number;
  chunks: number;
  retrievalChars: number;
}
export interface ParsedRecords {
  records: ContextRecord[];
  malformedRows: number;
}
export function parseRecords(rows: readonly UsageRow[]): ParsedRecords {
  const records: ContextRecord[] = [];
  let malformedRows = 0;
  for (const row of rows) {
    try {
      const value: unknown = JSON.parse(row.record_json);
      if (!object(value)) {
        malformedRows++;
        continue;
      }
      const context = object(value.context) ? value.context : {};
      const values = object(value.values) ? value.values : {};
      const parts: Parts = {
        system: number(value.systemChars),
        user: number(value.userChars),
        assistant: number(value.assistantChars),
        toolResults: number(value.toolChars),
        toolDefinitions: number(value.toolDefsChars),
      };
      records.push({
        kind: row.kind,
        at: new Date(row.at).toISOString(),
        session: row.session_id ?? (string(context.sessionId) || '(none)'),
        request: string(context.requestId) || '(none)',
        turn: string(context.turnId) || '(none)',
        role: row.role ?? (string(context.role) || '(none)'),
        model: string(value.model) || '(none)',
        component: string(context.component) || '(none)',
        inputTokens: number(value.inputTokens),
        outputTokens: number(value.outputTokens),
        inputChars:
          typeof value.inputChars === 'number'
            ? number(value.inputChars)
            : parts.system + parts.user + parts.assistant + parts.toolResults,
        parts,
        injections: values.injected === true ? 1 : number(values.injected),
        chunks: number(values.chunks),
        retrievalChars: number(values.chars),
      });
    } catch {
      malformedRows++;
    }
  }
  return { records, malformedRows };
}
export interface Filters {
  session?: string;
  since?: string;
}
export function isValidSince(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return false;
  if (match[4] !== undefined) {
    if (
      Number(match[4]) > 23 ||
      Number(match[5]) > 59 ||
      Number(match[6] ?? 0) > 59
    )
      return false;
    const zone = match[8];
    if (
      zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
    )
      return false;
  }
  return Number.isFinite(Date.parse(value));
}
export function loadRecords(
  file: string,
  filters: Filters = {},
): ParsedRecords {
  if (filters.since !== undefined && !isValidSince(filters.since))
    throw new Error('Invalid --since ISO date');
  const conditions = ["kind IN ('llm.call', 'x.hub.retrieval')"];
  const parameters: (string | number)[] = [];
  if (filters.session) {
    conditions.push("session_id LIKE ? ESCAPE '\\' COLLATE BINARY");
    parameters.push(`${filters.session.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (filters.since !== undefined) {
    // Keep malformed timestamps in the stream so they are counted below.
    conditions.push("(typeof(at) != 'integer' OR at >= ?)");
    parameters.push(Date.parse(filters.since));
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const records: ContextRecord[] = [];
    // Match the case-sensitive literal prefix semantics of startsWith().
    db.exec('PRAGMA case_sensitive_like = ON');
    let malformedRows = 0;
    for (const row of db
      .prepare(
        `SELECT at, typeof(at) AS at_type, kind, session_id, role, record_json FROM USAGE_RECORDS WHERE ${conditions.join(' AND ')} ORDER BY at, id`,
      )
      .iterate(...parameters)) {
      if (
        row.at_type !== 'integer' ||
        typeof row.at !== 'number' ||
        typeof row.kind !== 'string' ||
        (row.session_id !== null && typeof row.session_id !== 'string') ||
        (row.role !== null && typeof row.role !== 'string') ||
        typeof row.record_json !== 'string'
      ) {
        malformedRows++;
        continue;
      }
      const parsed = parseRecords([
        {
          at: row.at,
          kind: row.kind,
          session_id: row.session_id,
          role: row.role,
          record_json: row.record_json,
        },
      ]);
      records.push(...parsed.records);
      malformedRows += parsed.malformedRows;
    }
    return { records, malformedRows };
  } finally {
    db.close();
  }
}
export function percentile(
  values: readonly number[],
  fraction: number,
): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.max(
      0,
      Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1),
    )
  ];
}
export interface Stats {
  avg: number;
  p50: number;
  p95: number;
  max: number;
  sum: number;
}
function stats(values: number[]): Stats {
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    avg: values.length ? sum / values.length : 0,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: percentile(values, 1),
    sum,
  };
}
export interface CallSummary {
  calls: number;
  inputTokens: Stats;
  outputTokens: number;
  messageKB: Stats;
  contextKB: Stats;
  averagePartKB: Parts;
  averageEstimatedPartTokens: Parts;
}
const partNames: (keyof Parts)[] = [
  'system',
  'user',
  'assistant',
  'toolResults',
  'toolDefinitions',
];
function summarize(calls: ContextRecord[]): CallSummary {
  const kb: Parts = {
    system: 0,
    user: 0,
    assistant: 0,
    toolResults: 0,
    toolDefinitions: 0,
  };
  const tokens: Parts = { ...kb };
  for (const call of calls) {
    const chars = Object.values(call.parts).reduce((a, b) => a + b, 0);
    for (const part of partNames) {
      kb[part] += call.parts[part] / 1024 / calls.length;
      tokens[part] += chars
        ? (call.inputTokens * call.parts[part]) / chars / calls.length
        : 0;
    }
  }
  return {
    calls: calls.length,
    inputTokens: stats(calls.map((c) => c.inputTokens)),
    outputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
    messageKB: stats(calls.map((c) => c.inputChars / 1024)),
    contextKB: stats(
      calls.map((c) => (c.inputChars + c.parts.toolDefinitions) / 1024),
    ),
    averagePartKB: kb,
    averageEstimatedPartTokens: tokens,
  };
}
export function aggregate(parsed: ParsedRecords) {
  const calls = parsed.records.filter((r) => r.kind === 'llm.call');
  const groups = new Map<string, ContextRecord[]>();
  for (const call of calls) {
    const key = JSON.stringify([call.role, call.model, call.component]);
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }
  const sessions = [...new Set(parsed.records.map((r) => r.session))].sort();
  return {
    malformedRows: parsed.malformedRows,
    groups: [...groups.values()].map((group) => ({
      role: group[0].role,
      model: group[0].model,
      component: group[0].component,
      ...summarize(group),
    })),
    retrieval: sessions.map((session) => {
      const records = parsed.records.filter(
        (r) =>
          r.session === session &&
          r.kind === 'x.hub.retrieval' &&
          r.injections > 0,
      );
      const sizes = stats(records.map((r) => r.retrievalChars / 1024));
      return {
        session,
        injections: records.reduce((sum, r) => sum + r.injections, 0),
        avgChunks: stats(records.map((r) => r.chunks)).avg,
        avgKB: sizes.avg,
        maxKB: sizes.max,
      };
    }),
    total: summarize(calls),
  };
}
function table(rows: string[][]): string {
  const widths = rows[0].map(() => 0);
  for (const row of rows) {
    for (let i = 0; i < widths.length; i++) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
function metrics(summary: CallSummary): string[] {
  const t = summary.inputTokens;
  const m = summary.messageKB;
  const k = summary.contextKB;
  return [
    String(summary.calls),
    ...[
      t.avg,
      t.p50,
      t.p95,
      t.max,
      t.sum,
      summary.outputTokens,
      m.sum,
      m.avg,
      m.p95,
      m.max,
      k.sum,
      k.avg,
      k.p95,
      k.max,
    ].map((n) => n.toFixed(1)),
  ];
}
export function formatSummary(summary: ReturnType<typeof aggregate>): string {
  const rows = [
    [
      'Role',
      'Model',
      'Component',
      'Calls',
      'In avg',
      'p50',
      'p95',
      'max',
      'sum',
      'Out sum',
      'Msg KB total',
      'Msg KB avg',
      'p95',
      'max',
      'Ctx KB total',
      'Ctx KB avg',
      'p95',
      'max',
    ],
  ];
  for (const group of summary.groups)
    rows.push([group.role, group.model, group.component, ...metrics(group)]);
  rows.push(['TOTAL', '', '', ...metrics(summary.total)]);
  const parts = [['Average part', ...partNames]];
  for (const group of [
    ...summary.groups,
    { role: 'TOTAL', model: '', component: '', ...summary.total },
  ]) {
    const label = [group.role, group.model, group.component]
      .filter(Boolean)
      .join(' / ');
    parts.push([
      `${label} KB`,
      ...partNames.map((p) => group.averagePartKB[p].toFixed(1)),
    ]);
    parts.push([
      `${label} ≈ tokens`,
      ...partNames.map((p) => group.averageEstimatedPartTokens[p].toFixed(1)),
    ]);
  }
  const retrieval = [
    ['Retrieval session', 'Injections', 'Avg chunks', 'Avg KB', 'Max KB'],
    ...summary.retrieval.map((r) => [
      r.session,
      String(r.injections),
      r.avgChunks.toFixed(1),
      r.avgKB.toFixed(1),
      r.maxKB.toFixed(1),
    ]),
  ];
  return `KB = characters / 1024 (not bytes); ≈ tokens split proportionally by part characters.\n${table(rows)}\n\n${table(parts)}\n\n${table(retrieval)}\nMalformed rows skipped: ${summary.malformedRows}`;
}
export function formatCalls(records: ContextRecord[]): string {
  const groups = new Map<string, ContextRecord[]>();
  for (const call of records.filter((r) => r.kind === 'llm.call')) {
    const key = `Session ${call.session} / request ${call.request}`;
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }
  return [...groups]
    .map(
      ([label, calls]) =>
        `${label}\n${table([
          [
            'At',
            'Turn',
            'Role',
            'Model',
            'Component',
            'In',
            'Out',
            'Msg KB',
            'Ctx KB',
            'Sys KB',
            'User KB',
            'Asst KB',
            'Tool KB',
            'Defs KB',
          ],
          ...calls.map((c) => [
            c.at.slice(11, 19),
            c.turn.slice(0, 8),
            c.role,
            c.model.replace(/^anthropic--/, ''),
            c.component,
            String(c.inputTokens),
            String(c.outputTokens),
            (c.inputChars / 1024).toFixed(1),
            ((c.inputChars + c.parts.toolDefinitions) / 1024).toFixed(1),
            ...partNames.map((p) => (c.parts[p] / 1024).toFixed(1)),
          ]),
        ])}`,
    )
    .join('\n\n');
}
export function groupCalls(records: ContextRecord[]) {
  const groups = new Map<
    string,
    {
      sessionId: string;
      requestId: string;
      turnId: string;
      records: (ContextRecord & { messageKB: number; contextKB: number })[];
    }
  >();
  for (const call of records) {
    if (call.kind !== 'llm.call') continue;
    const key = JSON.stringify([call.session, call.request, call.turn]);
    const group = groups.get(key) ?? {
      sessionId: call.session,
      requestId: call.request,
      turnId: call.turn,
      records: [],
    };
    group.records.push({
      ...call,
      messageKB: call.inputChars / 1024,
      contextKB: (call.inputChars + call.parts.toolDefinitions) / 1024,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function main(args: string[]): void {
  const file = args[0];
  if (!file || file.startsWith('--'))
    throw new Error(
      'Usage: npm run usage:context -- <db.sqlite> [--session <prefix>] [--since <ISO>] [--calls] [--json]',
    );
  const filters: Filters = {};
  let calls = false;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--calls') calls = true;
    else if (flag === '--json') json = true;
    else if (flag === '--session' || flag === '--since') {
      const value = args[++i];
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${flag}`);
      if (flag === '--session') filters.session = value;
      else {
        if (!isValidSince(value)) throw new Error('Invalid --since ISO date');
        filters.since = value;
      }
    } else throw new Error(`Unexpected argument: ${flag}`);
  }
  const parsed = loadRecords(resolve(file), filters);
  const summary = aggregate(parsed);
  console.log(
    json
      ? JSON.stringify(
          calls ? { summary, calls: groupCalls(parsed.records) } : summary,
          null,
          2,
        )
      : formatSummary(summary),
  );
  if (calls && !json) console.log(`\n${formatCalls(parsed.records)}`);
}
// The repository compiles tools as CommonJS; importing this module never runs the CLI.
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(
      error instanceof Error ? error.message : 'Usage analysis failed',
    );
    process.exitCode = 1;
  }
}
