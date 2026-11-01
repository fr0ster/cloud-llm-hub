import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

const identifiers = z.object({
  collection: z.string().optional(),
  record: z.string().optional(),
  id: z.string().optional(),
});
/** Error codes look like SESSION_REQUIRED; free text never crosses this channel. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}/;
const errorCode = (text: string | undefined): string | undefined =>
  text ? ERROR_CODE.exec(text.trim())?.[0] : undefined;
const structured = identifiers.extend({
  total: z.number().optional(),
  offset: z.number().optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
  result: z.string().optional(),
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
        isError && typeof content === 'string' ? { result: content } : {};
    }
  }
  summary ??= {};
  // Messages may echo backend or document text: keep only an error code.
  const code =
    summary.error?.code ??
    errorCode(summary.error?.message) ??
    errorCode(summary.result);
  delete summary.result;
  delete summary.error;
  if (isError) summary.error = { code: code ?? 'ERROR' };
  const args = identifiers.safeParse(record.call.arguments);
  return {
    call: { name: record.call.name, arguments: args.success ? args.data : {} },
    result: { isError, structuredContent: summary },
  };
}
