import { randomUUID } from 'node:crypto';
import type {
  CallOptions,
  IMcpClient,
  McpError,
  McpTool,
  McpToolResult,
  Result,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { parseToolResultMaxChars } from '../agent-config';
import {
  getRagCallerIdentity,
  isReadOnlyTools,
  profileToolAllowed,
} from '../request-session';
import { compositeMcpClient } from './composite-mcp-client';
import {
  allowsReadOnlyEffect,
  isDialogueRagWorker,
  isDialogueResultReader,
} from './dialogue-rag-scope';
import { isOutageError } from './mcp-outage';
import { isRagTool, isRagWriteTool, ragToolEffect } from './rag-tool-catalogue';
import {
  isReadOnlyTool,
  type ToolEffectAnnotations,
} from './tool-authorization';
import type { JournalEntry, JournalSystem } from './tool-journal';
import { toolObjects } from './tool-objects';
import { capToolResult, withinToolResultBudget } from './tool-result-cap';
import { isUserMcpName } from './user-mcp-names';
import type { UserMcpClient } from './user-mcp-tools';
import { reportWorkerActivity } from './worker-activity';
import { isWriteTool } from './write-guardrail';

/**
 * `McpClientAdapter.callTool` (`@mcp-abap-adt/llm-agent-mcp`) never rejects: it
 * catches every thrown transport error and RETURNS `{ ok:false, error }` with a
 * code from its own `toMcpError` classifier (error-mapping.js), matching the
 * library's own `MCP_UNAVAILABLE_CODES`
 * (`@mcp-abap-adt/llm-agent`'s `interfaces/types.js`). These six mean the call
 * was lost in transit — the connection was gone, no response ever arrived, it
 * timed out, or the request reached SAP and the ANSWER was lost on the way
 * back (a transport-level 502/503/other transport error) — as opposed to an
 * answered `ok:false` (tool-not-found, invalid-arguments, or any other
 * pre-send refusal, which all map to the default `MCP_ERROR` and are NOT in
 * this set).
 *
 * `MCP_HTTP_403` / `MCP_HTTP_404` are deliberately excluded even though the
 * library's own `MCP_UNAVAILABLE_CODES` includes them: a transport-level
 * 403/404 means the endpoint REFUSED the request or the route did not exist
 * BEFORE any write ran — a definite non-application, not an unknown one — so
 * counting it as "maybe applied" would be its own false alarm.
 */
const TRANSPORT_FAILURE_CODES = new Set([
  'MCP_NOT_CONNECTED',
  'MCP_NO_RESPONSE',
  'MCP_TIMEOUT',
  'MCP_TRANSPORT',
  'MCP_HTTP_502',
  'MCP_HTTP_503',
]);

/** True when a returned `ok:false` means the call was lost in transit rather
 *  than answered: one of the transport-failure codes above, or an error
 *  carrying our own outage marker (`McpUnavailableError`, which crosses the
 *  embedded transport as a plain message — see `srv/lib/mcp-outage.ts`). */
function isTransportFailure(error: McpError): boolean {
  const code = error?.code;
  if (typeof code === 'string' && TRANSPORT_FAILURE_CODES.has(code)) {
    return true;
  }
  return isOutageError(error);
}

/**
 * Transparent decorator around an `IMcpClient` that captures every executed
 * tool call WITH its result (the tool journal), keyed by
 * `options.trace.traceId`. Tool results can be large or sensitive (ABAP
 * source, dumps) and destination handles are long-lived, so records are kept
 * ONLY per-`requestId` delta — there is deliberately NO cumulative/session
 * bucket. A call made without a `trace.traceId` retains nothing.
 *
 * Preserves the uncapped tool result before capping oversized model-visible
 * content and otherwise forwards the inner client's `Result` unchanged;
 * never swallows or reshapes errors.
 */
export class RecordingMcpClient implements IMcpClient {
  private readonly knownNames: Set<string>;
  private readonly deltas: Map<string, JournalEntry[]>;
  private readonly definitions: Map<string, McpTool>;
  private readonly uncappedResults: WeakMap<ToolCallRecord, McpToolResult>;
  /** Present iff `inner` implements it, so callers relying on `?.` see the
   *  same optionality the inner client exposes. */
  readonly healthCheck?: (
    options?: CallOptions,
  ) => Promise<Result<boolean, McpError>>;

  constructor(
    private readonly inner: IMcpClient,
    private readonly expositionFor?: (name: string) => string | undefined,
    private readonly maxChars = parseToolResultMaxChars(),
    // Planner clients emit capped results without retaining journal entries.
    private readonly retainRecords = true,
    // A view shares its origin's records: one journal per request.
    shared?: RecordingMcpClient,
    private readonly userMcp?: UserMcpClient,
  ) {
    this.definitions = shared?.definitions ?? new Map();
    this.knownNames = shared?.knownNames ?? new Set<string>();
    this.deltas = shared?.deltas ?? new Map<string, JournalEntry[]>();
    this.uncappedResults = shared?.uncappedResults ?? new WeakMap();
    if (inner.healthCheck) {
      this.healthCheck = (options?: CallOptions) =>
        inner.healthCheck?.(options) as Promise<Result<boolean, McpError>>;
    }
  }

  get cacheable(): boolean | undefined {
    return this.inner.cacheable;
  }

  /**
   * A view over more clients that records into this recorder's deltas. Never
   * mutates this instance: the recorder is shared by every build for a
   * destination, so extending it in place would nest clients per request.
   */
  includeClients(
    clients: IMcpClient[],
    userMcp = this.userMcp,
  ): RecordingMcpClient {
    if (!clients.length && !userMcp) return this;
    return new RecordingMcpClient(
      compositeMcpClient([...clients, this.inner], userMcp),
      this.expositionFor,
      this.maxChars,
      this.retainRecords,
      this,
      userMcp,
    );
  }
  async listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
    const result = await this.inner.listTools(options);
    if (!result.ok) return result;
    for (const tool of result.value) {
      if (isUserMcpName(tool.name)) continue;
      this.knownNames.add(tool.name);
      this.definitions.set(tool.name, tool);
    }
    const value = result.value.filter(
      (tool) =>
        (profileToolAllowed(tool.name) || isDialogueResultReader(tool.name)) &&
        (!isReadOnlyTools() || this.isReadOnly(tool)),
    );
    return value.length === result.value.length ? result : { ok: true, value };
  }

  private isReadOnly(tool: McpTool): boolean {
    if (isUserMcpName(tool.name))
      return this.userMcp?.resolveTool(tool.name)?.effect === 'read';
    if (isRagTool(tool.name))
      return allowsReadOnlyEffect(ragToolEffect(tool.name));
    return isReadOnlyTool(
      tool.name,
      (tool as McpTool & { annotations?: ToolEffectAnnotations }).annotations,
    );
  }

  async callTool(
    name: string,
    args: Parameters<IMcpClient['callTool']>[1],
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
    if (!profileToolAllowed(name) && !isDialogueResultReader(name))
      return {
        ok: true,
        value: { isError: true, content: `TOOL_FORBIDDEN: ${name}` },
      };
    if (isReadOnlyTools()) {
      const tools = await this.inner.listTools(options);
      const allowed =
        tools.ok &&
        tools.value.some((tool) => tool.name === name && this.isReadOnly(tool));
      if (!allowed)
        return {
          ok: true,
          value: {
            content: `Tool "${name}" was not executed: checker tools are read-only.`,
            isError: true,
          },
        };
    }
    const traceId = options?.trace?.traceId;
    // Start the journal entry before dispatch so an in-flight write remains unconfirmed.
    const userTool = this.userMcp?.resolveTool(name);
    let system: JournalSystem | undefined;
    if (userTool) system = 'user-mcp';
    else if (isRagTool(name)) system = 'rag';
    else if (
      this.expositionFor?.(name) !== undefined ||
      Object.hasOwn(toolObjects, name)
    )
      system = 'sap';
    const tool = this.definitions.get(name);
    const record: JournalEntry = {
      call: { id: randomUUID(), name, arguments: args },
      result: { content: 'no answer yet', isError: true },
      answered: false,
      system,
      ...(system === 'rag' && isDialogueRagWorker() && name !== 'rag_persist'
        ? { ragScope: 'session' as const }
        : {}),
      write: userTool
        ? userTool.effect === 'write'
        : system === 'rag'
          ? isRagWriteTool(name)
          : system === 'sap' &&
            (tool ? !this.isReadOnly(tool) : isWriteTool(name)),
    };
    if (traceId && this.retainRecords) this.deltaFor(traceId).push(record);

    reportWorkerActivity(`tool ${name}`);
    let res = await withinToolResultBudget(this.maxChars, () =>
      this.inner.callTool(name, args, options),
    );
    if (res.ok) {
      const capped = capToolResult(
        res.value,
        this.maxChars,
        name,
        this.knownNames.has(name),
      );
      if (capped.rejection) {
        if (traceId && this.retainRecords)
          this.uncappedResults.set(record, res.value);
        record.rejection = capped.rejection;
        res = { ...res, value: capped.result };
      }
    }
    // Reached only when an answer came back — including an ANSWERED `ok:false`
    // (the adapter never throws; see `isTransportFailure` above). A THROWN
    // error (a raw inner client, or a future adapter that does reject) skips
    // straight to `return`, leaving `answered` false: we do not know whether
    // SAP applied the change, and a retry here would be a second attempt at
    // it. A RETURNED `ok:false` is only unanswered when it is transport-class;
    // a tool-not-found / invalid-arguments / other pre-send refusal reached
    // the adapter and got a definite "no", so it counts as answered.
    record.result = res.ok
      ? res.value
      : { content: res.error?.message ?? String(res.error), isError: true };
    record.answered =
      res.ok ||
      (system === 'user-mcp'
        ? res.error.code !== 'USER_MCP_OUTCOME_UNKNOWN'
        : !isTransportFailure(res.error));
    if (isRagTool(name)) getRagCallerIdentity().onToolResult?.(record);
    return res;
  }

  private deltaFor(traceId: string): JournalEntry[] {
    let bucket = this.deltas.get(traceId);
    if (!bucket) {
      bucket = [];
      this.deltas.set(traceId, bucket);
    }
    return bucket;
  }

  /**
   * Writes dispatched under this trace that never received an answer.
   *
   * Writes only. An unanswered `GetClass` is a lost answer and nothing more;
   * reporting it as possibly-applied would teach a planner to distrust reads
   * and to re-check objects nothing touched. `isWriteTool` is the same
   * fallback for transport failures before tool discovery.
   */
  unanswered(traceId: string): ToolCallRecord[] {
    return (this.deltas.get(traceId) ?? []).filter(
      (r) => !r.answered && (r.write || isWriteTool(r.call.name)),
    );
  }

  /** Tool-call records for `requestId`'s delta. No id (or an unknown id)
   *  yields `[]` — there is no cumulative/session-wide fallback. */
  getToolRecords(requestId?: string): JournalEntry[] {
    return requestId ? [...(this.deltas.get(requestId) ?? [])] : [];
  }

  /** Review evidence includes the result before model-facing size rejection. */
  getToolJournal(requestId?: string): JournalEntry[] {
    return this.getToolRecords(requestId).map((record) => ({
      ...record,
      result: this.uncappedResults.get(record) ?? record.result,
    }));
  }

  /** Frees `requestId`'s delta bucket. */
  dropRequest(requestId?: string): void {
    if (!requestId) return;
    this.deltas.delete(requestId);
  }

  reset(): void {
    this.deltas.clear();
  }
}
