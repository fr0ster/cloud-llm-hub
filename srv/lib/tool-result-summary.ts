import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

const identifiers = z.object({
  collection: z.string().optional(),
  record: z.string().optional(),
  id: z.string().optional(),
});
const shortText = z.string().transform((value) => value.slice(0, 200));
const structured = identifiers.extend({
  total: z.number().optional(),
  offset: z.number().optional(),
  error: z
    .object({ code: z.string().optional(), message: shortText.optional() })
    .optional(),
  result: shortText.optional(),
  hits: z
    .array(
      z.object({
        collection: z.string().optional(),
        id: z.string().optional(),
      }),
    )
    .optional(),
  unavailable: z
    .array(z.object({ collection: z.string().optional() }))
    .optional(),
  records: z.array(z.object({ id: z.string().optional() })).optional(),
  collections: z.array(z.object({ id: z.string().optional() })).optional(),
});

export interface ToolResultSummary {
  call: { name: string; arguments: z.infer<typeof identifiers> };
  result: { isError: boolean; structuredContent: z.infer<typeof structured> };
}

/** Only identifiers and counts may cross the optional UI summary channel. */
export function summarizeToolResult(record: ToolCallRecord): ToolResultSummary {
  const isError = record.result.isError === true;
  const envelope = z
    .object({ structuredContent: structured.optional() })
    .safeParse(record.result);
  let summary = envelope.success ? envelope.data.structuredContent : undefined;
  if (!summary) {
    const content = record.result.content;
    try {
      const parsed = structured.safeParse(
        typeof content === 'string' ? JSON.parse(content) : content,
      );
      if (parsed.success) summary = parsed.data;
    } catch {
      summary =
        isError && typeof content === 'string'
          ? { result: content.slice(0, 200) }
          : {};
    }
  }
  summary ??= {};
  if (!isError) delete summary.result;
  const args = identifiers.safeParse(record.call.arguments);
  return {
    call: { name: record.call.name, arguments: args.success ? args.data : {} },
    result: { isError, structuredContent: summary },
  };
}
