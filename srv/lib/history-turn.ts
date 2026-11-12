/** How much of the answer is kept. Tool output can run to tens of thousands of
 *  characters; the object names and the outcome are at the front. */
const ANSWER_CHARS = 1200;

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
 * Names worth surviving the clip.
 *
 * A created object's name is the fact a later turn asks for, and it can sit
 * past the cut in a long answer. Pulling the names out and appending them keeps
 * them findable whatever the clip removed.
 */
export function objectNames(text: string): string[] {
  return [...new Set(text.match(OBJECT_NAME) ?? [])].slice(0, MAX_NAMES);
}

/** One turn, rendered for embedding and recall. */
export function renderTurn(userText: string, assistantText: string): string {
  const answer =
    assistantText.length > ANSWER_CHARS
      ? `${assistantText.slice(0, ANSWER_CHARS)}…`
      : assistantText;
  const names = objectNames(assistantText);
  return [
    `User: ${userText}`,
    `Assistant: ${answer}`,
    ...(names.length ? [`Objects: ${names.join(', ')}`] : []),
  ].join('\n');
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
 * line. The answer is the clipped one that was stored. Undefined for text
 * `renderTurn` did not write.
 */
export function parseTurn(
  text: string,
): { userText: string; assistantText: string } | undefined {
  if (!text.startsWith('User: ')) return undefined;
  const split = text.indexOf('\nAssistant: ');
  if (split === -1) return undefined;
  let answer = text.slice(split + '\nAssistant: '.length);
  // The names line is last when there is one, and only ever appended.
  const names = answer.lastIndexOf('\nObjects: ');
  if (names !== -1 && !answer.slice(names + 1).includes('\n'))
    answer = answer.slice(0, names);
  return {
    userText: text.slice('User: '.length, split),
    assistantText: answer,
  };
}
