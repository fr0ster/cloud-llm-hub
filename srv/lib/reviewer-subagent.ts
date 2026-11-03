import type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  SubAgentCapabilities,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { evaluateGated } from './step-reviewer';

export interface ReviewerSubAgentDeps {
  /** Tool-call records (call + RESULT) for a given trace, sourced from the
   *  shared `RecordingMcpClient.getToolRecords(traceId)`. Keyed by `traceId`
   *  so this class stays portable and unit-testable with a stub — no
   *  dependency on the concrete recording client here. */
  getToolRecords: (traceId?: string) => ToolCallRecord[];
  hadWriteCapability?: (traceId?: string) => boolean;
}

/** Optional deterministic notice worker; never invokes an LLM. */
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
      writeToolOffered: this.deps.hadWriteCapability?.(input.trace?.traceId),
      content,
      records,
    });
    return {
      output: content,
      metadata: { verdict },
    };
  }
}
