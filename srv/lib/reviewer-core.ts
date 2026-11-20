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
import { z } from 'zod';
import { isRagWriteTool } from './rag-tool-catalogue';
import type { ToolResultRejection } from './tool-result-cap';
import {
  claimsCompletedRead,
  isWriteTool,
  type WriteOp,
  writeClaimClauses,
} from './write-guardrail';

export type ReviewIssue =
  | {
      kind: 'unverified-write';
      claimedOp: WriteOp;
      reason: string;
    }
  | {
      /**
       * Nothing was called, and the response says it read the system anyway.
       *
       * Conditioned on ZERO tool calls on purpose: a claim to have read
       * something is ordinary prose in almost every other context, and only
       * becomes proof of invention when the record shows nothing was asked of
       * the system at all.
       */
      kind: 'unverified-read';
      reason: string;
    };

export type ReviewVerdict = { ok: true } | { ok: false; issues: ReviewIssue[] };

/** A tool call's result reduced to ground-truth facts: did it succeed, what
 *  status did it report, and what error (if any). */
export type ToolOutcome = {
  name: string;
  ok: boolean;
  rejection?: ToolResultRejection;
  status?: string;
  error?: string;
};

/** Size-limit metadata for the model-visible error result. */
export type RecordedToolCall = ToolCallRecord & {
  rejection?: ToolResultRejection;
};

/** Best-effort envelope extraction from `McpToolResult.content`, robust to the
 *  shapes the MCP client adapter actually produces:
 *   - a JSON string → parsed;
 *   - the core envelope object itself (`{success,status,…}`) → used directly;
 *   - an MCP-wrapped object `{ content: [{type:'text', text:'…json…'}] | '…' }`
 *     → the inner `content` is unwrapped recursively;
 *   - an MCP parts array `[{type:'text', text:'…json…'}]` → the first text part
 *     that parses to an envelope is used.
 *  Anything unrecognized yields an empty envelope (never throws). The adapter
 *  sets `McpToolResult.content = result.result`, so the wrapped/array forms are
 *  what actually arrive — a naive "use the object as-is" misses `status`. */
function parseEnvelope(content: unknown): Record<string, unknown> {
  if (content == null) return {};
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        const env = parseEnvelope((part as { text: string }).text);
        if (Object.keys(env).length > 0) return env;
      }
    }
    return {};
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if ('success' in obj || 'status' in obj) return obj;
    if ('content' in obj) return parseEnvelope(obj.content);
    return obj;
  }
  return {};
}

/** Ground-truth outcome of a single tool call, from its ACTUAL result — never
 *  from the tool's name. `ok` is false when the MCP layer reported an error
 *  OR the envelope explicitly says `success: false`; a MISSING `success`
 *  field is treated as success (many read tools carry no envelope at all). */
export function parseToolOutcome(record: ToolCallRecord): ToolOutcome {
  const name = record.call.name;
  const { rejection } = record as RecordedToolCall;
  const mcpError = record.result.isError === true;
  const envelope = parseEnvelope(record.result.content);
  const envelopeSuccess = envelope.success;
  const status =
    typeof envelope.status === 'string' ? envelope.status : undefined;
  const ok = !mcpError && envelopeSuccess !== false;

  if (ok)
    return { name, ok: true, status, ...(rejection ? { rejection } : {}) };

  const contentText =
    typeof record.result.content === 'string'
      ? record.result.content
      : JSON.stringify(record.result.content);
  const error =
    (typeof envelope.error === 'string' && envelope.error) ||
    (typeof envelope.message === 'string' && envelope.message) ||
    contentText;
  return {
    name,
    ok: false,
    status,
    error,
    ...(rejection ? { rejection } : {}),
  };
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
      //
      // lib 13 answers a successful write with the terse `SUCCESS` and no
      // `status`. A write that asked for `activate: true` is NOT proof: SAP
      // answers OK to the activation request while the activation itself is
      // still running, so neither the write nor lib can know it finished.
      return outcomes.some(
        (o) =>
          (o.ok && o.status === 'active' && isWriteTool(o.name)) ||
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
          (o.ok && o.status === 'active' && isWriteTool(o.name)),
      );
  }
}

