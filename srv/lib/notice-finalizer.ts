import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from '@mcp-abap-adt/llm-agent';

/** Forward fixed DAG output when the interpreter did not already stream it. */
export class NoticeFinalizer implements IFinalizer {
  readonly name = 'passthrough';
  readonly streamsInterpreterContent = true;

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    if (!input.interpreterContentStreamed && input.interpreterOutput) {
      input.onPartial?.({ kind: 'content', delta: input.interpreterOutput });
    }
    return { output: input.interpreterOutput };
  }
}
