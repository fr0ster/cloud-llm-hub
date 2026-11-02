import type {
  IToolLoopContextStrategy,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import { WindowContextStrategy } from '@mcp-abap-adt/llm-agent-libs';
import { z } from 'zod';
import { loopReads, ReadDedup } from './read-dedup';

export function toolLoopWindow(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LLM_AGENT_TOOL_LOOP_WINDOW?.trim();
  if (!raw) return 8;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1)
    throw new Error(
      'LLM_AGENT_TOOL_LOOP_WINDOW must be a positive safe integer',
    );
  return value;
}

const readArgs = z.object({ collection: z.string(), id: z.string() });
const page = z.object({
  offset: z.number(),
  total: z.number(),
  text: z.string().optional(),
  note: z.string().optional(),
});
function oneLine(text: string): string {
  return text.split(/\r?\n/).join(' ');
}
export function digestRound(round: ToolRound): string {
  return round.results
    .map((result) => {
      const call = round.assistant.tool_calls?.find(
        (item) => item.id === result.tool_call_id,
      );
      const name = call?.function.name ?? 'tool';
      const text = result.content ?? '';
      if (name === 'rag_read' && call) {
        try {
          const args = readArgs.safeParse(JSON.parse(call.function.arguments));
          const read = page.safeParse(JSON.parse(text));
          if (args.success && read.success) {
            const { offset, total, text: body, note } = read.data;
            const end =
              body !== undefined
                ? offset + body.length
                : note?.match(/offset \d+–(\d+)$/)?.[1];
            if (end !== undefined)
              return `rag_read ${oneLine(args.data.collection)}/${oneLine(args.data.id)} chars ${offset}–${end} of ${total} (read earlier, dropped from context)`;
          }
        } catch {
          /* Non-JSON or capped results use the generic digest. */
        }
      }
      return `${name}: ${oneLine(text).slice(0, 120)}`;
    })
    .join('\n');
}

export function createToolLoopWindow(
  keep = toolLoopWindow(),
): IToolLoopContextStrategy {
  const window = new WindowContextStrategy({ keepLastRounds: keep });
  const reads = new ReadDedup(keep);
  loopReads.enterWith(reads);
  const digests: string[] = [];
  return {
    async record(round) {
      await window.record(round);
      digests.push(digestRound(round));
      reads.advance();
    },
    async form(base) {
      const messages = await window.form(base);
      if (digests.length > keep)
        messages[base.prefix.length] = {
          role: 'user',
          content: digests.slice(0, -keep).filter(Boolean).join('\n'),
        };
      return messages;
    },
    snapshot: () => ({ ...window.snapshot(), digests }),
    restore(state) {
      window.restore(state);
      const restored = z
        .object({ digests: z.array(z.string()) })
        .safeParse(state);
      digests.length = 0;
      if (restored.success) digests.push(...restored.data.digests);
    },
  };
}
