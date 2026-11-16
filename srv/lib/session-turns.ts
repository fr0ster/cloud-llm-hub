import type { Message, RagCaller } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { getSharedHistoryRag } from '../agent-manager';
import { userTextOf } from './rag-context-marker';
import { waitForSessionHistoryTurns } from './session-history-collection';

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
 * The router owns a retained per-session queue, independent of response lifetime.
 * Later requests wait for it; failures poison the shared hub readiness state.
 */
export function recordTurn(
  caller: RagCaller,
  lastUser: Message,
  answer: string,
  id?: string,
): void {
  const rag = getSharedHistoryRag();
  if (!rag) return;
  const question = userTextOf(lastUser);
  if (!question.trim() || !answer.trim()) return;
  const stored = rag.recordTurn({
    caller,
    userText: question,
    assistantText: answer,
    ...(id === undefined ? {} : { id }),
  });
  void stored.then((ok) => {
    if (!ok)
      cds
        .log('session-history')
        .error(
          'Session history write failed; hub unhealthy; turn retained for repair',
        );
  });
}

export async function waitForSessionTurns(
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  await waitForSessionHistoryTurns(sessionId, signal);
}
