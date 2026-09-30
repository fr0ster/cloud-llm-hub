/**
 * Every composite key of a user and a session is a tuple, never a join.
 *
 * A join keeps two pairs apart only while no value contains the separator, and
 * the session half comes from a cookie a caller can write. Two stores still
 * joined theirs: the verbatim history (user and session joined by U+0000) and
 * the recall owner (joined by a colon). Neither key reaches disk — both stores
 * live in memory for the life of the process — so changing the shape needs no
 * migration.
 */

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: undefined,
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/agent-manager', () => ({
  getSharedHistoryRag: () => undefined,
  isProvidersReady: () => true,
}));

import { turnOwner } from '../../srv/lib/session-history-rag';
import {
  appendToSession,
  clearSession,
  getSessionHistory,
  hasSessionHistory,
} from '../../srv/session-store';

/** U+0000, built at runtime so no raw control byte sits in the source. */
const NUL = String.fromCharCode(0);

describe('the verbatim history', () => {
  afterEach(() => {
    clearSession(`b${NUL}c`, 'a');
    clearSession('c', `a${NUL}b`);
  });

  it('keeps two pairs apart that a NUL-joined key would merge', () => {
    // Joined by U+0000, ("a", "b<NUL>c") and ("a<NUL>b", "c") are one key.
    appendToSession('c', `a${NUL}b`, { role: 'user', content: 'theirs' });
    expect(getSessionHistory(`b${NUL}c`, 'a')).toEqual([]);
    expect(hasSessionHistory(`b${NUL}c`, 'a')).toBe(false);
    expect(getSessionHistory('c', `a${NUL}b`)).toHaveLength(1);
  });
});

describe('the recall owner', () => {
  it('keeps two pairs apart that a colon-joined owner would merge', () => {
    expect(turnOwner('alice:x', 'y')).not.toBe(turnOwner('alice', 'x:y'));
  });

  it('is the tuple every other composite key uses', () => {
    expect(turnOwner('alice', 's-1')).toBe(JSON.stringify(['alice', 's-1']));
  });
});
