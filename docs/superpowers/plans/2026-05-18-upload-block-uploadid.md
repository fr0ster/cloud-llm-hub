# Upload UI blocking + uploadId disambiguator — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two upload integrity gaps: (a) the UI is not blocked during upload so users fire parallel chat requests that thrash the embedder, producing false-positive "incomplete export" reports; (b) repeat uploads of the same filename silently overwrite each other in the in-memory store.

**Architecture:** Server adds a per-upload `uploadId` (UUID) into `doc.id` and `metadata.uploadId`. Client `rag-export.js` updates `groupChunksBySource` to key groups by `JSON.stringify([source, uploadId])` with a `_legacy` fallback for old data; exports a `groupKey()` helper. Client `index.html` replaces the boolean `setInputEnabled` with a Set-based shared lock keyed by distinct reasons (`bootstrap`, `chat-pending`, `upload:quick`, `upload:manage`). Both upload entry points hold the shared lock; the Manage Upload button is additionally disabled whenever any upload-reason is active. No new endpoints. No schema migrations.

**Tech Stack:** TypeScript (server), plain JS (browser, UMD), Jest + ts-jest, JSZip, Node `crypto.randomUUID()`.

---

## File Structure

- `srv/rag-handler.ts` (modify) — generate `uploadId` once per `POST /v1/rag/collections/:id/upload` call; embed short prefix in `doc.id`, full UUID in `metadata.uploadId`.
- `app/chat/webapp/rag-export.js` (modify) — export `groupKey(metadata)`; change `groupChunksBySource` return shape to `{ groups: Map<groupKey, { source, uploadId, docs, warnings }>, orphans }`; extend `reassembleSource(group, safeName, uploadId, warnings)` to write `uploadId` into the sidecar when present.
- `app/chat/webapp/index.html` (modify) — new `lockInput`/`unlockInput`/`applyInputLock` shared lock with distinct-reasons vocabulary; new `setManageFormBusy` helper; migrate `setInputEnabled` call sites; both upload paths wrap their work in `try/finally` with lock acquisition; consumer migration in `buildCollectionZipBlob` and `downloadSourceFile` to the new group shape.
- `test/unit/rag-export.test.ts` (modify) — update existing `groupChunksBySource` and `reassembleSource` tests to the new shape; add new tests for `groupKey`, composite-key grouping (two uploads same source), `_legacy` fallback, sidecar `uploadId` field.

Spec reference: `docs/superpowers/specs/2026-05-18-upload-block-uploadid-design.md`.

---

## Task 1: Orient (no commit)

**Files:** none.

- [ ] **Step 1: Confirm the upload handler shape**

```bash
sed -n '425,475p' srv/rag-handler.ts
```

Expected: handler builds `docs` array by mapping `chunks`, sets `id: ${slugify(name)}-chunk-NNN`, `metadata: { source, description, chunkIndex, totalChunks }`. The fix in Task 2 inserts a `uploadId = crypto.randomUUID()` line and changes id format + metadata.

- [ ] **Step 2: Confirm the existing rag-export shape and tests**

```bash
sed -n '1,40p' app/chat/webapp/rag-export.js
grep -n "groupChunksBySource\|reassembleSource\|safeSourceExportName" app/chat/webapp/rag-export.js | head -10
grep -n "describe(" test/unit/rag-export.test.ts | head -10
```

Expected: UMD module exports three helpers; returns `{ groups: Map<source, doc[]>, orphans, warningsBySource: Map<source, string[]> }`. Tests have `groupChunksBySource` and `reassembleSource` describe blocks.

- [ ] **Step 3: Confirm `setInputEnabled` and its current callers**

```bash
grep -n "setInputEnabled\|userInput.disabled\|sendBtn.disabled" app/chat/webapp/index.html
```

Expected: `setInputEnabled(enabled)` at ~line 776 toggles `userInput.disabled` and `sendBtn.disabled`. Callers in `sendMessage` and the model-bootstrap path. `attach-btn` is NOT in this function.

- [ ] **Step 4: Confirm the current ZIP-builder consumes the old group shape**

```bash
grep -n "groupChunksBySource\|reassembleSource\|warningsBySource" app/chat/webapp/index.html | head -15
```

