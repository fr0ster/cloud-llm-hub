import type { DumpBufferKey, DumpBufferStore } from './dump-buffer';
import { dumpSectionIndex, getDumpSection } from './dump-parser';

export interface GetDumpSectionArgs {
  dumpId: string;
  section?: string;
}

export interface GetDumpSectionDeps {
  key: DumpBufferKey;
  buffer: DumpBufferStore;
  fetchFormatted: (dumpId: string) => Promise<string>;
}

export interface GetDumpSectionResult {
  dumpId: string;
  index?: string[];
  section?: string;
  text?: string;
}

/**
 * Serves an ST22 dump's section index (no `section` given) or one de-padded chapter
 * (`section` given) from a principal-scoped buffer. Fetches the full formatted payload
 * via `deps.fetchFormatted` only on a buffer miss, then caches `{ index, raw }` so the
 * full 185K-token dump text never re-enters the LLM context on repeat calls.
 */
export async function getDumpSectionResult(
  args: GetDumpSectionArgs,
  deps: GetDumpSectionDeps,
): Promise<GetDumpSectionResult> {
  let cached = deps.buffer.get(deps.key);
  if (!cached) {
    const raw = await deps.fetchFormatted(args.dumpId);
    const index = dumpSectionIndex(raw);
    cached = { index, raw };
    deps.buffer.set(deps.key, cached);
  }

  const { index, raw } = cached;

  if (args.section === undefined) {
    return { dumpId: args.dumpId, index };
  }

  const text = getDumpSection(raw, args.section);
  if (text === null) {
    throw new Error(
      `Section "${args.section}" not found in dump ${args.dumpId}. Valid sections: ${index.join(', ')}`,
    );
  }

  return { dumpId: args.dumpId, section: args.section, text };
}

/**
 * Join the text parts of an MCP tool result into a single string. Non-text
 * parts (if any) are ignored; an empty/absent `content` yields `''`.
 */
export function extractMcpTextResult(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (c): c is { type: 'text'; text: string } =>
        (c as { type?: unknown })?.type === 'text' &&
        typeof (c as { text?: unknown })?.text === 'string',
    )
    .map((c) => c.text)
    .join('\n');
}

/**
 * Parse a `RuntimeGetDumpById` (view: 'formatted') MCP result and return the
 * raw pipe-text payload. `RuntimeGetDumpById` wraps the payload in a JSON
 * envelope `{ success, dump_id, view, status, payload }`; the raw dump text is
 * `payload` (a string) only for the formatted view. Validates the envelope and
 * throws loudly on any deviation — never silently returns `''`, because a
 * wrong-format payload would corrupt every parsed section.
 */
export function parseFormattedDumpPayload(result: unknown): string {
  const raw = extractMcpTextResult(result);
  const j = JSON.parse(raw) as {
    success?: unknown;
    view?: unknown;
    payload?: unknown;
  };
  if (
    j.success !== true ||
    j.view !== 'formatted' ||
    typeof j.payload !== 'string'
  ) {
    throw new Error(
      `Unexpected RuntimeGetDumpById result: ${JSON.stringify({
        success: j.success,
        view: j.view,
        payloadType: typeof j.payload,
      })}`,
    );
  }
  return j.payload;
}

export interface GetDumpSectionCallArgs {
  dumpId?: string;
  section?: string;
}

export interface GetDumpSectionCallDeps {
  dumpScope?: {
    principalHash: string;
    resolvedDestination: string;
    effectiveClient: string;
  };
  buffer: DumpBufferStore;
  fetchFormatted: (dumpId: string) => Promise<string>;
}

export interface McpTextResult {
  isError: boolean;
  content: [{ type: 'text'; text: string }];
}

/**
 * MCP-shaped entry point for the `GetDumpSection` tool. Fails closed with two
 * DISTINCT errors (never conflated): no stable principal → identity required;
 * missing `dumpId` → dump_id required. Otherwise delegates to
 * `getDumpSectionResult`, keyed by the principal/scope, and turns any thrown
 * error (e.g. an invalid `section`) into an `isError:true` MCP result.
 */
export async function handleGetDumpSectionCall(
  args: GetDumpSectionCallArgs,
  deps: GetDumpSectionCallDeps,
): Promise<McpTextResult> {
  if (!deps.dumpScope) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'SAP identity required to analyse a dump (no stable principal)',
        },
      ],
    };
  }
  if (!args.dumpId) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'dump_id is required' }],
    };
  }
  try {
    const result = await getDumpSectionResult(
      { dumpId: args.dumpId, section: args.section },
      {
        key: { ...deps.dumpScope, dumpId: args.dumpId },
        buffer: deps.buffer,
        fetchFormatted: deps.fetchFormatted,
      },
    );
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: String((e as Error).message) }],
    };
  }
}
