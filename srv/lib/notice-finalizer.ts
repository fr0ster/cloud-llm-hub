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

    if (!verdict.ok) {
      input.onPartial?.({ kind: 'content', delta: renderNotice(verdict) });
    }

    // FinalizerResult.output is NOT re-yielded by the coordinator (only
    // onPartial deltas reach the consumer) — returning it as-is is inert.
    return { output: input.interpreterOutput };
  }
}
