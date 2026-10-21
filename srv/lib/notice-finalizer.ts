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
  ILlm,
} from '@mcp-abap-adt/llm-agent';
import { getRequestHistory } from '../request-session';
import { renderNotice } from './notify-policy';
import type { RecordingMcpClient } from './recording-mcp-client';
import { getReviewSignals } from './review-scope';
import { evaluateGated } from './step-reviewer';

export class NoticeFinalizer implements IFinalizer {
  readonly name = 'notice';
  readonly streamsInterpreterContent = true;
  readonly model?: string;

  constructor(
    private readonly recMcp: RecordingMcpClient,
    private readonly criticLlm: ILlm,
  ) {}

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    // Re-emit only when the full answer was not streamed. Skip empty output.
    if (input.interpreterContentStreamed !== true && input.interpreterOutput) {
      input.onPartial?.({ kind: 'content', delta: input.interpreterOutput });
    }

    const records = this.recMcp.getToolRecords(input.trace?.traceId);

    const verdict = await evaluateGated({
      content: input.interpreterOutput,
      records,
      ...getReviewSignals(),
      llm: this.criticLlm,
      // What was asked, and the conversation it was asked in. Both were absent
      // before: the reviewer received an empty task and no earlier turns, so it
      // judged every answer as the first thing ever said and flagged correct
      // ones — "42", after the user had supplied 42 — as unsupported.
      // Both: what the user asked, and the coordinator's restatement of it. A
      // restatement can drift, and a response that satisfies the restatement
      // while missing the request is exactly the failure worth catching.
      request: input.prompt,
      task: input.objective || input.prompt,
      history: getRequestHistory(),
    });

    // Trailing NOTICE (after the answer) on a contradiction — NOTICE-ONLY
    // reaction: the consumer decides what to do; we never render a verdict.
    if (!verdict.ok) {
      input.onPartial?.({ kind: 'content', delta: renderNotice(verdict) });
    }

    return { output: input.interpreterOutput };
  }
}
