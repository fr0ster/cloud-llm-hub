/**
 * Separates the user's own words from the retrieved collection context that
 * the chat handlers append to the last user message.
 *
 * The provenance is kept out of band: the handler records the user's original
 * text against the new message object. Client text can contain the marker
 * string too, so the marker itself is never used to split a message.
 */
export const RAG_CONTEXT_MARKER =
  '\n\n[Context from knowledge base — answer based on this, in your own words]\n';

const contexts = new WeakMap<object, string>();
const originals = new WeakMap<object, string>();

/** A user message with retrieval context appended; remembers the user's text. */
export function withRagContext<T extends { content: string | null }>(
  message: T,
  ragContext: string,
): T {
  const userText = typeof message.content === 'string' ? message.content : '';
  const next = {
    ...message,
    content: `${userText}${RAG_CONTEXT_MARKER}${ragContext}`,
  };
  originals.set(next, userText);
  contexts.set(next, ragContext);
  return next;
}

/** The user's own text of a message: without context the hub appended to it. */
export function userTextOf(message: { content: string | null }): string {
  return originals.get(message) ?? message.content ?? '';
}

/** Appended collection context, only for messages created by withRagContext. */
export function ragContextOf(message: object): string | undefined {
  return contexts.get(message);
}