Expected: `buildCollectionZipBlob` (~line 1952 pre-merge, may have shifted) destructures `{ groups, orphans, warningsBySource }` and iterates `for (const [source, group] of groups.entries()) { safeSourceExportName(source, ...) ; reassembleSource(group, safeName, ws) }`. `downloadSourceFile` does `groups.get(sourceName)`. Both must change in Task 4.

No commit. Proceed.

---

## Task 2: Server — uploadId in `doc.id` and `metadata` (TDD-light)

**Files:**
- Modify: `srv/rag-handler.ts`

The server-side change is small and self-contained. Server tests for the upload handler don't exist today (integration-style); we verify via the client side later (Task 4 uses fixtures that stamp `metadata.uploadId` directly). Manual smoke covers the wire format.

- [ ] **Step 1: Modify the upload handler**

In `srv/rag-handler.ts`, locate the `POST /v1/rag/collections/:id/upload` handler block (search for `'/rag/collections/:id/upload'`). Find the `docs = chunks.map(...)` assignment.

Replace the existing mapping:

```typescript
const docs = chunks.map((text, i) => ({
  id: `${slugify(name)}-chunk-${String(i + 1).padStart(3, '0')}`,
  text,
  metadata: {
    source: name,
    description: description || undefined,
    chunkIndex: i,
    totalChunks: chunks.length,
  },
}));
```

with:

```typescript
const uploadId = crypto.randomUUID();
const uploadIdShort = uploadId.slice(0, 8);
const docs = chunks.map((text, i) => ({
  id: `${slugify(name)}-${uploadIdShort}-chunk-${String(i + 1).padStart(3, '0')}`,
  text,
  metadata: {
    source: name,
    uploadId,
    description: description || undefined,
    chunkIndex: i,
    totalChunks: chunks.length,
  },
}));
```

If `crypto` is not yet imported at the top of the file, add `import crypto from 'node:crypto';` (Node 18+, standard library).

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Verify existing unit tests still pass**

Run: `npm run test:unit`
Expected: all green. Existing tests don't exercise this handler directly; this is a smoke pass.

- [ ] **Step 4: Commit**

```bash
git add srv/rag-handler.ts
git commit -m "feat(rag): stamp uploadId on every chunk uploaded via /upload handler"
```

---

## Task 3: `rag-export.js` — new shape + `groupKey` + uploadId in reassembleSource (TDD)

**Files:**
- Modify: `app/chat/webapp/rag-export.js`
- Modify: `test/unit/rag-export.test.ts`

This is the biggest, breaking-change task. The module's `groupChunksBySource` return shape changes from `Map<source, doc[]>` to `Map<groupKey, { source, uploadId, docs, warnings }>`. Existing tests must be rewritten; the consumer in `index.html` must be updated in Task 4 (don't run smoke between these two tasks — the build is intentionally inconsistent until Task 4 lands).

- [ ] **Step 1: Add failing tests for the new shape and `groupKey`**

Replace the existing `groupChunksBySource` test block in `test/unit/rag-export.test.ts` with these tests (and ADD the `groupKey` block). Note: this REWRITES existing tests — old test code goes away, new test code below replaces it.

Find:

```typescript
describe('groupChunksBySource', () => {
```

Replace the entire describe block (everything between `describe('groupChunksBySource', ...)` and its closing `});`) with:

