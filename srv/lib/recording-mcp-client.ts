import type {
  CallOptions,
  IMcpClient,
  McpError,
  McpTool,
  McpToolResult,
  Result,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';

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
    const res = await this.inner.callTool(name, args, options);

    const result: McpToolResult = res.ok
      ? res.value
      : { content: res.error?.message ?? String(res.error), isError: true };

    const record: ToolCallRecord = {
      call: { id: '', name, arguments: args },
      result,
    };

    const traceId = options?.trace?.traceId;
    if (traceId) this.deltaFor(traceId).push(record);

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
