import {
  RAG_CONTEXT_MARKER,
  ragContextOf,
  userTextOf,
  withRagContext,
} from '../../srv/lib/rag-context-marker';

test('context access depends on message provenance, never marker text', () => {
  const content = `client${RAG_CONTEXT_MARKER}client words`;
  const original = { content };
  const message = withRagContext(original, 'retrieved');
  expect(userTextOf(message)).toBe(content);
  expect(ragContextOf(message)).toBe('retrieved');
  expect(ragContextOf(original)).toBeUndefined();
  expect(ragContextOf({ ...message })).toBeUndefined();
  expect(userTextOf(original)).toBe(content);
  expect(original.content).toBe(content);
});

test('null user text and empty context retain provenance', () => {
  const message = withRagContext({ content: null as string | null }, '');
  expect(userTextOf(message)).toBe('');
  expect(ragContextOf(message)).toBe('');
});