const ragWriteResult = z.object({
  collection: z.string().optional(),
  name: z.string().optional(),
  record: z.string().optional(),
  records: z.array(z.string()).optional(),
  id: z.string().optional(),
  created: z.boolean().optional(),
  updated: z.union([z.literal(true), z.number().positive()]).optional(),
  deleted: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const ragWriteArguments = z.object({
  collection: z.string().optional(),
  name: z.string().optional(),
  record: z.string().optional(),
  records: z.array(z.string()).optional(),
  id: z.string().optional(),
  source: z.string().optional(),
  title: z.string().optional(),
  to: z.object({ scope: z.literal('user'), collection: z.string() }).optional(),
});

function ragWriteEvidence(record: ToolCallRecord, outcome: ToolOutcome) {
  const envelope = parseEnvelope(record.result.content);
  const result = ragWriteResult.safeParse(envelope).data;
  const args = ragWriteArguments.safeParse(record.call.arguments).data;
  const persisted = Boolean(result?.records?.length);
  const enabled = result?.enabled;
  const ops = new Set<WriteOp>();
  if (outcome.ok && !envelope.error) {
    if (result?.created || persisted) ops.add('created');
    if (result?.updated || persisted || enabled !== undefined)
      ops.add('updated');
    if (result?.deleted) ops.add('deleted');
    if (enabled === true) ops.add('activated');
  }

  const returnedTargets = [
    ...(result?.records ?? []),
    result?.record,
    result?.id,
    result?.name,
    // A record mutation reports its parent collection as well as its target.
    result?.record === undefined && result?.records === undefined
      ? result?.collection
      : undefined,
    result?.record ? args?.title : undefined,
    result?.updated ? (args?.record ?? args?.source) : undefined,
  ].filter((target): target is string => Boolean(target));
  const attemptedTargets = [
    ...(args?.records ?? []),
    args?.record,
    args?.id,
    args?.title,
    args?.source,
    args?.name,
    args?.to && `${args.to.scope}/${args.to.collection}`,
    args?.record || args?.id || args?.source ? undefined : args?.collection,
  ].filter((target): target is string => Boolean(target));
  return { outcome, ops, returnedTargets, attemptedTargets };
}

/** Match identifiers from the journal within the clause that asserts the write. */
function mentionsTarget(clause: string, target: string): boolean {
  const identifierChar = /[\p{L}\p{N}_-]/u;
  for (
    let start = clause.indexOf(target);
    start !== -1;
    start = clause.indexOf(target, start + target.length)
  ) {
    if (
      !identifierChar.test(clause.charAt(start - 1)) &&
      !identifierChar.test(clause.charAt(start + target.length))
    )
      return true;
  }
  return false;
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
 * Compare claimed operations with the corresponding tool-call results. RAG
 * results support claims that name their targets in the same clause. SAP
 * operations keep the existing tool-family and status checks.
 */
export function evaluateDeterministic(
  content: string,
  records: ToolCallRecord[],
  writeToolOffered = false,
): ReviewVerdict {
  const outcomes = records.map(parseToolOutcome);
  const sapOutcomes = outcomes.filter(
    (outcome) => !isRagWriteTool(outcome.name),
  );
  const ragWrites = records.flatMap((record, index) =>
    isRagWriteTool(record.call.name)
      ? [ragWriteEvidence(record, outcomes[index])]
      : [],
  );

  // Zero calls and a claim to have read the system: the executor cannot have
  // read what it never asked for. Checked BEFORE the write claims, and
  // independently of them — a fabricated read carries no write words, so
  // returning early on "no write claimed" would step straight past it.
  if (outcomes.length === 0 && claimsCompletedRead(content)) {
    return {
      ok: false,
      issues: [
        {
          kind: 'unverified-read',
          reason:
            'claims to have read from the system, but no MCP tool was called at all',
        },
      ],
    };
  }

  if (
    !writeToolOffered &&
    !sapOutcomes.some((outcome) => isWriteTool(outcome.name)) &&
    ragWrites.length === 0
  )
    return { ok: true };

  const issues: ReviewIssue[] = [];
  for (const { clause, ops } of writeClaimClauses(content)) {
    const matchingRagWrites = ragWrites.filter((write) =>
      [...write.returnedTargets, ...write.attemptedTargets].some((target) =>
        mentionsTarget(clause, target),
      ),
    );
    for (const op of ops) {
      if (matchingRagWrites.length === 0 && opSatisfied(op, sapOutcomes))
        continue;
      if (
        matchingRagWrites.some(
          (write) =>
            write.ops.has(op) &&
            write.returnedTargets.some((target) =>
              mentionsTarget(clause, target),
            ),
        )
      )
        continue;
      const failed = matchingRagWrites.find((write) => !write.outcome.ok);
      const reason = failed
        ? `write tool ${failed.outcome.name} returned error: ${failed.outcome.error}`
        : matchingRagWrites.length
          ? `claims ${OP_LABEL[op]} but no successful RAG write result supports the claim`
          : reasonFor(op, sapOutcomes);
      if (
        !issues.some(
          (issue) =>
            issue.kind === 'unverified-write' &&
            issue.claimedOp === op &&
            issue.reason === reason,
        )
      )
        issues.push({ kind: 'unverified-write', claimedOp: op, reason });
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
