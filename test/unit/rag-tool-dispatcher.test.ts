/**
 * Unit tests for rag-tool-dispatcher Task 5 behaviour:
 * - resolves collection names to the caller's private physical id
 * - auto-creates the collection on rag_add (user vs session scope)
 * - rejects __ in collection names
 * - rejects anonymous callers
 */

// --- CDS mock (must be before any import that transitively loads @sap/cds) ---
// We expose a mutable `context` object so individual tests can set user.id.
const mockCdsContext: { user?: { id: string } } = {};
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return mockCdsContext;
      },
    },
  }),
  { virtual: true },
);

// --- request-session mock: let each test set the active session id ----------
let mockSessionId: string | undefined;
jest.mock('../../srv/request-session', () => ({
  getRequestSessionId: () => mockSessionId,
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
}));

import { sanitizeUserKey, sessionCollectionId } from '../../srv/collection-ids';
import { CollectionRegistry } from '../../srv/rag-collections';
import { dispatchRagTool } from '../../srv/rag-tool-dispatcher';

// Helper: set the authenticated caller for the current test.
function asUser(id: string) {
  mockCdsContext.user = { id };
}
function asAnonymous() {
  mockCdsContext.user = undefined;
}

describe('dispatchRagTool — collection resolution', () => {
  beforeEach(() => {
    mockSessionId = undefined;
    asAnonymous();
  });

  test('rag_add without session creates a user-scoped collection (<logical>__u_<key>)', async () => {
    asUser('alice@example.com');
    const reg = new CollectionRegistry();
    const result = await dispatchRagTool(reg, 'rag_add', {
      collection: 'result',
      text: 'hello',
    });
    expect(result.ok).toBe(true);
    const expectedId = `result__u_${sanitizeUserKey('alice@example.com')}`;
    const meta = reg.getCollection(expectedId);
    expect(meta).not.toBeNull();
    expect(meta?.scope).toBe('user');
    expect(meta?.owner).toBe('alice@example.com');
    expect(meta?.logicalId).toBe('result');
  });

  test('rag_add with a session creates a session-scoped collection (<logical>__s_<key>)', async () => {
    asUser('alice@example.com');
    mockSessionId = 'sess-abc';
    const reg = new CollectionRegistry();
    const result = await dispatchRagTool(reg, 'rag_add', {
      collection: 'result',
      text: 'hello',
    });
    expect(result.ok).toBe(true);
    const sessionPhysical = sessionCollectionId(
      'result',
      'alice@example.com',
      'sess-abc',
    );
    const meta = reg.getCollection(sessionPhysical);
    expect(meta).not.toBeNull();
    expect(meta?.scope).toBe('session');
    expect(meta?.owner).toBe('alice@example.com');
    expect(meta?.sessionId).toBe('sess-abc');
    expect(meta?.expiresAt).toBeGreaterThan(Date.now());
  });

  test('rag_add with __ in collection name returns an error', async () => {
    asUser('alice@example.com');
    const reg = new CollectionRegistry();
    const result = await dispatchRagTool(reg, 'rag_add', {
      collection: 'bad__name',
      text: 'hello',
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/__/);
  });

  test('rag_add as anonymous returns an error', async () => {
    asAnonymous();
    const reg = new CollectionRegistry();
    const result = await dispatchRagTool(reg, 'rag_add', {
      collection: 'result',
      text: 'hello',
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(
      /Authenticated user required/i,
    );
  });

  test('two users with same logical name get isolated collections', async () => {
    const reg = new CollectionRegistry();

    asUser('alice@example.com');
    await dispatchRagTool(reg, 'rag_add', {
      collection: 'result',
      text: 'alice content',
      id: 'doc-alice',
    });

    asUser('bob@example.com');
    await dispatchRagTool(reg, 'rag_add', {
      collection: 'result',
      text: 'bob content',
      id: 'doc-bob',
    });

    const alicePhysical = `result__u_${sanitizeUserKey('alice@example.com')}`;
    const bobPhysical = `result__u_${sanitizeUserKey('bob@example.com')}`;

    expect(alicePhysical).not.toBe(bobPhysical);
    expect(reg.getCollection(alicePhysical)).not.toBeNull();
    expect(reg.getCollection(bobPhysical)).not.toBeNull();

    // alice's document is NOT visible in bob's collection
    expect(reg.findActiveByCanonicalKey(bobPhysical, 'doc-alice')).toBeNull();
    expect(reg.findActiveByCanonicalKey(alicePhysical, 'doc-bob')).toBeNull();
  });

  test('rag_correct resolves to user collection and updates the document', async () => {
    asUser('alice@example.com');
    const reg = new CollectionRegistry();
    // First add a document.
    await dispatchRagTool(reg, 'rag_add', {
      collection: 'notes',
      text: 'original',
      id: 'note-1',
    });
    // Now correct it.
    const result = await dispatchRagTool(reg, 'rag_correct', {
      collection: 'notes',
      id: 'note-1',
      newText: 'updated',
      reason: 'test',
    });
    expect(result.ok).toBe(true);
    const physical = `notes__u_${sanitizeUserKey('alice@example.com')}`;
    const active = reg.findActiveByCanonicalKey(physical, 'note-1');
    expect(active?.text).toBe('updated');
  });

  test('rag_correct returns error when collection does not exist', async () => {
    asUser('alice@example.com');
    const reg = new CollectionRegistry();
    const result = await dispatchRagTool(reg, 'rag_correct', {
      collection: 'nonexistent',
      id: 'doc-1',
      newText: 'x',
      reason: 'test',
    });
    expect(result.ok).toBe(false);
  });

  test('rag_add twice in same session does not duplicate and refreshes expiresAt', async () => {
    asUser('alice@example.com');
    mockSessionId = 'sess-refresh';
    const reg = new CollectionRegistry();
    const physical = sessionCollectionId(
      'result',
      'alice@example.com',
      'sess-refresh',
    );

    // First add — creates the session collection.
    const r1 = await dispatchRagTool(reg, 'rag_add', {
      collection: 'result',
      text: 'first',
      id: 'doc-refresh',
    });
    expect(r1.ok).toBe(true);

    // Manually set expiresAt to a past value to simulate time passing.
    const meta1 = reg.getCollection(physical);
    expect(meta1).not.toBeNull();
    // Force expiry to the past so the second call must refresh it.
    const pastExpiry = Date.now() - 1000;
    const internals = reg as unknown as {
      collections: Map<string, { meta: { expiresAt?: number } }>;
    };
    const stored = internals.collections.get(physical);
    expect(stored).not.toBeUndefined();
    if (stored) stored.meta.expiresAt = pastExpiry;

    // Second add — collection already exists; should refresh expiresAt, not duplicate.
    const r2 = await dispatchRagTool(reg, 'rag_add', {
      collection: 'result',
      text: 'second',
      id: 'doc-refresh-2',
    });
    expect(r2.ok).toBe(true);

    // Only one collection with this physical id must exist.
    const meta2 = reg.getCollection(physical);
    expect(meta2).not.toBeNull();
    expect(meta2?.scope).toBe('session');

    // expiresAt must have been updated to the future.
    expect(meta2?.expiresAt).toBeGreaterThan(pastExpiry);
    expect(meta2?.expiresAt).toBeGreaterThan(Date.now());
  });

  test('rag_deprecate resolves to user collection and removes the document', async () => {
    asUser('alice@example.com');
    const reg = new CollectionRegistry();
    await dispatchRagTool(reg, 'rag_add', {
      collection: 'notes',
      text: 'to delete',
      id: 'note-del',
    });
    const result = await dispatchRagTool(reg, 'rag_deprecate', {
      collection: 'notes',
      id: 'note-del',
      reason: 'obsolete',
    });
    expect(result.ok).toBe(true);
    const physical = `notes__u_${sanitizeUserKey('alice@example.com')}`;
    expect(reg.findActiveByCanonicalKey(physical, 'note-del')).toBeNull();
  });
});
