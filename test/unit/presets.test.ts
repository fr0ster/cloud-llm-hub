jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import {
  ensurePresets,
  loadPackDocuments,
  PRESET_PACKS,
  presetCollectionId,
  sanitizeUserKey,
} from '../../srv/presets';
import { CollectionRegistry } from '../../srv/rag-collections';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const fakeLoader = (key: string) =>
  key === 'rap-skills'
    ? [{ id: 'creating-domain', text: 'A' }]
    : [
        { id: 'phase-procedure', text: 'B' },
        { id: 'strict-mode-2', text: 'C' },
      ];

// ---------------------------------------------------------------------------

describe('preset ids', () => {
  test('sanitizeUserKey is lowercase hex, fixed length, deterministic, no PII', () => {
    const k1 = sanitizeUserKey('Oleksii@Example.COM');
    const k2 = sanitizeUserKey('Oleksii@Example.COM');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[a-f0-9]{16}$/);
    expect(k1).not.toContain('Oleksii');
    expect(k1).not.toContain('@');
  });

  test('presetCollectionId is URL/filesystem-safe and user-prefixed', () => {
    const id = presetCollectionId('rap-skills', 'user/with@bad.chars');
    expect(id).toMatch(/^rap-skills__u_[a-f0-9]{16}$/);
    expect(id).toMatch(/^[a-z0-9_-]+$/);
  });

  test('PRESET_PACKS declares rap-skills and rap-context', () => {
    expect(PRESET_PACKS.map((p) => p.key).sort()).toEqual([
      'rap-context',
      'rap-skills',
    ]);
    for (const p of PRESET_PACKS) {
      expect(p.displayName).toBeTruthy();
      expect(p.dir).toBe(p.key);
    }
  });
});

describe('loadPackDocuments', () => {
  test('reads .md files as docs with filename-without-ext ids, skips README', () => {
    const docs = loadPackDocuments('rap-context');
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toContain('phase-procedure');
    expect(ids).not.toContain('README');
    for (const d of docs) {
      expect(d.id).toMatch(/^[a-z0-9-]+$/);
      expect(d.text.length).toBeGreaterThan(0);
    }
  });

  test('unknown pack returns empty list', () => {
    expect(loadPackDocuments('does-not-exist')).toEqual([]);
  });
});

describe('ensurePresets', () => {
  test('creates per-user collections (scope user) and seeds docs', async () => {
    const reg = new CollectionRegistry(); // in-memory backend
    await ensurePresets(reg, 'alice', fakeLoader);
    const skillsId = presetCollectionId('rap-skills', 'alice');
    const ctxId = presetCollectionId('rap-context', 'alice');
    const skills = reg.getCollection(skillsId);
    expect(skills?.scope).toBe('user');
    expect(skills?.owner).toBe('alice');
    expect(reg.getDocument(skillsId, 'creating-domain')?.text).toBe('A');
    expect(reg.getDocument(ctxId, 'phase-procedure')?.text).toBe('B');
    expect(reg.getDocument(ctxId, 'strict-mode-2')?.text).toBe('C');
  });

  test('is idempotent — second run adds nothing and does not throw', async () => {
    const reg = new CollectionRegistry();
    await ensurePresets(reg, 'alice', fakeLoader);
    await expect(
      ensurePresets(reg, 'alice', fakeLoader),
    ).resolves.toBeUndefined();
    expect(
      reg.getCollection(presetCollectionId('rap-context', 'alice'))
        ?.documentCount,
    ).toBe(2);
  });

  test('completes a partial seed and never overwrites an edited doc', async () => {
    const reg = new CollectionRegistry();
    await ensurePresets(reg, 'alice', fakeLoader);
    const ctxId = presetCollectionId('rap-context', 'alice');
    await reg.deleteDocument(ctxId, 'strict-mode-2'); // simulate partial seed
    await reg.updateDocument(ctxId, 'phase-procedure', { text: 'EDITED' });
    await ensurePresets(reg, 'alice', fakeLoader);
    expect(reg.getDocument(ctxId, 'strict-mode-2')?.text).toBe('C'); // re-added
    expect(reg.getDocument(ctxId, 'phase-procedure')?.text).toBe('EDITED'); // preserved
  });

  test('two users get non-colliding collections', async () => {
    const reg = new CollectionRegistry();
    await ensurePresets(reg, 'alice', fakeLoader);
    await ensurePresets(reg, 'bob', fakeLoader);
    expect(presetCollectionId('rap-skills', 'alice')).not.toBe(
      presetCollectionId('rap-skills', 'bob'),
    );
    expect(
      reg.getCollection(presetCollectionId('rap-skills', 'bob')),
    ).not.toBeNull();
  });

  test('doc-add failure is swallowed — loop continues and promise resolves', async () => {
    const reg = new CollectionRegistry();
    // Two-doc loader for a single pack so we can make the first doc fail.
    const twoDocLoader = (key: string) =>
      key === 'rap-skills'
        ? [
            { id: 'doc-fail', text: 'will-fail' },
            { id: 'doc-ok', text: 'will-succeed' },
          ]
        : [];

    // Patch addDocument to reject the first call and succeed thereafter.
    const originalAdd = reg.addDocument.bind(reg);
    let calls = 0;
    reg.addDocument = async (...args: Parameters<typeof reg.addDocument>) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated embedding failure');
      return originalAdd(...args);
    };

    // Must resolve (not throw) even though one doc failed.
    await expect(
      ensurePresets(reg, 'alice', twoDocLoader),
    ).resolves.toBeUndefined();

    // The second doc must have been attempted and stored.
    const skillsId = presetCollectionId('rap-skills', 'alice');
    expect(reg.getDocument(skillsId, 'doc-ok')?.text).toBe('will-succeed');
  });
});
