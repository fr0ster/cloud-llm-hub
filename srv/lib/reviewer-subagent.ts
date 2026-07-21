import type {
  ILlm,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  SubAgentCapabilities,
} from '@mcp-abap-adt/llm-agent';
import { evaluateGated } from './step-reviewer';

export interface ReviewerSubAgentDeps {
  /** Executed internal ABAP tool names for a given trace, sourced from the
   *  shared recording logger (`RecordingRequestLogger.getToolNames(traceId)`
   *  once Task 7 lands). Keyed by `traceId` so this class stays portable and
   *  unit-testable with a stub — no dependency on the concrete logger here. */
  executedToolNames: (traceId?: string) => string[];
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
    const tools = this.deps.executedToolNames(input.trace?.traceId);
    // This portable unit has no token/tool-call telemetry of its own — the
    // future coordinator wiring (or the interim `NoticeFinalizer`) supplies
    // the real counts from `IRequestLogger.getSummary(traceId)`. Zero here
    // only affects the LLM-gate threshold check, never the deterministic verdict.
    const verdict = await evaluateGated({
      content,
      executedTools: tools,
      totalTokens: 0,
      toolCallCount: 0,
      llm: this.deps.llm,
    });
    return {
      output: content,
      metadata: { verdict },
    };
  }
}
