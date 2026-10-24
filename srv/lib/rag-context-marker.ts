/**
 * Separates the user's own words from the retrieved collection context that
 * the OpenAI handler appends to the last user message. Shared so the LLM-only
 * guard can classify the user's request without the retrieved text.
 */
export const RAG_CONTEXT_MARKER =
  '\n\n[Context from knowledge base — answer based on this, in your own words]\n';

/** The user's own text: everything before the appended retrieval context. */
export function withoutRagContext(content: string): string {
  const at = content.indexOf(RAG_CONTEXT_MARKER);
  return at < 0 ? content : content.slice(0, at);
}
