import type { PlannerAgent } from '@mcp-abap-adt/llm-agent-libs';

/** Inject into the library's temporary turn input, never its conversation. */
export function plannerWithEnvironment(
  planner: PlannerAgent,
  environment: () => string,
): PlannerAgent {
  return {
    process(input, options) {
      const messages = [...input];
      messages.splice(Math.max(0, messages.length - 1), 0, {
        role: 'user',
        content: `[environment]\n${environment()}`,
      });
      return planner.process(messages, options);
    },
  };
}

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
