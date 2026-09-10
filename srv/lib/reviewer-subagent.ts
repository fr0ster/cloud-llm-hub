import type {
  ILlm,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  SubAgentCapabilities,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { getRequestHistory } from '../request-session';
import { evaluateGated } from './step-reviewer';

export interface ReviewerSubAgentDeps {
  /** Tool-call records (call + RESULT) for a given trace, sourced from the
   *  shared `RecordingMcpClient.getToolRecords(traceId)`. Keyed by `traceId`
   *  so this class stays portable and unit-testable with a stub — no
   *  dependency on the concrete recording client here. */
  getToolRecords: (traceId?: string) => ToolCallRecord[];
  llm: ILlm;
}

/**
 * Portable `ISubAgent` wrapper over the deterministic+gated reviewer core
 * (`evaluateGated`). Intended as the future coordinator's review worker; the
 * interim path calls the same `evaluateGated` core directly from
 * `NoticeFinalizer` (Task 7) instead of dispatching through this class.
 *
 * IMPORTANT (Verified library fact 2): `epicfail`/failed-step results are
 * DISCARDED by the coordinator before final assembly (`output: ''`), so this
 * class must NEVER set `errorClass: 'epicfail'` — a problem verdict is still
 * a SUCCESSFUL `ISubAgentResult`, carried in `metadata.verdict`.
 */
export class ReviewerSubAgent implements ISubAgent {
  readonly name = 'reviewer';
  readonly description =
    'Reviews an executor response against the tools it actually ran; never fails the step.';
  readonly capabilities: SubAgentCapabilities = { contextPolicy: 'optional' };

  constructor(private readonly deps: ReviewerSubAgentDeps) {}

  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    // The content under review is the executor's output. `ISubAgentInput.context`
    // is the assembled preamble a caller places it in (this class declares
    // `contextPolicy: 'optional'`); when absent, fall back to `task` so this
    // agent also works when dispatched directly with the content as the task.
    const content = input.context ?? input.task;
    const records = this.deps.getToolRecords(input.trace?.traceId);
    const verdict = await evaluateGated({
      content,
      records,
      toolCallCount: records.length,
      llm: this.deps.llm,
      // Same two inputs the finalizer supplies, so the two review paths cannot
      // reach different verdicts on the same answer.
      task: input.task,
      history: getRequestHistory(),
    });
    return {
      output: content,
      metadata: { verdict },
    };
  }
}
