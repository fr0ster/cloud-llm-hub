/**
 * `IFinalizer` that opts into live executor content streaming by the DAG
 * coordinator (llm-agent 30.4.0), then appends a NOTICE on a failed honesty verdict.
 * Re-emits the answer only when the coordinator says it was not fully streamed
 * (multi-node plan, partial stream, or sub-plan recovery).
 */

import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from '@mcp-abap-adt/llm-agent';
import { renderNotice } from './notify-policy';
import type { RecordingMcpClient } from './recording-mcp-client';
import { evaluateGated } from './step-reviewer';

export class NoticeFinalizer implements IFinalizer {
  readonly name = 'notice';
  readonly streamsInterpreterContent = true;
  readonly model?: string;

  constructor(private readonly recMcp: RecordingMcpClient) {}

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    // Re-emit only when the full answer was not streamed. Skip empty output.
    if (input.interpreterContentStreamed !== true && input.interpreterOutput) {
      input.onPartial?.({ kind: 'content', delta: input.interpreterOutput });
    }

    const records = this.recMcp.getToolRecords(input.trace?.traceId);

    const verdict = await evaluateGated({
      content: input.interpreterOutput,
      records,
      writeToolOffered: this.recMcp.hadWriteCapability(input.trace?.traceId),
    });

    // Trailing NOTICE (after the answer) on a contradiction — NOTICE-ONLY
    // reaction: the consumer decides what to do; we never render a verdict.
    if (!verdict.ok) {
      input.onPartial?.({ kind: 'content', delta: renderNotice(verdict) });
    }

    return { output: input.interpreterOutput };
  }
}
