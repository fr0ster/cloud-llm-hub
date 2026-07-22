import type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  RequestSummary,
  TokenBucket,
  TokenCategory,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';

/**
 * Component → token category mapping. Mirrors
 * `@mcp-abap-adt/llm-agent-libs`'s `SessionRequestLogger`/`DefaultRequestLogger`
 * `CATEGORY_MAP` so `byCategory` categorizes identically; kept as a local
 * literal (not imported) because the libs package does not re-export it from
 * its public entry point. Typed `Record<string, ...>` (not
 * `Record<LlmComponent, ...>`) + a fallback at the lookup site so a NEW
 * `LlmComponent` added upstream can never break our build — it just falls back.
 */
const CATEGORY_MAP: Record<string, TokenCategory> = {
  'tool-loop': 'request',
  classifier: 'auxiliary',
  'tool-definer': 'auxiliary',
  translate: 'auxiliary',
  'query-expander': 'auxiliary',
  helper: 'auxiliary',
  embedding: 'initialization',
  planner: 'auxiliary',
  evaluator: 'auxiliary',
  executor: 'request',
  reviewer: 'auxiliary',
  finalizer: 'auxiliary',
  oracle: 'auxiliary',
};

interface Bucket {
  llm: LlmCallEntry[];
  toolNames: string[];
  ragCount: number;
}

function emptyBucket(): Bucket {
  return { llm: [], toolNames: [], ragCount: 0 };
}

function zeroTokenBucket(): TokenBucket {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
}

function aggregate(bucket: Bucket): RequestSummary {
  const totals = zeroTokenBucket();
  const byModel: Record<string, TokenBucket> = {};
  const byComponent: Record<string, TokenBucket> = {};
  const byCategory: Record<string, TokenBucket> = {};
  let totalDurationMs = 0;

  for (const call of bucket.llm) {
    totalDurationMs += call.durationMs;

    totals.promptTokens += call.promptTokens;
    totals.completionTokens += call.completionTokens;
    totals.totalTokens += call.totalTokens;
    totals.requests++;

    byModel[call.model] ??= zeroTokenBucket();
    const m = byModel[call.model];
    m.promptTokens += call.promptTokens;
    m.completionTokens += call.completionTokens;
    m.totalTokens += call.totalTokens;
    m.requests++;

    byComponent[call.component] ??= zeroTokenBucket();
    const comp = byComponent[call.component];
    comp.promptTokens += call.promptTokens;
    comp.completionTokens += call.completionTokens;
    comp.totalTokens += call.totalTokens;
    comp.requests++;

    const catKey = CATEGORY_MAP[call.component] ?? 'request';
    byCategory[catKey] ??= zeroTokenBucket();
    const cat = byCategory[catKey];
    cat.promptTokens += call.promptTokens;
    cat.completionTokens += call.completionTokens;
    cat.totalTokens += call.totalTokens;
    cat.requests++;
  }

  return {
    totals,
    byModel,
    byComponent,
    byCategory,
    ragQueries: bucket.ragCount,
    toolCalls: bucket.toolNames.length,
    totalDurationMs,
  };
}

/**
 * Self-contained per-trace `IRequestLogger`. Owns a session-cumulative bucket
 * AND per-`requestId` delta buckets — it does NOT wrap or delegate to another
 * logger.
 *
 * Mirrors `@mcp-abap-adt/llm-agent-libs`'s `SessionRequestLogger` exactly
 * (nested-safe: `startRequest` depth-counts and creates the delta only if
 * absent, never clearing; `endRequest` only depth-counts down; `dropRequest`
 * is the explicit free). `DefaultRequestLogger` (the builder default) clears
 * its arrays on every `startRequest` and ignores `requestId`, so a nested
 * worker call wipes the coordinator's telemetry and concurrent requests mix —
 * unusable for controller→worker delegation. `SessionRequestLogger` has the
 * right semantics but is not exported from the package, hence this
 * self-contained re-implementation plus the added `executedToolNames`.
 */
export class RecordingRequestLogger implements IRequestLogger {
  private readonly cumulative: Bucket = emptyBucket();
  private readonly deltas = new Map<string, Bucket>();
  private readonly depth = new Map<string, number>();

  private deltaFor(requestId: string): Bucket {
    let bucket = this.deltas.get(requestId);
    if (!bucket) {
      bucket = emptyBucket();
      this.deltas.set(requestId, bucket);
    }
    return bucket;
  }

  logLlmCall(entry: LlmCallEntry): void {
    this.cumulative.llm.push(entry);
    if (entry.requestId) this.deltaFor(entry.requestId).llm.push(entry);
  }

  logRagQuery(entry: RagQueryEntry & { requestId?: string }): void {
    this.cumulative.ragCount++;
    if (entry.requestId) this.deltaFor(entry.requestId).ragCount++;
  }

  logToolCall(entry: ToolCallEntry & { requestId?: string }): void {
    this.cumulative.toolNames.push(entry.toolName);
    if (entry.requestId)
      this.deltaFor(entry.requestId).toolNames.push(entry.toolName);
  }

  startRequest(requestId?: string): void {
    if (!requestId) return;
    this.depth.set(requestId, (this.depth.get(requestId) ?? 0) + 1);
    if (!this.deltas.has(requestId)) this.deltas.set(requestId, emptyBucket());
  }

  endRequest(requestId?: string): void {
    if (!requestId) return;
    const d = this.depth.get(requestId);
    if (d === undefined) return;
    if (d <= 1) this.depth.delete(requestId);
    else this.depth.set(requestId, d - 1);
    // Intentionally does NOT delete the delta bucket: the top-level owner
    // frees it explicitly via dropRequest() after reading the summary.
  }

  dropRequest(requestId?: string): void {
    if (!requestId) return;
    this.deltas.delete(requestId);
    this.depth.delete(requestId);
  }

  getSummary(requestId?: string): RequestSummary {
    if (requestId)
      return aggregate(this.deltas.get(requestId) ?? emptyBucket());
    return aggregate(this.cumulative);
  }

  /** Tool names executed under `requestId`'s delta, or under the whole
   *  session (cumulative) when no id is given. */
  executedToolNames(requestId?: string): string[] {
    if (requestId) return [...(this.deltas.get(requestId)?.toolNames ?? [])];
    return [...this.cumulative.toolNames];
  }

  reset(): void {
    this.cumulative.llm.length = 0;
    this.cumulative.toolNames.length = 0;
    this.cumulative.ragCount = 0;
    this.deltas.clear();
    this.depth.clear();
  }
}