```typescript
describe('groupKey', () => {
  it('returns null for orphan metadata', () => {
    expect(RagExport.groupKey({})).toBeNull();
    expect(RagExport.groupKey(null as any)).toBeNull();
    expect(RagExport.groupKey({ chunkIndex: 0 })).toBeNull();
  });

  it('encodes (source, uploadId) as JSON', () => {
    expect(RagExport.groupKey({ source: 'a.md', uploadId: 'u1' })).toBe(
      JSON.stringify(['a.md', 'u1']),
    );
  });

  it('falls back to _legacy when uploadId is missing', () => {
    expect(RagExport.groupKey({ source: 'a.md' })).toBe(
      JSON.stringify(['a.md', '_legacy']),
    );
  });

  it('keeps the source string verbatim — | in name is safe', () => {
    const key = RagExport.groupKey({ source: 'weird|name.md', uploadId: 'u1' });
    expect(key).toBe(JSON.stringify(['weird|name.md', 'u1']));
    // Different source with the same combined string under a different
    // split must produce a different key.
    const other = RagExport.groupKey({ source: 'weird', uploadId: 'name.md|u1' });
    expect(other).not.toBe(key);
  });
});

describe('groupChunksBySource', () => {
  function makeDoc(
    id: string,
    source: string,
    chunkIndex: number,
    totalChunks: number,
    extra: { uploadId?: string; text?: string } = {},
  ) {
    return {
      id,
      text: extra.text ?? 'x',
      metadata: {
        source,
        chunkIndex,
        totalChunks,
        ...(extra.uploadId ? { uploadId: extra.uploadId } : {}),
      },
    };
  }

  it('groups chunks of one upload into one entry', () => {
    const docs = [
      makeDoc('a-0', 'a.md', 0, 2, { uploadId: 'u1' }),
      makeDoc('a-1', 'a.md', 1, 2, { uploadId: 'u1' }),
    ];
    const { groups, orphans } = RagExport.groupChunksBySource(docs);
    expect(orphans).toEqual([]);
    expect(groups.size).toBe(1);
    const entry = groups.get(JSON.stringify(['a.md', 'u1']));
    expect(entry).toBeDefined();
    expect(entry!.source).toBe('a.md');
    expect(entry!.uploadId).toBe('u1');
    expect(entry!.docs.map((d: any) => d.id)).toEqual(['a-0', 'a-1']);
    expect(entry!.warnings).toEqual([]);
  });

  it('groups two uploads of the same source into separate entries', () => {
    const docs = [
      makeDoc('a-u1-0', 'a.md', 0, 2, { uploadId: 'u1' }),
      makeDoc('a-u1-1', 'a.md', 1, 2, { uploadId: 'u1' }),
      makeDoc('a-u2-0', 'a.md', 0, 2, { uploadId: 'u2' }),
      makeDoc('a-u2-1', 'a.md', 1, 2, { uploadId: 'u2' }),
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    expect(groups.size).toBe(2);
    expect(groups.get(JSON.stringify(['a.md', 'u1']))!.docs.length).toBe(2);
    expect(groups.get(JSON.stringify(['a.md', 'u2']))!.docs.length).toBe(2);
  });

  it('legacy entries (no uploadId) fall under _legacy group', () => {
    const docs = [
      makeDoc('a-0', 'a.md', 0, 2), // no uploadId
      makeDoc('a-1', 'a.md', 1, 2), // no uploadId
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    expect(groups.size).toBe(1);
    const entry = groups.get(JSON.stringify(['a.md', '_legacy']));
    expect(entry).toBeDefined();
    expect(entry!.uploadId).toBe('_legacy');
    expect(entry!.docs.length).toBe(2);
  });

  it('mixes uploadId-stamped and legacy in separate entries', () => {
    const docs = [
      makeDoc('legacy-0', 'a.md', 0, 1),
      makeDoc('u1-0', 'a.md', 0, 1, { uploadId: 'u1' }),
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    expect(groups.size).toBe(2);
    expect(groups.get(JSON.stringify(['a.md', '_legacy']))).toBeDefined();
    expect(groups.get(JSON.stringify(['a.md', 'u1']))).toBeDefined();
  });

  it('docs without metadata.source go to orphans', () => {
    const docs = [
      { id: 'standalone', text: 'x', metadata: {} },
      makeDoc('a-0', 'a.md', 0, 1, { uploadId: 'u1' }),
    ];
    const { groups, orphans } = RagExport.groupChunksBySource(docs);
    expect(groups.size).toBe(1);
    expect(orphans.map((d: any) => d.id)).toEqual(['standalone']);
  });

  it('docs with non-integer chunkIndex go to orphans', () => {
    const docs = [
      { id: 'bad', text: 'x', metadata: { source: 'a.md', chunkIndex: 'foo' } },
      makeDoc('a-0', 'a.md', 0, 1, { uploadId: 'u1' }),
    ];
    const { groups, orphans } = RagExport.groupChunksBySource(docs as any);
    expect(groups.size).toBe(1);
    expect(orphans.map((d: any) => d.id)).toEqual(['bad']);
  });

  it('sorts docs within a group by chunkIndex', () => {
    const docs = [
      makeDoc('a-2', 'a.md', 2, 3, { uploadId: 'u1' }),
      makeDoc('a-0', 'a.md', 0, 3, { uploadId: 'u1' }),
      makeDoc('a-1', 'a.md', 1, 3, { uploadId: 'u1' }),
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    const entry = groups.get(JSON.stringify(['a.md', 'u1']));
    expect(entry!.docs.map((d: any) => d.id)).toEqual(['a-0', 'a-1', 'a-2']);
  });

  it('collects per-source warnings into the entry.warnings field', () => {
    const docs = [
      makeDoc('a-0', 'a.md', 0, 3, { uploadId: 'u1' }),
      makeDoc('a-2', 'a.md', 2, 3, { uploadId: 'u1' }), // gap at 1
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    const entry = groups.get(JSON.stringify(['a.md', 'u1']));
    expect(entry!.warnings.length).toBeGreaterThan(0);
  });

  it('keeps duplicate chunkIndex and inconsistent totalChunks warnings', () => {
    const docs = [
      makeDoc('a-0', 'a.md', 0, 2, { uploadId: 'u1' }),
      makeDoc('a-0b', 'a.md', 0, 3, { uploadId: 'u1' }),
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    const entry = groups.get(JSON.stringify(['a.md', 'u1']));
    expect(entry!.warnings.some((w: string) => /duplicate chunk index 0/.test(w))).toBe(true);
    expect(entry!.warnings.some((w: string) => /inconsistent totalChunks/.test(w))).toBe(true);
  });
});
```

