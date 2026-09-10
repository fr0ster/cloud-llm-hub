/**
 * `IFinalizer` that surfaces the executor's answer to the client and, on a
 * failed honesty verdict, appends a trailing NOTICE.
 *
 * WHY it re-emits the answer (fixed 2026-07-24, was a notice-only regression):
 * under the DAG coordinator (`@mcp-abap-adt/llm-agent` #166) the interpreter's
 * `onPartial` — the executor's live content AND heartbeats — is routed to the
 * session log ONLY (`dag-coordinator.js`: `interpreterOnPartial`). The
 * FINALIZER's `onPartial` is the SINGLE client-facing content source: it is what
 * `streamProcess()` yields to the SSE client, and what `process()` accumulates
 * into the non-streaming result (`agent.js`: `content += chunk.value.content`).
 * `FinalizerResult.output` is NOT re-yielded by the coordinator. So a finalizer
 * that emits no content leaves BOTH streaming (`/v1/*` WebUI) and non-streaming
 * (`execute_step` / MCP subagent) clients with an empty response.
 *
 * The earlier "notice-only" design assumed the coordinator streamed the
 * executor's content live — true before the 20.x coordinator change, false
 * after it. Hence: emit `interpreterOutput` as content first, then any trailing
 * notice. Emitting it once (the coordinator does not also yield `output`) means
 * no duplication in either mode.
 *
 * NOTE (streaming granularity): this delivers the answer as ONE content delta at
 * finalize time, not token-by-token. Restoring live token-by-token streaming
 * requires the coordinator to forward the interpreter's `onPartial` to the
 * client (upstream). Connection keep-alive during the run is handled at the SSE
 * handler layer (openai-handler / anthropic-handler heartbeat).
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
import { evaluateGated } from './step-reviewer';

export class NoticeFinalizer implements IFinalizer {
  readonly name = 'notice';
  readonly model?: string;

  constructor(
    private readonly recMcp: RecordingMcpClient,
    private readonly criticLlm: ILlm,
  ) {}

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    // The executor's answer — the single client-facing content source (see file
    // header). Empty output → no stray delta.
    if (input.interpreterOutput) {
      input.onPartial?.({ kind: 'content', delta: input.interpreterOutput });
    }

    const records = this.recMcp.getToolRecords(input.trace?.traceId);

    const verdict = await evaluateGated({
      content: input.interpreterOutput,
      records,
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
