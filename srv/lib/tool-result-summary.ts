import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

const identifiers = z.object({
  collection: z.string().optional(),
  record: z.string().optional(),
  id: z.string().optional(),
});
/** Error codes look like SESSION_REQUIRED; free text never crosses this channel. */
const ERROR_CODE = /^([A-Z][A-Z0-9_]{2,63})(?::|$)/;
const isErrorCode = (text: string | undefined): text is string =>
  !!text && /^[A-Z][A-Z0-9_]{2,63}$/.test(text);
const errorCode = (text: string | undefined): string | undefined =>
  text ? ERROR_CODE.exec(text.trim())?.[1] : undefined;
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
  call: {
    name: string;
    arguments: z.infer<typeof identifiers> & {
      query?: string;
      offset?: number;
      limit?: number;
    };
  };
  result: { isError: boolean; structuredContent: z.infer<typeof structured> };
}

/** Keep identifiers, counts, and bounded search/paging arguments in UI summaries. */
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
    (isErrorCode(summary.error?.code) ? summary.error?.code : undefined) ??
    errorCode(summary.error?.message) ??
    errorCode(summary.result);
  delete summary.result;
  delete summary.error;
  if (isError) summary.error = { code: code ?? 'ERROR' };
  const schema =
    record.call.name === 'rag_search'
      ? identifiers.extend({
          query: z
            .string()
            .transform((text) => text.slice(0, 200))
            .optional(),
        })
      : record.call.name === 'rag_read'
        ? identifiers.extend({
            offset: z.number().optional(),
            limit: z.number().optional(),
          })
        : identifiers;
  const args = schema.safeParse(record.call.arguments);
  return {
    call: { name: record.call.name, arguments: args.success ? args.data : {} },
    result: { isError, structuredContent: summary },
  };
}
