/** ABAP object names: uppercase, underscored, at least four characters. */
const OBJECT_NAME = /\b[A-Z][A-Z0-9_]{3,}\b/g;
const MAX_NAMES = 20;

/** Hub-internal (user, session) key, retained for planner memory and counters.
 * History records use the session collection owner instead of this tuple. */
export function turnOwner(userId: string, sessionId: string): string {
  return JSON.stringify([userId, sessionId]);
}

/** The (userId, sessionId) pair back out of a turnOwner, or undefined. */
export function parseTurnOwner(
  owner: string,
): { userId: string; sessionId: string } | undefined {
  try {
    const v: Array<string> | null = JSON.parse(owner);
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'string'
    )
      return { userId: v[0], sessionId: v[1] };
  } catch {
    // Not a turnOwner: no filter can be built from it.
  }
  return undefined;
}

/**
 * Names useful as additional semantic search terms.
 *
 * Kept for consumers that display or index object names.
 */
export function objectNames(text: string): string[] {
  return [...new Set(text.match(OBJECT_NAME) ?? [])].slice(0, MAX_NAMES);
}

/** One turn, rendered for embedding and recall. */
export function renderTurn(userText: string, assistantText: string): string {
  return `User: ${userText}\nAssistant: ${assistantText}`;
}

/** One stored turn, read back. */
export interface StoredTurn {
  id: string;
  userText: string;
  assistantText: string;
  /** ISO; empty for a turn written without one. */
  createdAt: string;
}

/**
 * A rendered turn read back: the user and assistant text, without the names
 * line for legacy records. New records supply the exact user length to preserve
 * quoted delimiters and Objects lines verbatim. Undefined for text
 * `renderTurn` did not write.
 */
export function parseTurn(
  text: string,
  userTextLength?: number,
): { userText: string; assistantText: string } | undefined {
  if (!text.startsWith('User: ')) return undefined;
  const split =
    userTextLength === undefined
      ? text.indexOf('\nAssistant: ')
      : 'User: '.length + userTextLength;
  if (split === -1) return undefined;
  let answer = text.slice(split + '\nAssistant: '.length);
  // The names line is last when there is one, and only ever appended.
  const names = answer.lastIndexOf('\nObjects: ');
  if (
    userTextLength === undefined &&
    names !== -1 &&
    !answer.slice(names + 1).includes('\n')
  )
    answer = answer.slice(0, names);
  return {
    userText: text.slice('User: '.length, split),
    assistantText: answer,
  };
}

/** Fallback embedder input bound in UTF-8 bytes, not a relevance budget.
 * IEmbedder/IDocumentEmbedder and the installed providers expose no input limit.
 * Leave room below the library's 24,000-character input cap and token limits. */
export const HISTORY_EMBEDDER_INPUT_BYTES = 6000;

/** Split on Unicode code points so even non-ASCII input remains lossless. */
function splitBytes(text: string, bound: number): string[] {
  const parts: string[] = [];
  let part = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > bound) {
      parts.push(part);
      part = '';
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  if (part || !parts.length) parts.push(part);
  return parts;
}

/** Every chunk carries a user header. Long user inputs get ordered header
 * continuations; assistant chunks repeat the first header for standalone recall. */
export function chunkTurn(userText: string, assistantText: string) {
  const headers = splitBytes(userText, HISTORY_EMBEDDER_INPUT_BYTES / 2);
  const header = headers[0];
  const room =
    HISTORY_EMBEDDER_INPUT_BYTES -
    Buffer.byteLength(renderTurn(header, ''), 'utf8');
  const answers = splitBytes(assistantText, room);
  return [
    ...(headers.length > 1 ? headers : []).map((userText) => ({
      userText,
      assistantText: '',
      userContinuation: true,
    })),
    ...answers.map((assistantText) => ({
      userText: header,
      assistantText,
      userContinuation: false,
    })),
  ];
}
