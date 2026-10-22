import type { PlannerAgent } from '@mcp-abap-adt/llm-agent-libs';

/** Normalize the same planner turn for live deltas and whole event replies. */
export function plannerWithParagraphs(planner: PlannerAgent): PlannerAgent {
  return {
    async process(input, options) {
      let content = '';
      let interrupted = false;
      const result = await planner.process(input, {
        ...options,
        onPartial(chunk) {
          if (chunk.kind !== 'content') {
            interrupted = true;
            options.onPartial?.(chunk);
            return;
          }
          if (!chunk.delta) return;
          const delta =
            (interrupted && content && !content.endsWith('\n') ? '\n\n' : '') +
            chunk.delta;
          interrupted = false;
          content += delta;
          options.onPartial?.({ ...chunk, delta });
        },
      });
      return result.ok && content
        ? { ...result, value: { ...result.value, content } }
        : result;
    },
  };
}