The `reassembleSource` tests already exist — UPDATE them to assert `uploadId` in the sidecar. Find:

```typescript
describe('reassembleSource', () => {
```

In each existing test that calls `RagExport.reassembleSource(...)`, the call signature changes from `(group, safeName, warnings)` to `(group, safeName, uploadId, warnings)`. Update each call site to insert an `uploadId` arg between `safeName` and `warnings`. Also add the following NEW tests inside this describe block:

```typescript
  it('writes uploadId into the sidecar when provided', () => {
    const group = [
      {
        id: 'a-0',
        text: 'x',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
        createdAt: '2026-05-18T10:00:00Z',
      },
    ];
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', 'u1', []);
    const parsed = JSON.parse(sidecar.body);
    expect(parsed.uploadId).toBe('u1');
  });

  it('omits uploadId from the sidecar for legacy groups', () => {
    const group = [
      {
        id: 'a-0',
        text: 'x',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
        createdAt: '2026-05-18T10:00:00Z',
      },
    ];
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', undefined, []);
    const parsed = JSON.parse(sidecar.body);
    expect('uploadId' in parsed).toBe(false);
  });
```

For test files: update ALL existing `reassembleSource(group, safeName, warnings)` calls to `reassembleSource(group, safeName, undefined, warnings)` (legacy-shape parameter omitted) so they remain backward-compatible signal tests. The shape change is additive (new param sits in position 3, was previously `warnings`).

- [ ] **Step 2: Run tests — expect compile-time fail on the new tests AND the `reassembleSource` signature mismatch**

Run: `npm run test:unit -- --testPathPatterns="rag-export"`
Expected: failures including `groupKey is not a function`, `groups.get(...).source is undefined`, sidecar `uploadId` assertions. The `reassembleSource` argument-position update may still pass if your editor auto-applied the change; the new sidecar-uploadId tests will fail.

- [ ] **Step 3: Update `rag-export.js` with `groupKey` export + new return shape + `reassembleSource` uploadId**

Open `app/chat/webapp/rag-export.js`. Replace the body of `groupChunksBySource` and `reassembleSource` to match the new contract; add `groupKey` and export it.

Replace `groupChunksBySource` (find the existing `function groupChunksBySource(docs) { ... }`) with:

