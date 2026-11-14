import type { Message, RagCaller } from '@mcp-abap-adt/llm-agent';
import { getSharedHistoryRag } from '../agent-manager';

/** Extract plain text from OpenAI content (string | content-block array) */
export function extractText(c: unknown): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter(
      (b: unknown) =>
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: string }).type === 'text' &&
        typeof (b as { text?: string }).text === 'string',
    )
    .map((b: { text: string }) => b.text)
    .join('\n');
}

/**
 * Store the completed turn for semantic recall, beside the verbatim store.
 *
 * Server-managed model context recalls these full turns through semantic search.
 * The separate message window remains available for UI and run bookkeeping.
 *
 * Fire-and-forget on purpose. The answer has already been sent; a failure to
 * remember it must not surface as an error on a request that succeeded.
 */
export function recordTurn(
  caller: RagCaller,
  lastUser: Message,
  answer: string,
): void {
  const rag = getSharedHistoryRag();
  if (!rag) return;
  const question = extractText(lastUser.content);
  if (!question || !answer) return;
  void rag
    .recordTurn({
      caller,
      userText: question,
      assistantText: answer,
    })
    .catch(() => {});
}
