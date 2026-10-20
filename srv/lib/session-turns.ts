import type { Message } from '@mcp-abap-adt/llm-agent';
import { getSharedHistoryRag } from '../agent-manager';
import { turnOwner } from './session-history-rag';

function extractText(c: unknown): string {
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
 * The two answer different questions. `appendToSession` keeps the last turns
 * word for word, which is what resolves "that domain" on the very next
 * message. This one survives the recency window: many turns later, when the
 * wording is gone, a similar question still finds what the object was called.
 *
 * Fire-and-forget on purpose. The answer has already been sent; a failure to
 * remember it must not surface as an error on a request that succeeded.
 */
export function recordTurn(
  sessionId: string,
  userId: string,
  lastUser: Message,
  answer: string,
): void {
  const rag = getSharedHistoryRag();
  if (!rag) return;
  const question = extractText(lastUser.content);
  if (!question || !answer) return;
  void rag
    .recordTurn({
      owner: turnOwner(userId, sessionId),
      userText: question,
      assistantText: answer,
    })
    .catch(() => {});
}