```javascript
  function groupKey(metadata) {
    const source = metadata && metadata.source;
    if (!source) return null;
    const uploadId = (metadata && metadata.uploadId) || '_legacy';
    // JSON-encode so any character in `source` (e.g. `|`) is unambiguous.
    return JSON.stringify([source, uploadId]);
  }

  function groupChunksBySource(docs) {
    const groups = new Map();
    const orphans = [];
    for (const doc of docs) {
      const md = doc && doc.metadata;
      const key = groupKey(md);
      const idx = md && md.chunkIndex;
      if (!key || !Number.isInteger(idx)) {
        orphans.push(doc);
        continue;
      }
      let entry = groups.get(key);
      if (!entry) {
        entry = {
          source: md.source,
          uploadId: md.uploadId || '_legacy',
          docs: [],
          warnings: [],
        };
        groups.set(key, entry);
      }
      entry.docs.push(doc);
    }
    for (const entry of groups.values()) {
      entry.docs.sort(
        (a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex,
      );

      // Preserve the old integrity checks, but attach warnings to this
      // upload-specific entry instead of warningsBySource.
      const seen = new Set();
      for (const d of entry.docs) {
        const i = d.metadata.chunkIndex;
        if (seen.has(i)) {
          entry.warnings.push('⚠ ' + entry.source + ': duplicate chunk index ' + i);
        }
        seen.add(i);
      }

      const present = new Set(entry.docs.map((d) => d.metadata.chunkIndex));
      const max = Math.max(...entry.docs.map((d) => d.metadata.chunkIndex));
      const missing = [];
      for (let i = 0; i <= max; i += 1) if (!present.has(i)) missing.push(i);
      if (missing.length) {
        entry.warnings.push(
          '⚠ ' + entry.source + ': ' + missing.length + ' chunks missing (indices ' + missing.join(',') + ')',
        );
      }

      const totals = Array.from(
        new Set(
          entry.docs
            .map((d) => d.metadata.totalChunks)
            .filter((v) => Number.isInteger(v)),
        ),
      );
      if (totals.length > 1) {
        entry.warnings.push(
          '⚠ ' + entry.source + ': inconsistent totalChunks (' + totals.join(' vs ') + ')',
        );
      } else if (totals.length === 1 && totals[0] !== entry.docs.length) {
        entry.warnings.push(
          '⚠ ' + entry.source + ': expected ' + totals[0] + ' chunks, found ' + entry.docs.length,
        );
      }
    }
    return { groups, orphans };
  }
```

Replace `reassembleSource` (find the existing function) with this updated signature:

```javascript
  function reassembleSource(group, safeName, uploadId, warnings) {
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error('reassembleSource: group cannot be empty');
    }
    const docs = group.slice().sort(
      (a, b) =>
        ((a.metadata && a.metadata.chunkIndex) || 0) -
        ((b.metadata && b.metadata.chunkIndex) || 0),
    );
    const body = docs.map((d) => d.text).join('\n\n');
    const description =
      docs[0] && docs[0].metadata && docs[0].metadata.description;
    const totalChunks =
      docs[0] && docs[0].metadata && docs[0].metadata.totalChunks;
    const createdAt = docs.reduce((min, d) => {
      const cur = d.createdAt;
      if (!cur) return min;
      return !min || cur < min ? cur : min;
    }, null);
    const provenance = {
      source: docs[0].metadata.source,
      exportName: safeName,
    };
    if (uploadId) provenance.uploadId = uploadId;
    if (description) provenance.description = description;
    if (typeof totalChunks === 'number') provenance.totalChunks = totalChunks;
    provenance.reassembledFrom = docs.map((d) => d.id);
    if (createdAt) provenance.createdAt = createdAt;
    // Sidecar always carries a `warnings` array (possibly empty) — preserves
    // the pre-existing #89 contract that downstream tests assert against.
    provenance.warnings = warnings ? warnings.slice() : [];
    return {
      name: safeName,
      body,
      sidecar: {
        name: safeName + '.meta.json',
        body: JSON.stringify(provenance, null, 2),
      },
    };
  }
```

Update the module's `return` (UMD factory body) to include `groupKey`:

```javascript
  return { groupChunksBySource, safeSourceExportName, reassembleSource, groupKey };
```

- [ ] **Step 4: Run tests — expect green**

Run: `npm run test:unit -- --testPathPatterns="rag-export"`
Expected: all updated and new tests pass (groupKey, two-uploads-same-source, _legacy fallback, mixed, orphans, sort, warnings, reassembleSource uploadId-yes, uploadId-no).

- [ ] **Step 5: Run full unit suite to catch regressions**

