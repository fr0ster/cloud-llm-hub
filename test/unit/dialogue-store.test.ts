jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: { log: () => ({ warn: jest.fn(), debug: jest.fn() }) },
}));

import type { DialogueState } from '@mcp-abap-adt/llm-agent';
import {
  createDialogueStateStore,
  deleteDialogueState,
  hasDialogueState,
  initializeDialogueStore,
  MemoryDialogueStore,
} from '../../srv/lib/dialogue-store';
import { loadSessionConfig } from '../../srv/lib/session-config';

jest.mock('../../srv/agent-manager', () => ({ isProvidersReady: () => false }));

import { hasSessionState } from '../../srv/lib/session-state';

const state: DialogueState = {
  conversation: [{ role: 'user', content: 'hello' }],
  tasks: [],
  pending: [],
  savedAt: 1,
};
beforeEach(() => initializeDialogueStore(loadSessionConfig({})));
it('round trips with explicit owners, isolates equal keys, and deletes', async () => {
  const a = createDialogueStateStore('alice', 'same');
  const b = createDialogueStateStore('bob', 'same');
  await a.save('same', state);
  expect(await a.load('same')).toEqual(state);
  expect(await b.load('same')).toBeUndefined();
  expect(hasSessionState('alice', 'same')).toBe(true);
  expect(hasDialogueState('bob', 'same')).toBe(false);
  await deleteDialogueState('alice', 'same');
  expect(await a.load('same')).toBeUndefined();
});
it('ignores mismatched ids for every operation', async () => {
  const s = createDialogueStateStore('alice', 'key');
  await s.save('wrong', state);
  expect(await s.load('key')).toBeUndefined();
  await s.save('key', state);
  await s.delete('wrong');
  expect(await s.load('wrong')).toBeUndefined();
  expect(await s.load('key')).toEqual(state);
  await s.delete('key');
  expect(await s.load('key')).toBeUndefined();
});
it('bounds memory, clones state, and applies the TTL backstop and sweep', async () => {
  const s = new MemoryDialogueStore(1, 100);
  await s.save('a', 'k', state);
  const copy = await s.load('a', 'k');
  if (!copy) throw new Error('missing state');
  copy.conversation.length = 0;
  expect((await s.load('a', 'k'))?.conversation).toHaveLength(1);
  await s.save('b', 'k', state);
  expect(await s.load('a', 'k')).toBeUndefined();
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 101);
  try {
    expect(s.hasDialogueState('b', 'k')).toBe(false);
    expect(await s.load('b', 'k')).toBeUndefined();
    await s.sweepExpired(Date.now());
  } finally {
    now.mockRestore();
  }
});
it.each([
  { ...state, conversation: Array(201).fill({ role: 'user', content: 'x' }) },
  { ...state, conversation: [{ role: 'user', content: 'x'.repeat(20001) }] },
  { ...state, tasks: Array(51).fill({}) },
  { ...state, plan: '\u{1f600}'.repeat(600000) },
])('rejects invalid or oversized states without truncating', async (value) => {
  const s = createDialogueStateStore('alice', 'k');
  await s.save('k', value as DialogueState);
  expect(await s.load('k')).toBeUndefined();
});
