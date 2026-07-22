/**
 * `IFinalizer` that runs the honesty reviewer over the executor's output and,
 * on a failed verdict, emits a trailing NOTICE-ONLY chunk via `onPartial`.
 *
 * The Task 1 vehicle spike proved:
 * the DAG coordinator forwards every worker `onPartial` content delta LIVE to
 * both `process()` (accumulated) and `streamProcess()` (chunk sequence), and
 * `FinalizerResult.output` is NEVER re-yielded (`dag-coordinator.js:275` yields
 * only `{content:'', finishReason:'stop'}`). So the executor's content is
 * ALREADY fully streamed by the time this finalizer runs — re-emitting
 * `interpreterOutput` here would duplicate it verbatim (confirmed empirically
 * in the spike). Hence: notice-only, never the interpreter output.
 */

import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
  ILlm,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { renderNotice } from './notify-policy';
import type { RecordingMcpClient } from './recording-mcp-client';
import { evaluateGated } from './step-reviewer';

export class NoticeFinalizer implements IFinalizer {
  readonly name = 'notice';
  readonly model?: string;

  constructor(
    private readonly recMcp: RecordingMcpClient,
    private readonly criticLlm: ILlm,
  ) {}

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    const t = input.trace?.traceId;
    const records = this.recMcp.getToolRecords(t);

    const verdict = await evaluateGated({
      content: input.interpreterOutput,
      records,
      toolCallCount: records.length,
      llm: this.criticLlm,
    });

    // TEMP diagnostic (remove after e2e confirms per-trace capture): surfaces
    // how many tool records the reviewer actually saw for this traceId, so an
    // empty-records (traceId-mismatch) false-flag is distinguishable from a
    // genuine verdict in the deployed logs.
    cds.log('notice-finalizer').info('review', {
      traceId: t,
      records: records.length,
      tools: records.map((r) => {
        const c = r.result.content;
        const sample =
          typeof c === 'string'
            ? c.slice(0, 140)
            : JSON.stringify(c).slice(0, 140);
        return {
          name: r.call.name,
          isError: r.result.isError,
          content: sample,
        };
      }),
      ok: verdict.ok,
    });

    if (!verdict.ok) {
      input.onPartial?.({ kind: 'content', delta: renderNotice(verdict) });
    }

    // FinalizerResult.output is NOT re-yielded by the coordinator (only
    // onPartial deltas reach the consumer) — returning it as-is is inert.
    return { output: input.interpreterOutput };
  }
}