Run: `npm run test:unit`
Expected: only `rag-export` test file affected — the other suites (`exposition`, `rag-collections-bulk`) should pass untouched.

- [ ] **Step 6: Run both tsc passes**

Run: `npx tsc --noEmit`
Run: `npx tsc --noEmit --project tsconfig.test.json`
Both: clean.

- [ ] **Step 7: Commit**

```bash
git add app/chat/webapp/rag-export.js test/unit/rag-export.test.ts
git commit -m "feat(rag-export): composite (source, uploadId) group keys + groupKey export"
```

Note: index.html still uses the old return shape after this commit — Task 4 fixes that. Build runs but the chat-UI export modal would fail at runtime until Task 4 lands. Manual smoke is deferred to Task 7.

---

## Task 4: `index.html` consumers — migrate to new group shape

**Files:**
- Modify: `app/chat/webapp/index.html`

- [ ] **Step 1: Update `buildCollectionZipBlob`**

Find the function:

```bash
grep -n "function buildCollectionZipBlob\|buildCollectionZipBlob =" app/chat/webapp/index.html
```

The function currently destructures `{ groups, orphans, warningsBySource }` from `RagExport.groupChunksBySource(filtered)`, where `filtered` is the existing local variable created earlier in `buildCollectionZipBlob`. Keep using that existing `filtered` variable; do not introduce `filteredDocs`.

```javascript
const { groups, orphans } = RagExport.groupChunksBySource(filtered);
const warningsBySource = new Map(); // keyed by groupKey; flatten in the renderer
const used = new Set();

for (const [key, entry] of groups.entries()) {
  const { source, uploadId, docs: groupDocs, warnings } = entry;
  if (warnings && warnings.length) warningsBySource.set(key, warnings);
  if (includeReassembled) {
    const safeName = RagExport.safeSourceExportName(source, used);
    const { name, body, sidecar } = RagExport.reassembleSource(
      groupDocs,
      safeName,
      uploadId === '_legacy' ? undefined : uploadId,
      warnings,
    );
    // Use accountAndPut so the 50 MB cap (EXPORT_MAX_UNCOMPRESSED_BYTES)
    // and the `fileCount` counter stay accurate — the inner helper
    // increments both before delegating to zip.file().
    accountAndPut('reassembled/' + name, body);
    accountAndPut('reassembled/' + sidecar.name, sidecar.body);
    sourceFileCount += 1;
  }
}
```

The original iteration of `filtered` for the `chunks/` folder stays unchanged — that loop emits one zip entry per individual chunk regardless of grouping.

Return value still includes `warningsBySource` so `runCollectionExport`'s existing renderer keeps working:

```javascript
return {
  blob,
  documentCount: filtered.length,
  fileCount,
  sourceFileCount,
  orphanCount: orphans.length,
  chunkCount,
  warningsBySource,
  includedChunks,
  includedReassembled,
};
```

- [ ] **Step 2: Update `downloadSourceFile`**

Find:

```bash
grep -n "function downloadSourceFile\|async function downloadSourceFile" app/chat/webapp/index.html
```

Replace the lookup chunk (currently something like `groups.get(sourceName)`) with the new composite-key path:

```javascript
async function downloadSourceFile(collection, docId) {
  // ... fetch and locate the clicked doc ...
  const all = /* existing fetchAllDocuments result */;
  const filtered = all.filter(/* existing deprecation filter */);
  const clicked = filtered.find((d) => d.id === docId);
  if (!clicked) {
    alert('Document not found.');
    return;
  }
  const key = RagExport.groupKey(clicked.metadata);
  if (!key) {
    alert('This entry is an orphan — cannot reassemble a source file.');
    return;
  }
  const { groups } = RagExport.groupChunksBySource(filtered);
  const entry = groups.get(key);
  if (!entry) {
    alert('No active group remains for this entry.');
    return;
  }
  const { source, uploadId, docs: groupDocs, warnings } = entry;
  const safeName = RagExport.safeSourceExportName(source, new Set());
  const { name, body, sidecar } = RagExport.reassembleSource(
    groupDocs,
    safeName,
    uploadId === '_legacy' ? undefined : uploadId,
    warnings,
  );
  // existing mini-zip + download logic, using `name` and `sidecar` ...
}
```

