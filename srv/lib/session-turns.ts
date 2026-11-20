import type { Message, RagCaller } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { getSharedHistoryRag } from '../agent-manager';
import { clientHistoryTurnId, clientToolResultIds } from './client-history';
import { type LongSession, longSessionsIfReady } from './long-session';
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
  session?: LongSession,
): void {
  const rag = getSharedHistoryRag();
  if (!rag) return;
  const question = userTextOf(lastUser);
  if (!question.trim() || !answer.trim()) return;
  const clientToolCallIds = id
    ? [...(session?.clientToolTurns ?? [])]
        .filter(([, turnId]) => turnId === id)
        .map(([callId]) => callId)
    : [];
  const stored = rag.recordTurn({
    caller,
    userText: question,
    assistantText: answer,
    ...(id === undefined ? {} : { id }),
    ...(session && id && clientToolCallIds.length
      ? {
          clientToolCallIds,
          onStored: () => finishClientToolTurn(session, id, clientToolCallIds),
        }
      : {}),
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

/** Wait for the record before handing these IDs to a client. */
export async function rememberClientToolTurn(
  session: LongSession | undefined,
  turnId: string | undefined,
  callIds: readonly string[],
): Promise<void> {
  if (!session || !turnId || !callIds.length) return;
  session.clientToolTurns ??= new Map();
  for (const id of callIds) session.clientToolTurns.set(id, turnId);
  await longSessionsIfReady()?.persist(session);
}

/** The durable history turn now owns the call IDs. */
async function finishClientToolTurn(
  session: LongSession,
  turnId: string,
  storedCallIds: readonly string[],
): Promise<void> {
  const turns = session.clientToolTurns;
  if (!turns) return;
  let changed = false;
  for (const callId of storedCallIds) {
    if (turns.get(callId) !== turnId) continue;
    changed = turns.delete(callId) || changed;
  }
  if (!changed) return;
  try {
    await longSessionsIfReady()?.persist(session);
  } catch (error) {
    cds.log('long-session').warn('session record write failed', {
      key: session.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function resolveClientHistoryTurn(
  caller: RagCaller,
  messages: Message[],
  signal: AbortSignal,
  session?: LongSession,
): Promise<{ id?: string; recorded: boolean }> {
  signal.throwIfAborted();
  const bindings = session?.clientToolTurns;
  const id = clientHistoryTurnId(messages, bindings);
  const callIds = clientToolResultIds(messages);
  if (!id || !callIds.length) return { id, recorded: false };
  const recorded = await getSharedHistoryRag()?.findClientToolTurn(
    caller,
    id,
    signal,
    session && !callIds.some((callId) => bindings?.has(callId)) ? callIds : [],
  );
  signal.throwIfAborted();
  if (!recorded) return { id, recorded: false };
  if (session)
    await finishClientToolTurn(session, recorded.id, recorded.callIds);
  return { id: recorded.id, recorded: true };
}

export async function waitForSessionTurns(
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  await waitForSessionHistoryTurns(sessionId, signal);
}
