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