(The exact surrounding code differs; just replace the lookup-and-reassemble lines while preserving the rest.)

- [ ] **Step 3: Type check and run unit tests**

Run: `npx tsc --noEmit`
Run: `npm run test:unit`
Both: clean.

- [ ] **Step 4: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "refactor(chat-ui): migrate buildCollectionZipBlob and downloadSourceFile to new group shape"
```

Manual smoke at end of plan (Task 7).

---

## Task 5: `index.html` — shared input-lock with distinct reasons

**Files:**
- Modify: `app/chat/webapp/index.html`

- [ ] **Step 1: Add the lock helpers**

Locate the existing `setInputEnabled` definition (around line 776). Immediately ABOVE it (so the new helpers can be referenced by everything that follows), insert:

```javascript
const inputLockReasons = new Set();

function lockInput(reason) {
  inputLockReasons.add(reason);
  applyInputLock();
}

function unlockInput(reason) {
  inputLockReasons.delete(reason);
  applyInputLock();
}

function applyInputLock() {
  const locked = inputLockReasons.size > 0;
  for (const id of ['user-input', 'send-btn', 'attach-btn']) {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  }
  const anyUpload =
    inputLockReasons.has('upload:quick') ||
    inputLockReasons.has('upload:manage');
  const manageBtn = document.querySelector('button[onclick="uploadFile()"]');
  if (manageBtn) manageBtn.disabled = anyUpload || locked;
}
```

- [ ] **Step 2: Rewrite `setInputEnabled` as a thin wrapper for backward compat**

Replace the existing body of `setInputEnabled(enabled)`:

```javascript
function setInputEnabled(enabled) {
  if (enabled) {
    unlockInput('legacy-setInputEnabled');
  } else {
    lockInput('legacy-setInputEnabled');
  }
}
```

This keeps any caller we miss working without surprises. The migration steps below replace it with the proper reasons; once they're done the wrapper can be deleted.

- [ ] **Step 3: Migrate `sendMessage` and bootstrap call sites**

Find every call to `setInputEnabled` and decide:

```bash
grep -n "setInputEnabled\b" app/chat/webapp/index.html
```

For each:

- Inside `sendMessage()` (or wherever the chat submit lives): change `setInputEnabled(false)` → `lockInput('chat-pending')`; the matching `setInputEnabled(true)` (after stream end / failure) → `unlockInput('chat-pending')`.
- Inside the bootstrap path (waiting for models/dest list): `setInputEnabled(false)` → `lockInput('bootstrap')`; matching `setInputEnabled(true)` → `unlockInput('bootstrap')`.

After replacement, run `grep -n "setInputEnabled" app/chat/webapp/index.html` — only the thin wrapper definition should remain (plus possibly an unmigrated call site if the file has more uses; eyeball them).

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): shared input lock keyed by distinct reasons (bootstrap, chat-pending, upload:*)"
```

---

## Task 6: Upload handlers — chat-📎 and Manage with lock

**Files:**
- Modify: `app/chat/webapp/index.html`

- [ ] **Step 1: Add `setManageFormBusy` helper**

