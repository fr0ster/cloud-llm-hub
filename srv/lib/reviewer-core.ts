/**
 * Pure deterministic verdict for the reviewer layer: compares what the
 * response CLAIMS to have written against the ACTUAL RESULT of every tool
 * call in the trace (ground truth), not just which tool NAMES ran.
 *
 * Tool-name-only matching false-positives: `CreateDomain` defaults to
 * `activate:true`, so a name match alone cannot tell an activated create from
 * an inactive one (`activate:false`) — the exact ZDEMO_D_MATNR-class bug this
 * redesign fixes. `parseToolOutcome` extracts the envelope
 * (`{success, status, error, message}`) each ABAP tool returns as its
 * `McpToolResult.content`, so the verdict is grounded in what the tool
 * actually reported, not what its name implies.
 */

import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { claimedWriteOps, isWriteTool, type WriteOp } from './write-guardrail';

export type ReviewIssue =
  | {
      kind: 'unverified-write';
      claimedOp: WriteOp;
      reason: string;
    }
  | {
      kind: 'unsupported-claim';
      confidence: 'low' | 'medium' | 'high';
      reasons: string;
    };

export type ReviewVerdict = { ok: true } | { ok: false; issues: ReviewIssue[] };

/** A tool call's result reduced to ground-truth facts: did it succeed, what
 *  status did it report, and what error (if any). */
export type ToolOutcome = {
  name: string;
  ok: boolean;
  status?: string;
  error?: string;
};

/** Best-effort envelope extraction from `McpToolResult.content` — a JSON
 *  string is parsed; a Record is used directly; anything unparseable yields
 *  an empty envelope (never throws). */
function parseEnvelope(
  content: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof content !== 'string') return content ?? {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Ground-truth outcome of a single tool call, from its ACTUAL result — never
 *  from the tool's name. `ok` is false when the MCP layer reported an error
 *  OR the envelope explicitly says `success: false`; a MISSING `success`
 *  field is treated as success (many read tools carry no envelope at all). */
export function parseToolOutcome(record: ToolCallRecord): ToolOutcome {
  const name = record.call.name;
  const mcpError = record.result.isError === true;
  const envelope = parseEnvelope(record.result.content);
  const envelopeSuccess = envelope.success;
  const status =
    typeof envelope.status === 'string' ? envelope.status : undefined;
  const ok = !mcpError && envelopeSuccess !== false;

  if (ok) return { name, ok: true, status };

  const contentText =
    typeof record.result.content === 'string'
      ? record.result.content
      : JSON.stringify(record.result.content);
  const error =
    (typeof envelope.error === 'string' && envelope.error) ||
    (typeof envelope.message === 'string' && envelope.message) ||
    contentText;
  return { name, ok: false, status, error };
}

const CREATE_TOOL = /^(?:Handler)?Create/i;
const UPDATE_TOOL = /^(?:Handler)?Update/i;
const DELETE_TOOL = /^(?:Handler)?Delete/i;
const ACTIVATE_TOOL = /^(?:Handler)?Activate/i;

function opSatisfied(op: WriteOp, outcomes: ToolOutcome[]): boolean {
  switch (op) {
    case 'activated':
      // Activation is proven by EITHER a write tool whose result reports
      // status:'active' (e.g. CreateDomain(activate:true), UpdateTable) OR a
      // successful Activate* tool. The latter is essential because ActivateDomain
      // returns `{success:true, activation:{activated:true}}` with NO `status`
      // field — a status-only check false-flags the create-inactive-then-activate
      // flow (object IS active, but no result carries status:'active').
      return outcomes.some(
        (o) =>
          (o.status === 'active' && isWriteTool(o.name)) ||
          (ACTIVATE_TOOL.test(o.name) && o.ok),
      );
    case 'created':
      return outcomes.some((o) => CREATE_TOOL.test(o.name) && o.ok);
    case 'deleted':
      return outcomes.some((o) => DELETE_TOOL.test(o.name) && o.ok);
    case 'updated':
      return outcomes.some(
        (o) =>
          (UPDATE_TOOL.test(o.name) && o.ok) ||
          (o.status === 'active' && isWriteTool(o.name)),
      );
  }
}

const OP_LABEL: Record<WriteOp, string> = {
  created: '"created"',
  updated: '"updated"',
  deleted: '"deleted"',
  activated: '"activated"',
};

function reasonFor(op: WriteOp, outcomes: ToolOutcome[]): string {
  if (op === 'activated') {
    return `claims ${OP_LABEL[op]} but no successful Activate* tool ran and no tool result shows status:'active'`;
  }
  const familyRe =
    op === 'created'
      ? CREATE_TOOL
      : op === 'deleted'
        ? DELETE_TOOL
        : UPDATE_TOOL;
  const family =
    op === 'created' ? 'Create*' : op === 'deleted' ? 'Delete*' : 'Update*';
  const attempted = outcomes.filter((o) => familyRe.test(o.name));
  if (attempted.length === 0) {
    return `claims ${OP_LABEL[op]} but no successful ${family} tool ran`;
  }
  const failed = attempted.find((o) => !o.ok);
  if (failed) {
    return `write tool ${failed.name} returned error: ${failed.error}`;
  }
  return `claims ${OP_LABEL[op]} but no successful ${family} tool ran`;
}

/**
 * Result-based deterministic verdict: one `ReviewIssue` per claimed write op
 * unsatisfied by the ACTUAL tool-call results. A failed write tool relevant to
 * a claimed op is already surfaced by the per-op rule above (no successful
 * Create/Update/Delete family tool, or no status:active from a write tool),
 * so no separate catch-all is needed — it only added noise for UNRELATED
 * failed writes and mislabeled the op (attributing it to `claims[0]`).
 */
export function evaluateDeterministic(
  content: string,
  records: ToolCallRecord[],
): ReviewVerdict {
  const claims = claimedWriteOps(content);
  if (claims.length === 0) return { ok: true };

  const outcomes = records.map(parseToolOutcome);

  const issues: ReviewIssue[] = [];
  for (const op of claims) {
    if (opSatisfied(op, outcomes)) continue;
    issues.push({
      kind: 'unverified-write',
      claimedOp: op,
      reason: reasonFor(op, outcomes),
    });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
