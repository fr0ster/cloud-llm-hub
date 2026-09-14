import type {
  CallOptions,
  IMcpClient,
  McpError,
  McpTool,
  McpToolResult,
  Result,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { isWriteTool } from './write-guardrail';

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
    const record: ToolCallRecord & { answered?: boolean } = {
      call: { id: '', name, arguments: args },
      result: { content: '', isError: false },
      answered: false,
    };
    if (traceId) this.deltaFor(traceId).push(record);

    const res = await this.inner.callTool(name, args, options);
    // Reached only when an answer came back. A throw leaves `answered` false,
    // deliberately: we do not know whether SAP applied the change, and a retry
    // here would be a second attempt at it.
    record.result = res.ok
      ? res.value
      : { content: res.error?.message ?? String(res.error), isError: true };
    record.answered = true;
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