Place it near the other UI helpers (just below `setManageFormBusy`'s siblings if there are any, or near `applyInputLock`):

```javascript
function setManageFormBusy(busy) {
  const ids = ['rag-file-input', 'rag-chunk-size', 'rag-file-desc'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
  const btn = document.querySelector('button[onclick="uploadFile()"]');
  if (btn) btn.disabled = busy;
}
```

- [ ] **Step 2: Wrap `handleQuickFileAttach` in try/finally with `lockInput('upload:quick')`**

Find:

```bash
grep -n "function handleQuickFileAttach\|async function handleQuickFileAttach" app/chat/webapp/index.html
```

Add the lock at the moment the user accepts the description prompt (before the first `ragFetch`) and release in `finally`:

```javascript
async function handleQuickFileAttach(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';

  const description = prompt(
    'Describe this file (used to disambiguate when searching).',
  );
  if (description === null) return;

  lockInput('upload:quick');
  try {
    // existing upload flow (fetch, push to attachedFiles, render bar, alert on partial)
  } finally {
    unlockInput('upload:quick');
  }
}
```

- [ ] **Step 3: Wrap `uploadFile` (Manage panel) similarly**

```javascript
async function uploadFile() {
  // ... existing input validation (file selected, etc.) ...

  setManageFormBusy(true);
  lockInput('upload:manage');
  try {
    // existing fetch + status text + loadDocuments() refresh
  } finally {
    setManageFormBusy(false);
    unlockInput('upload:manage');
  }
}
```

- [ ] **Step 4: Type check + run unit tests**

Run: `npx tsc --noEmit`
Run: `npm run test:unit`
Both: clean.

- [ ] **Step 5: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): chat-📎 and Manage uploads hold the shared input lock during upload"
```

---

## Task 7: Verification, cleanup, PR

**Files:** spec + plan are deleted in the cleanup commit.

- [ ] **Step 1: Full test pass**

Run: `npm run test:unit`
Expected: all suites green. New `rag-export` suite has 8 groupKey tests, 7 groupChunksBySource tests, 2 added `reassembleSource` uploadId tests (plus the existing `reassembleSource` cases updated for the new positional uploadId arg).

- [ ] **Step 2: Lint + both tsc**

Run: `npm run lint:check`
Run: `npx tsc --noEmit`
Run: `npx tsc --noEmit --project tsconfig.test.json`
All: clean.

- [ ] **Step 3: Manual smoke against deploy** (post-PR-merge + redeploy)

After PR merge and redeploy to `deploy/acme-sandbox/dev`:

1. **UI lock — chat-📎:** click attach, choose a file, accept the description prompt. `#user-input` shows greyed out, Send button greyed out, attach button greyed out, Manage Upload button (if Manage panel is open) greyed out. Try clicking Send and typing — no effect. Upload completes; everything re-enabled.
2. **UI lock — Manage:** open Manage → pick a file → click Upload. Same surface disabled. Status line still shows `Uploaded: N chunks, M added` (red on partial per #93).
3. **uploadId — two uploads same source:**
   - Via chat-📎: attach `note.md`, accept description, wait for completion. Attach `note.md` again (different content optional). The attached-files bar shows two distinct entries.
   - Via Manage: upload `note.md` to a test collection. Refresh doc list — should see N chunks with prefix `note-md-<short-uuid-A>-chunk-...`. Upload `note.md` again. Now doc list shows 2N chunks with two different short-uuid prefixes. Bulk Export → ZIP contains `reassembled/note.md` AND `reassembled/note-1.md`; each `.meta.json` has its own `uploadId` field.
4. **Legacy collection compat:** open a collection created before this PR (pre-uploadId chunks). Bulk export still works; the sidecar omits `uploadId` for those reassembled files.
5. **Per-entry SRC button:** in Manage panel, click `SRC` on a chunk from the second upload of `note.md`. The downloaded mini-zip body matches the second upload, not a merge of both uploads.

- [ ] **Step 4: Delete spec + plan, open PR**

```bash
git rm docs/superpowers/specs/2026-05-18-upload-block-uploadid-design.md \
       docs/superpowers/plans/2026-05-18-upload-block-uploadid.md
git commit -m "chore: remove implemented spec/plan for upload UI block + uploadId"
git push -u origin upload-block-uploadid
gh pr create --base main --head upload-block-uploadid \
  --title "fix(rag): block UI during upload + uploadId disambiguator for repeat uploads" \
  --body "Closes #94.

## Summary
- Shared input-lock keyed by distinct reasons (bootstrap, chat-pending, upload:quick, upload:manage); chat-📎 and Manage uploads both hold it; Manage Upload button additionally disabled whenever any upload reason is active.
- Server stamps a per-upload uploadId (UUID) into doc.id and metadata.uploadId so repeat uploads of the same filename produce separate doc sets.
- groupChunksBySource keys groups by JSON.stringify([source, uploadId]) with a _legacy fallback for pre-fix entries; sidecar gains a uploadId field; reassembleSource takes uploadId as a positional arg.

## Test plan
- [x] Full unit suite green (new rag-export tests for groupKey, composite grouping, _legacy fallback, sidecar uploadId).
- [x] root tsc + test tsc + lint clean.
- [ ] Manual smoke on acme-sandbox/dev: UI lock visible during both upload paths; two uploads of the same filename produce two doc sets and two reassembled files in ZIP; legacy collections still reassemble correctly.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
