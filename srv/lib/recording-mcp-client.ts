import type {
  CallOptions,
  IMcpClient,
  McpError,
  McpTool,
  McpToolResult,
  Result,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { isOutageError } from './mcp-outage';
import { isWriteTool } from './write-guardrail';

/**
 * `McpClientAdapter.callTool` (`@mcp-abap-adt/llm-agent-mcp`) never rejects: it
 * catches every thrown transport error and RETURNS `{ ok:false, error }` with a
 * code from its own `toMcpError` classifier (error-mapping.js). These three are
 * the ones that mean the call was lost in transit — the connection was gone, no
 * response ever arrived, or it timed out — as opposed to an answered `ok:false`
 * (tool-not-found, invalid-arguments, or any other pre-send refusal, which all
 * map to the default `MCP_ERROR` and are NOT in this set).
 *
 * `toMcpError` can also produce `MCP_HTTP_403` / `MCP_HTTP_404` / `MCP_HTTP_502`
 * / `MCP_HTTP_503` / `MCP_TRANSPORT`. Deliberately excluded: a transport-level
 * 403/404 means the request was rejected or the route did not exist — a
 * definite non-application, not an unknown one — so counting it as "maybe
 * applied" would be its own false alarm.
 */
const TRANSPORT_FAILURE_CODES = new Set([
  'MCP_NOT_CONNECTED',
  'MCP_NO_RESPONSE',
  'MCP_TIMEOUT',
]);

/** True when a returned `ok:false` means the call was lost in transit rather
 *  than answered: one of the transport-failure codes above, or an error
 *  carrying our own outage marker (`McpUnavailableError`, which crosses the
 *  embedded transport as a plain message — see `srv/lib/mcp-outage.ts`). */
function isTransportFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && TRANSPORT_FAILURE_CODES.has(code)) {
    return true;
  }
  return isOutageError(error);
}

/**
 * Transparent decorator around an `IMcpClient` that captures every executed
 * tool call WITH its result (ground truth for the honesty reviewer), keyed by
 * `options.trace.traceId`. Tool results can be large or sensitive (ABAP
 * source, dumps) and destination handles are long-lived, so records are kept
 * ONLY per-`requestId` delta — there is deliberately NO cumulative/session
 * bucket. A call made without a `trace.traceId` retains nothing.
 *
 * Deliberately dumb: it does NOT parse or interpret `McpToolResult.content` —
 * that belongs to the reviewer (a later step). It only ever forwards the
 * inner client's `Result` unchanged; never swallows or reshapes errors.
 */
export class RecordingMcpClient implements IMcpClient {
  private readonly deltas = new Map<string, ToolCallRecord[]>();

  /** Present iff `inner` implements it, so callers relying on `?.` see the
   *  same optionality the inner client exposes. */
  readonly healthCheck?: (
    options?: CallOptions,
  ) => Promise<Result<boolean, McpError>>;

  constructor(private readonly inner: IMcpClient) {
    if (inner.healthCheck) {
      this.healthCheck = (options?: CallOptions) =>
        inner.healthCheck?.(options) as Promise<Result<boolean, McpError>>;
    }
  }

  listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
    return this.inner.listTools(options);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
    const traceId = options?.trace?.traceId;
    // Opened BEFORE the call, so "sent, unanswered" is a state the error path
    // can read rather than an absence it has to infer. Written after the await,
    // a thrown transport error leaves nothing at all.
    //
    // `isError: true` on the placeholder — not `false` — because this record
    // can be read (by `getToolRecords`, hence by the reviewer) BEFORE it is
    // ever overwritten: while still in flight, or forever if the call never
    // settles. An empty `content` with `isError:false` parses as a SUCCESSFUL
    // write to `reviewer-core.ts`'s `parseToolOutcome` (a missing envelope
    // `success` field defaults to success), which would let a never-answered
    // CreateClass satisfy a "created" claim and suppress its own
    // UNVERIFIED_WRITE notice. `isError:true` keeps the placeholder read as
    // "not (yet) a success", which is the only honest default.
    const record: ToolCallRecord & { answered?: boolean } = {
      call: { id: '', name, arguments: args },
      result: { content: '', isError: true },
      answered: false,
    };
    if (traceId) this.deltaFor(traceId).push(record);

    const res = await this.inner.callTool(name, args, options);
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
    record.answered = res.ok || !isTransportFailure(res.error);
    return res;
  }

  private deltaFor(traceId: string): ToolCallRecord[] {
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
   * Writes only. An unanswered `ReadClass` is a lost answer and nothing more;
   * reporting it as possibly-applied would teach a planner to distrust reads
   * and to re-check objects nothing touched. `isWriteTool` is the same
   * classifier the write guardrail already uses, so the two cannot drift.
   */
  unanswered(traceId: string): ToolCallRecord[] {
    return (this.deltas.get(traceId) ?? []).filter(
      (r) =>
        (r as ToolCallRecord & { answered?: boolean }).answered !== true &&
        isWriteTool(r.call.name),
    );
  }

  /** Tool-call records for `requestId`'s delta. No id (or an unknown id)
   *  yields `[]` — there is no cumulative/session-wide fallback. */
  getToolRecords(requestId?: string): ToolCallRecord[] {
    return requestId ? [...(this.deltas.get(requestId) ?? [])] : [];
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
