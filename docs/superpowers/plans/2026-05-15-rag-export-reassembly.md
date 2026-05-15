# RAG export reassembly — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reverse-decoder to the RAG collection export so chunked source files can be downloaded as single reconstructed files (with a provenance sidecar), both in bulk export and per-entry — without breaking existing chunk-by-chunk export.

**Architecture:** Pure helpers extracted to a new UMD module `app/chat/webapp/rag-export.js` (loadable both as `<script>` and Jest `require`). Existing inline export in `index.html` is wired to the new helpers. No server changes. No metadata schema changes. Reassembly relies on `source` / `chunkIndex` / `totalChunks` already stamped by `srv/rag-handler.ts:400`.

**Tech Stack:** Plain JS (browser + Node), JSZip 3.x (already vendored at `app/chat/webapp/vendor/jszip.min.js`), Jest + ts-jest for unit tests.

---

## File Structure

- `app/chat/webapp/rag-export.js` (create) — three pure helpers in one UMD module: `groupChunksBySource`, `safeSourceExportName`, `reassembleSource`. No DOM, no I/O, no JSZip dependency. Importable both via `<script>` (attaches `window.RagExport`) and via Node `require` (Jest).
- `app/chat/webapp/index.html` (modify) — load the new module, replace inline grouping/reassembly logic in `buildCollectionZipBlob` (~line 1952), add per-entry `SRC` button to `loadDocuments` (~line 1698), add `downloadSourceFile` function, extend export modal with two checkboxes, extend status message wording.
- `test/unit/rag-export.test.ts` (create) — Jest unit tests for the three pure helpers. No browser stubbing needed.

Spec reference: `docs/superpowers/specs/2026-05-15-rag-export-reassembly-design.md`.

---

## Task 1: Scaffold `rag-export.js` UMD module

**Files:**
- Create: `app/chat/webapp/rag-export.js`
- Create: `test/unit/rag-export.test.ts`

- [ ] **Step 1: Create the empty UMD module with a sanity export**

Create `app/chat/webapp/rag-export.js`:

```javascript
// app/chat/webapp/rag-export.js
//
// Pure helpers for the RAG collection export reassembly path.
// No DOM, no JSZip, no fetch — safe to import from Jest.
//
// Loaded in the browser as <script> (attaches window.RagExport) and
// required from Jest in test/unit/rag-export.test.ts.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RagExport = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function groupChunksBySource(_docs) {
    throw new Error('not implemented');
  }
  function safeSourceExportName(_sourceName, _used) {
    throw new Error('not implemented');
  }
  function reassembleSource(_group, _safeName, _warnings) {
    throw new Error('not implemented');
  }
  return { groupChunksBySource, safeSourceExportName, reassembleSource };
});
```

- [ ] **Step 2: Create the test file that confirms the module loads**

Create `test/unit/rag-export.test.ts`:

```typescript
// test/unit/rag-export.test.ts
//
// Unit tests for the browser-side RAG export reassembly helpers.
// The module is plain JS (UMD), required directly — Jest does not
// need to transpile it.
//
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RagExport = require('../../app/chat/webapp/rag-export.js');

describe('rag-export module', () => {
  it('exports the three helpers', () => {
    expect(typeof RagExport.groupChunksBySource).toBe('function');
    expect(typeof RagExport.safeSourceExportName).toBe('function');
    expect(typeof RagExport.reassembleSource).toBe('function');
  });
});
```

- [ ] **Step 3: Run the test and confirm it passes**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: `1 passed`. The three exports exist, even though each throws when called.

- [ ] **Step 4: Commit**

```bash
git add app/chat/webapp/rag-export.js test/unit/rag-export.test.ts
git commit -m "feat(rag-export): scaffold UMD helper module with placeholder exports"
```

---

## Task 2: `groupChunksBySource` — happy path

**Files:**
- Modify: `app/chat/webapp/rag-export.js`
- Modify: `test/unit/rag-export.test.ts`

- [ ] **Step 1: Add the happy-path test**

Append to `test/unit/rag-export.test.ts` after the existing `describe`:

```typescript
describe('groupChunksBySource', () => {
  it('groups chunks by source and sorts by chunkIndex', () => {
    const docs = [
      { id: 'a-2', text: 'C', metadata: { source: 'a.md', chunkIndex: 2, totalChunks: 3 } },
      { id: 'a-0', text: 'A', metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 3 } },
      { id: 'a-1', text: 'B', metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 3 } },
    ];
    const { groups, orphans, warningsBySource } = RagExport.groupChunksBySource(docs);
    const a = groups.get('a.md');
    expect(a.map((d: any) => d.id)).toEqual(['a-0', 'a-1', 'a-2']);
    expect(orphans).toEqual([]);
    expect(warningsBySource.size).toBe(0);
  });

  it('sends rag_add-style records to orphans', () => {
    const docs = [
      { id: 'standalone', text: 'X', metadata: {} },
      { id: 'a-0', text: 'A', metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 } },
    ];
    const { groups, orphans } = RagExport.groupChunksBySource(docs);
    expect(groups.get('a.md')?.length).toBe(1);
    expect(orphans.map((d: any) => d.id)).toEqual(['standalone']);
  });

  it('sends docs with non-integer chunkIndex to orphans', () => {
    const docs = [
      { id: 'bad', text: 'X', metadata: { source: 'a.md', chunkIndex: 'foo' } },
    ];
    const { orphans } = RagExport.groupChunksBySource(docs as any);
    expect(orphans.map((d: any) => d.id)).toEqual(['bad']);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: 3 failures with `Error: not implemented` for the three new tests.

- [ ] **Step 3: Implement `groupChunksBySource` (happy path only — warnings come later)**

Edit `app/chat/webapp/rag-export.js`. Replace the `groupChunksBySource` stub with:

```javascript
function groupChunksBySource(docs) {
  const groups = new Map();
  const orphans = [];
  for (const doc of docs) {
    const md = doc && doc.metadata;
    const src = md && md.source;
    const idx = md && md.chunkIndex;
    if (src && Number.isInteger(idx)) {
      let arr = groups.get(src);
      if (!arr) {
        arr = [];
        groups.set(src, arr);
      }
      arr.push(doc);
    } else {
      orphans.push(doc);
    }
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
  }
  return { groups, orphans, warningsBySource: new Map() };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: 4 passed (1 sanity + 3 grouping).

- [ ] **Step 5: Commit**

```bash
git add app/chat/webapp/rag-export.js test/unit/rag-export.test.ts
git commit -m "feat(rag-export): groupChunksBySource happy-path implementation"
```

---

## Task 3: `groupChunksBySource` — integrity warnings

**Files:**
- Modify: `app/chat/webapp/rag-export.js`
- Modify: `test/unit/rag-export.test.ts`

- [ ] **Step 1: Add the warning tests**

Append to the `describe('groupChunksBySource', ...)` block in `test/unit/rag-export.test.ts`:

```typescript
  it('warns on missing chunk indices (gap)', () => {
    const docs = [
      { id: 'a-0', text: 'A', metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 4 } },
      { id: 'a-1', text: 'B', metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 4 } },
      { id: 'a-3', text: 'D', metadata: { source: 'a.md', chunkIndex: 3, totalChunks: 4 } },
    ];
    const { warningsBySource } = RagExport.groupChunksBySource(docs);
    const ws = warningsBySource.get('a.md');
    expect(ws.some((w: string) => /missing.*2/.test(w))).toBe(true);
  });

  it('warns on inconsistent totalChunks within a group', () => {
    const docs = [
      { id: 'a-0', text: 'A', metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 3 } },
      { id: 'a-1', text: 'B', metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 4 } },
    ];
    const { warningsBySource } = RagExport.groupChunksBySource(docs);
    const ws = warningsBySource.get('a.md');
    expect(ws.some((w: string) => /inconsistent totalChunks/.test(w))).toBe(true);
  });

  it('warns on duplicate chunkIndex', () => {
    const docs = [
      { id: 'a-0', text: 'A', metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 2 } },
      { id: 'a-0b', text: 'A2', metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 2 } },
      { id: 'a-1', text: 'B', metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 2 } },
    ];
    const { warningsBySource } = RagExport.groupChunksBySource(docs);
    const ws = warningsBySource.get('a.md');
    expect(ws.some((w: string) => /duplicate chunk index 0/.test(w))).toBe(true);
  });

  it('warns when group length differs from consistent totalChunks', () => {
    const docs = [
      { id: 'a-0', text: 'A', metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 5 } },
      { id: 'a-1', text: 'B', metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 5 } },
    ];
    const { warningsBySource } = RagExport.groupChunksBySource(docs);
    const ws = warningsBySource.get('a.md');
    expect(ws.some((w: string) => /expected 5 chunks, found 2/.test(w))).toBe(true);
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: 4 failures (`warningsBySource.get('a.md')` is undefined).

- [ ] **Step 3: Add warning collection to `groupChunksBySource`**

In `app/chat/webapp/rag-export.js`, replace the function body with:

```javascript
function groupChunksBySource(docs) {
  const groups = new Map();
  const orphans = [];
  for (const doc of docs) {
    const md = doc && doc.metadata;
    const src = md && md.source;
    const idx = md && md.chunkIndex;
    if (src && Number.isInteger(idx)) {
      let arr = groups.get(src);
      if (!arr) {
        arr = [];
        groups.set(src, arr);
      }
      arr.push(doc);
    } else {
      orphans.push(doc);
    }
  }
  const warningsBySource = new Map();
  for (const [src, arr] of groups.entries()) {
    arr.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
    const ws = [];

    // Duplicate chunkIndex
    const seen = new Set();
    for (const d of arr) {
      const i = d.metadata.chunkIndex;
      if (seen.has(i)) ws.push('⚠ ' + src + ': duplicate chunk index ' + i);
      seen.add(i);
    }

    // Contiguity 0..N-1 against the highest index present
    const present = new Set(arr.map((d) => d.metadata.chunkIndex));
    const max = Math.max(...arr.map((d) => d.metadata.chunkIndex));
    const missing = [];
    for (let i = 0; i <= max; i += 1) if (!present.has(i)) missing.push(i);
    if (missing.length) {
      ws.push('⚠ ' + src + ': ' + missing.length + ' chunks missing (indices ' + missing.join(',') + ')');
    }

    // totalChunks consistency
    const totals = Array.from(new Set(arr.map((d) => d.metadata.totalChunks).filter((v) => Number.isInteger(v))));
    if (totals.length > 1) {
      ws.push('⚠ ' + src + ': inconsistent totalChunks (' + totals.join(' vs ') + ')');
    } else if (totals.length === 1 && totals[0] !== arr.length) {
      ws.push('⚠ ' + src + ': expected ' + totals[0] + ' chunks, found ' + arr.length);
    }

    if (ws.length) warningsBySource.set(src, ws);
  }
  return { groups, orphans, warningsBySource };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: 8 passed (1 sanity + 7 grouping). If a "duplicate" test surfaces *both* the duplicate warning and a spurious "missing" warning, that's expected behavior — duplicates raise contiguity questions and surfacing both is the safer signal.

- [ ] **Step 5: Commit**

```bash
git add app/chat/webapp/rag-export.js test/unit/rag-export.test.ts
git commit -m "feat(rag-export): per-source integrity warnings in groupChunksBySource"
```

---

## Task 4: `safeSourceExportName`

**Files:**
- Modify: `app/chat/webapp/rag-export.js`
- Modify: `test/unit/rag-export.test.ts`

- [ ] **Step 1: Add tests for filename sanitization**

Append to `test/unit/rag-export.test.ts`:

```typescript
describe('safeSourceExportName', () => {
  it('passes through a clean filename', () => {
    const out = RagExport.safeSourceExportName('rap-bo-creation.md', new Set());
    expect(out).toBe('rap-bo-creation.md');
  });

  it('strips directory components and parent-dir traversal', () => {
    expect(RagExport.safeSourceExportName('foo/bar.md', new Set())).toBe('bar.md');
    expect(RagExport.safeSourceExportName('../../etc/passwd', new Set())).toBe('passwd');
    expect(RagExport.safeSourceExportName('a\\b\\c.md', new Set())).toBe('c.md');
  });

  it('replaces unsafe characters with underscore', () => {
    expect(RagExport.safeSourceExportName('foo bar (1).md', new Set())).toBe('foo_bar__1_.md');
  });

  it('preserves the original extension', () => {
    expect(RagExport.safeSourceExportName('data.json', new Set())).toBe('data.json');
    expect(RagExport.safeSourceExportName('schema.xml', new Set())).toBe('schema.xml');
    expect(RagExport.safeSourceExportName('report.csv', new Set())).toBe('report.csv');
    expect(RagExport.safeSourceExportName('zcl_foo.abap', new Set())).toBe('zcl_foo.abap');
  });

  it('disambiguates collisions before the extension', () => {
    const used = new Set<string>();
    expect(RagExport.safeSourceExportName('a.md', used)).toBe('a.md');
    expect(RagExport.safeSourceExportName('a.md', used)).toBe('a-1.md');
    expect(RagExport.safeSourceExportName('a.md', used)).toBe('a-2.md');
  });

  it('falls back to source.txt when sanitization empties the name', () => {
    expect(RagExport.safeSourceExportName('', new Set())).toBe('source.txt');
    expect(RagExport.safeSourceExportName('/', new Set())).toBe('source.txt');
    expect(RagExport.safeSourceExportName('..', new Set())).toBe('source.txt');
  });

  it('truncates an overly long basename', () => {
    const longName = 'x'.repeat(500) + '.md';
    const out = RagExport.safeSourceExportName(longName, new Set());
    expect(out.length).toBeLessThanOrEqual(123); // 120 basename cap + '.md'
    expect(out.endsWith('.md')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: 7 failures from this describe block (current impl throws).

- [ ] **Step 3: Implement `safeSourceExportName`**

In `app/chat/webapp/rag-export.js`, replace the stub with:

```javascript
function safeSourceExportName(sourceName, used) {
  const raw = String(sourceName == null ? '' : sourceName);

  // Strip directory components: last segment after the rightmost / or \
  const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  let leaf = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;

  // Reject pure-dot leftovers (".", "..") — they have no real name
  if (leaf === '' || leaf === '.' || leaf === '..') {
    leaf = '';
  }

  // Split extension off (.md / .txt / .json / etc.). Allow up to 6
  // alphanumerics after the final dot to count as an extension.
  let base = leaf;
  let ext = '';
  const dot = leaf.lastIndexOf('.');
  if (dot > 0 && dot < leaf.length - 1) {
    const tail = leaf.slice(dot + 1);
    if (/^[A-Za-z0-9]{1,6}$/.test(tail)) {
      base = leaf.slice(0, dot);
      ext = '.' + tail;
    }
  }

  // Sanitize basename and extension
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_');
  ext = ext.replace(/[^A-Za-z0-9.]+/g, '');

  // Truncate basename to the same practical limit safeExportName uses (120 chars)
  if (base.length > 120) base = base.slice(0, 120);

  if (!base) return 'source.txt';

  let candidate = base + ext;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let n = 1;
  while (used.has(base + '-' + n + ext)) n += 1;
  candidate = base + '-' + n + ext;
  used.add(candidate);
  return candidate;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: 15 passed (8 prior + 7 sanitization).

- [ ] **Step 5: Commit**

```bash
git add app/chat/webapp/rag-export.js test/unit/rag-export.test.ts
git commit -m "feat(rag-export): safeSourceExportName with zip-slip and collision guards"
```

---

## Task 5: `reassembleSource`

**Files:**
- Modify: `app/chat/webapp/rag-export.js`
- Modify: `test/unit/rag-export.test.ts`

- [ ] **Step 1: Add tests for reassembly + sidecar**

Append to `test/unit/rag-export.test.ts`:

```typescript
describe('reassembleSource', () => {
  function chunk(id: string, source: string, idx: number, total: number, text: string, extra: any = {}) {
    return {
      id,
      text,
      createdAt: extra.createdAt,
      metadata: { source, chunkIndex: idx, totalChunks: total, description: extra.description },
    };
  }

  it('joins chunk text with \\n\\n in chunkIndex order', () => {
    const group = [
      chunk('a-0', 'a.md', 0, 3, 'Hello'),
      chunk('a-1', 'a.md', 1, 3, 'World'),
      chunk('a-2', 'a.md', 2, 3, 'Bye'),
    ];
    const { name, body } = RagExport.reassembleSource(group, 'a.md', []);
    expect(name).toBe('a.md');
    expect(body).toBe('Hello\n\nWorld\n\nBye');
  });

  it('produces a sidecar with provenance for md sources', () => {
    const group = [
      chunk('a-0', 'a.md', 0, 2, 'X', { createdAt: '2026-05-15T10:00:00Z', description: 'desc' }),
      chunk('a-1', 'a.md', 1, 2, 'Y', { createdAt: '2026-05-15T10:00:01Z', description: 'desc' }),
    ];
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', []);
    expect(sidecar.name).toBe('a.md.meta.json');
    const parsed = JSON.parse(sidecar.body);
    expect(parsed.source).toBe('a.md');
    expect(parsed.exportName).toBe('a.md');
    expect(parsed.description).toBe('desc');
    expect(parsed.totalChunks).toBe(2);
    expect(parsed.reassembledFrom).toEqual(['a-0', 'a-1']);
    expect(parsed.createdAt).toBe('2026-05-15T10:00:00Z');
    expect(parsed.warnings).toEqual([]);
  });

  it('passes per-source warnings through to the sidecar', () => {
    const group = [chunk('a-0', 'a.md', 0, 2, 'X')];
    const warnings = ['⚠ a.md: expected 2 chunks, found 1'];
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', warnings);
    const parsed = JSON.parse(sidecar.body);
    expect(parsed.warnings).toEqual(warnings);
  });

  it('omits description from the sidecar when absent', () => {
    const group = [chunk('a-0', 'a.md', 0, 1, 'X')];
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', []);
    const parsed = JSON.parse(sidecar.body);
    expect('description' in parsed).toBe(false);
  });

  it('preserves the safeName extension for txt and other formats', () => {
    const group = [chunk('a-0', 'a.txt', 0, 1, 'X')];
    const out = RagExport.reassembleSource(group, 'a.txt', []);
    expect(out.name).toBe('a.txt');
    expect(out.sidecar.name).toBe('a.txt.meta.json');
  });

  it('throws on an empty group', () => {
    expect(() => RagExport.reassembleSource([], 'a.md', [])).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: 6 failures from this describe block.

- [ ] **Step 3: Implement `reassembleSource`**

In `app/chat/webapp/rag-export.js`, replace the stub with:

```javascript
function reassembleSource(group, safeName, warnings) {
  if (!Array.isArray(group) || group.length === 0) {
    throw new Error('reassembleSource: group must be a non-empty array');
  }
  const ws = Array.isArray(warnings) ? warnings : [];
  const sourceName = (group[0].metadata && group[0].metadata.source) || safeName;
  const joined = group.map((d) => d.text == null ? '' : String(d.text)).join('\n\n');

  // createdAt: earliest among chunks (defensive — chunks of one upload share it)
  let createdAt;
  for (const d of group) {
    if (d.createdAt && (!createdAt || d.createdAt < createdAt)) createdAt = d.createdAt;
  }

  const description = group[0].metadata && group[0].metadata.description;
  const totalChunks = group[0].metadata && group[0].metadata.totalChunks;

  const sidecarObj = {
    source: sourceName,
    exportName: safeName,
    totalChunks: Number.isInteger(totalChunks) ? totalChunks : group.length,
    reassembledFrom: group.map((d) => d.id),
    warnings: ws.slice(),
  };
  if (description !== undefined && description !== null && description !== '') {
    sidecarObj.description = description;
  }
  if (createdAt) sidecarObj.createdAt = createdAt;

  return {
    name: safeName,
    body: joined,
    sidecar: {
      name: safeName + '.meta.json',
      body: JSON.stringify(sidecarObj, null, 2) + '\n',
    },
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm run test:unit -- --testPathPattern=rag-export`
Expected: 21 passed (15 prior + 6 reassembly).

- [ ] **Step 5: Commit**

```bash
git add app/chat/webapp/rag-export.js test/unit/rag-export.test.ts
git commit -m "feat(rag-export): reassembleSource with provenance sidecar"
```

---

## Task 6: Wire `rag-export.js` into the chat UI

**Files:**
- Modify: `app/chat/webapp/index.html` (script-tag near line 294)

- [ ] **Step 1: Add the `<script>` tag**

In `app/chat/webapp/index.html`, find line 294 (`<script src="vendor/jszip.min.js"></script>`) and immediately after it add:

```html
    <script src="rag-export.js"></script>
```

So the block reads:

```html
    <script src="vendor/jszip.min.js"></script>
    <script src="rag-export.js"></script>
    <script>
        // ... inline app code ...
```

- [ ] **Step 2: Verify the helpers are loadable in the browser**

Run: `npx tsc --noEmit` to confirm no TS regressions.
Open `app/chat/webapp/index.html` in a local dev session (`cds watch --profile development`); open the browser console on the chat page and run:

```javascript
RagExport.groupChunksBySource([])
// → { groups: Map(0) {}, orphans: [], warningsBySource: Map(0) {} }
```

If `RagExport` is `undefined`, the script tag is in the wrong place.

- [ ] **Step 3: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "chore(chat-ui): load rag-export.js alongside JSZip"
```

---

## Task 7: Rewrite `buildCollectionZipBlob` to write both folders

**Files:**
- Modify: `app/chat/webapp/index.html` (around line 1952)

- [ ] **Step 1: Replace the existing function body**

In `app/chat/webapp/index.html`, locate `async function buildCollectionZipBlob(...)` (line 1952). Replace the **entire function** (from `async function buildCollectionZipBlob` through its closing `}`) with:

```javascript
        async function buildCollectionZipBlob(docs, format, opts) {
            if (typeof JSZip === 'undefined') {
                throw new Error('ZIP helper not loaded; reload the page and try again.');
            }
            if (typeof RagExport === 'undefined') {
                throw new Error('rag-export helper not loaded; reload the page and try again.');
            }
            const includeDeprecated = !!(opts && opts.include_deprecated);
            const includeReassembled = !(opts && opts.include_reassembled === false);
            const includeChunks = !(opts && opts.include_chunks === false);
            if (!includeReassembled && !includeChunks) {
                throw new Error('Pick at least one of reassembled / chunks.');
            }
            const filtered = includeDeprecated
                ? docs
                : docs.filter(d => !isDeprecatedEntry(d));
            if (filtered.length > EXPORT_MAX_DOCS) {
                throw new Error(
                    `Collection too large: ${filtered.length} documents exceeds export cap of ${EXPORT_MAX_DOCS}.`,
                );
            }
            const format2formatter = { md: formatEntryAsMd, txt: formatEntryAsTxt };
            const formatter = format2formatter[format];
            if (!formatter) throw new Error(`Unknown format "${format}"`);

            const { groups, orphans, warningsBySource } = RagExport.groupChunksBySource(filtered);

            const zip = new JSZip();
            let bytes = 0;
            let fileCount = 0;
            let sourceFileCount = 0;
            let chunkCount = 0;

            function accountAndPut(path, body) {
                bytes += new TextEncoder().encode(body).length;
                if (bytes > EXPORT_MAX_UNCOMPRESSED_BYTES) {
                    throw new Error(
                        'Collection too large for selected export contents. Try disabling raw chunks or reassembled files.',
                    );
                }
                zip.file(path, body);
                fileCount += 1;
            }

            if (includeReassembled) {
                const usedSourceNames = new Set();
                for (const [source, group] of groups.entries()) {
                    const safeName = RagExport.safeSourceExportName(source, usedSourceNames);
                    const ws = warningsBySource.get(source) || [];
                    const { name, body, sidecar } = RagExport.reassembleSource(group, safeName, ws);
                    accountAndPut('reassembled/' + name, body);
                    accountAndPut('reassembled/' + sidecar.name, sidecar.body);
                    sourceFileCount += 1;
                }
            }

            if (includeChunks) {
                const usedChunkNames = new Set();
                for (const doc of filtered) {
                    const base = safeExportName(doc.id, usedChunkNames);
                    for (const part of formatter(doc)) {
                        accountAndPut('chunks/' + base + part.ext, part.body);
                    }
                    chunkCount += 1;
                }
            }

            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            return {
                blob,
                documentCount: filtered.length,
                fileCount,
                sourceFileCount,
                orphanCount: orphans.length,
                chunkCount,
                warningsBySource,
                includedChunks: includeChunks,
                includedReassembled: includeReassembled,
            };
        }
```

- [ ] **Step 2: Run type check and a manual smoke**

Run: `npx tsc --noEmit`
Expected: no errors.

In `cds watch --profile development`, open the chat UI, open an existing collection's export modal, and click Download with default options. The status text should still appear but **may** now say "Exported 0 source files..." until Task 8 updates the message text. The download should still succeed and the zip should contain a `chunks/` folder.

- [ ] **Step 3: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): emit reassembled/ alongside chunks/ in collection export"
```

---

## Task 8: Add the two checkboxes to the export modal

**Files:**
- Modify: `app/chat/webapp/index.html` (export modal markup around line 175 and `runCollectionExport` around line 2018)

- [ ] **Step 1: Find the existing checkbox row and add two new checkboxes**

In `app/chat/webapp/index.html`, locate the export modal block — find the line containing `id="export-include-deprecated"` (one line, near line 184 of the file based on the spec context — the exact line in the current file can be found with `grep -n 'export-include-deprecated' app/chat/webapp/index.html`).

Right BEFORE that existing `<label>...export-include-deprecated...</label>` line, insert:

```html
              <label style="margin-right:14px;cursor:pointer;display:block;margin-bottom:6px">
                <input type="checkbox" id="export-include-reassembled" checked style="accent-color:#00bfff"> Include reassembled source files
              </label>
              <label style="margin-right:14px;cursor:pointer;display:block;margin-bottom:6px">
                <input type="checkbox" id="export-include-chunks" checked style="accent-color:#00bfff"> Include raw chunks
              </label>
```

- [ ] **Step 2: Wire the checkboxes into `openExportModal` and `runCollectionExport`**

In `openExportModal` (around line 2000), AFTER the existing `document.getElementById('export-include-deprecated').checked = false;` line, append:

```javascript
            document.getElementById('export-include-reassembled').checked = true;
            document.getElementById('export-include-chunks').checked = true;
```

In `runCollectionExport` (around line 2018), find the call to `buildCollectionZipBlob`. Update the opts object passed in to read the two new checkboxes. The existing call is:

```javascript
const { blob, documentCount, fileCount } = await buildCollectionZipBlob(
    docs,
    formatEl.value,
    { include_deprecated: document.getElementById('export-include-deprecated').checked },
);
```

Replace it with:

```javascript
const includeReassembled = document.getElementById('export-include-reassembled').checked;
const includeChunks = document.getElementById('export-include-chunks').checked;
const downloadBtn = document.getElementById('export-modal-download');
if (!includeReassembled && !includeChunks) {
    status.style.color = '#ff5555';
    status.textContent = 'Pick at least one of reassembled / chunks';
    downloadBtn.disabled = false;
    return;
}
const result = await buildCollectionZipBlob(
    docs,
    formatEl.value,
    {
        include_deprecated: document.getElementById('export-include-deprecated').checked,
        include_reassembled: includeReassembled,
        include_chunks: includeChunks,
    },
);
const { blob, sourceFileCount, chunkCount, orphanCount, warningsBySource, includedChunks } = result;
```

- [ ] **Step 3: Type-check and smoke-test in the browser**

Run: `npx tsc --noEmit`
In the chat UI, open the export modal and verify both new checkboxes render checked by default. Uncheck both, click Download — status should turn red with "Pick at least one of reassembled / chunks".

- [ ] **Step 4: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): add reassembled/chunks toggles to export modal"
```

---

## Task 9: Update the export status message

**Files:**
- Modify: `app/chat/webapp/index.html` (status emission in `runCollectionExport` around line 2040)

- [ ] **Step 1: Replace the success-status line**

In `runCollectionExport`, find the existing success-status block (it currently reads `status.textContent = \`Exported ${documentCount} documents, ${fileCount} files → ${filename}\`;` or similar — the exact wording can be found with `grep -n 'Exported ' app/chat/webapp/index.html`). Replace the success path with:

```javascript
                const filename = exportZipFilename(collectionId);
                downloadBlob(blob, filename);
                status.style.color = '#00ff88';
                let msg;
                if (includedChunks) {
                    msg = `Exported ${sourceFileCount} source files (reassembled/), ${chunkCount} chunks (chunks/, including ${orphanCount} orphans) → ${filename}`;
                } else {
                    msg = `Exported ${sourceFileCount} source files (reassembled/), skipped ${orphanCount} orphans because raw chunks are disabled → ${filename}`;
                }
                if (warningsBySource && warningsBySource.size) {
                    const flat = [];
                    for (const ws of warningsBySource.values()) for (const w of ws) flat.push(w);
                    msg += `\n${flat.length} warning(s):\n${flat.join('\n')}`;
                }
                status.textContent = msg;
                document.getElementById('export-modal-download').disabled = false;
```

(Note: if the surrounding code uses `btn` rather than `getElementById('export-modal-download')`, prefer the variable name already in scope.)

- [ ] **Step 2: Smoke-test in the browser**

In `cds watch --profile development`:
1. Upload a small text file to a test collection (creates ≥2 chunks).
2. Add one entry via `rag_add` (or the UI "Add document" form) to the same collection — an orphan.
3. Open Export modal, leave both new checkboxes checked, click Download.
4. Status message should be: `Exported 1 source files (reassembled/), 3 chunks (chunks/, including 1 orphans) → ...`.
5. Uncheck `Include raw chunks`, click Download.
6. Status message should now say: `Exported 1 source files (reassembled/), skipped 1 orphans because raw chunks are disabled → ...`.

- [ ] **Step 3: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): status message reports reassembled/chunks/orphans/warnings"
```

---

## Task 10: Add `⬇ source` per-entry button

**Files:**
- Modify: `app/chat/webapp/index.html` (`loadDocuments` around line 1691)

- [ ] **Step 1: Add a conditional "SRC" button to the row template**

In `loadDocuments`, locate the template literal that renders each document (begins with `<div style="background:#0c0c0c;border:1px solid #222;padding:10px 12px;...">`, ending after the `DEL` button). Update the action-buttons row (currently `<button onclick="downloadRagDoc(...)">DL</button>` + `<button onclick="deleteDocument(...)">DEL</button>`) by inserting a third button BEFORE `DL`:

Find:

```html
                                <button onclick="downloadRagDoc(ragCurrentCollection,'${escapeHtml(d.id)}')" style="background:#1a1a1a;color:#00bfff;border:1px solid #003355;padding:2px 8px;cursor:pointer;font-family:'Courier New',monospace;font-size:11px;border-radius:3px" title="Download record as text file">DL</button>
```

Replace with:

```html
                                ${d.metadata && d.metadata.source && Number.isInteger(d.metadata.chunkIndex)
                                  ? `<button onclick="downloadSourceFile(ragCurrentCollection,'${escapeHtml(d.id)}')" style="background:#1a1a1a;color:#00ff88;border:1px solid #00553a;padding:2px 8px;cursor:pointer;font-family:'Courier New',monospace;font-size:11px;border-radius:3px" title="Reassemble and download the whole source file (zip with body + .meta.json)">SRC</button>`
                                  : ''}
                                <button onclick="downloadRagDoc(ragCurrentCollection,'${escapeHtml(d.id)}')" style="background:#1a1a1a;color:#00bfff;border:1px solid #003355;padding:2px 8px;cursor:pointer;font-family:'Courier New',monospace;font-size:11px;border-radius:3px" title="Download this chunk only as text file">DL</button>
```

- [ ] **Step 2: Smoke-check the rendering**

In the chat UI, refresh the document list of a collection that has uploaded chunked content. Every chunked row should show three buttons: `SRC`, `DL`, `DEL`. Rows added via `rag_add` (no chunkIndex) should show only `DL`, `DEL`.

- [ ] **Step 3: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): add SRC per-entry button for chunked sources"
```

---

## Task 11: Implement `downloadSourceFile`

**Files:**
- Modify: `app/chat/webapp/index.html` (next to `downloadRagDoc` around line 1782)

- [ ] **Step 1: Add the function**

In `app/chat/webapp/index.html`, immediately AFTER the existing `downloadRagDoc` function (the one ending around line 1795 with `} catch (err) { alert(err.message); }`), append:

```javascript
        async function downloadSourceFile(collection, docId) {
            try {
                if (typeof JSZip === 'undefined' || typeof RagExport === 'undefined') {
                    alert('Export helpers not loaded; reload the page and try again.');
                    return;
                }
                const all = await fetchAllDocuments(collection);
                // Same deprecated/superseded filtering policy as the default bulk export
                const filtered = all.filter(d => !isDeprecatedEntry(d));

                const clicked = filtered.find(d => d.id === docId)
                    || all.find(d => d.id === docId);
                if (!clicked || !clicked.metadata || !clicked.metadata.source
                    || !Number.isInteger(clicked.metadata.chunkIndex)) {
                    alert('This record is not part of a chunked source.');
                    return;
                }
                if (isDeprecatedEntry(clicked)) {
                    alert('This source is deprecated/superseded. Use DL to download the raw chunk.');
                    return;
                }

                const { groups, warningsBySource } = RagExport.groupChunksBySource(filtered);
                const sourceName = clicked.metadata.source;
                const group = groups.get(sourceName);
                if (!group || group.length === 0) {
                    alert('No active chunks remain for this source after filtering.');
                    return;
                }
                const safeName = RagExport.safeSourceExportName(sourceName, new Set());
                const ws = warningsBySource.get(sourceName) || [];
                const { name, body, sidecar } = RagExport.reassembleSource(group, safeName, ws);

                // Mini zip: <safeBasename>.zip containing body + meta.json
                const zip = new JSZip();
                zip.file(name, body);
                zip.file(sidecar.name, sidecar.body);
                const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

                // Strip the original extension to build the zip name
                const dot = name.lastIndexOf('.');
                const baseForZip = (dot > 0 ? name.slice(0, dot) : name) || 'source';
                downloadBlob(blob, baseForZip + '.zip');
            } catch (err) {
                alert(err.message || String(err));
            }
        }
```

Note: this file has two `downloadBlob` functions; the relevant one for `Blob` + filename takes the order `(blob, filename)` (the one defined around line 2051). Reusing that one is intentional — same path used by bulk export.

- [ ] **Step 2: Smoke-test the click flow**

1. Upload a chunked file (e.g. `rap-bo-creation.md`) to a test collection.
2. Refresh the doc list — find a chunk row.
3. Click `SRC`. A small zip (`rap-bo-creation.zip`) should download.
4. Unzip it: contents must be `rap-bo-creation.md` (joined source text) and `rap-bo-creation.md.meta.json` (provenance JSON).
5. Repeat on a single-chunk source (upload with `chunkSize=999999` so only one chunk is produced). `SRC` should still render and produce a 1-file body inside the zip.

- [ ] **Step 3: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): downloadSourceFile assembles a mini-zip per source"
```

---

## Task 12: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit-test pass**

Run: `npm run test:unit`
Expected: all previously-passing tests still pass; `rag-export.test.ts` reports 21 tests passed.

- [ ] **Step 2: Lint and type check**

Run: `npm run lint:check`
Run: `npx tsc --noEmit`
Both should report no new findings (the one pre-existing warning recorded earlier in the session is acceptable).

- [ ] **Step 3: Manual end-to-end check against `cds watch`**

1. Start `cds watch --profile development`.
2. Open the chat UI, create or pick a test collection.
3. Upload `docs/tutorials/rap-bo-creation.md` (real chunked content).
4. Add one entry via the UI "Add document" form (orphan, no source metadata).
5. Bulk export with both toggles on → unzip → verify `reassembled/rap-bo-creation.md` plus its sidecar, and a `chunks/` folder including the orphan. Diff the reassembled body against the original (modulo trailing whitespace and `\n\n` join behavior).
6. Bulk export with `Include chunks` off → only `reassembled/` in zip, status says orphan was skipped.
7. Click `SRC` on a chunk row → mini-zip downloads with reassembled body + sidecar.
8. Click `SRC` on the orphan row → button is not rendered (no error).
9. Try uploading a file named `../../etc/passwd` (or just `evil/../leaf.md`) to verify `safeSourceExportName` strips the directory traversal: bulk export zip must contain `reassembled/passwd` or `reassembled/leaf.md`, not nested folders.

- [ ] **Step 4: Delete the spec and plan from the tree**

Per `CLAUDE.md`: "Plans and specs … are kept in the tree only while active. Once a plan/spec has been fully implemented OR cancelled, delete the file."

```bash
git rm docs/superpowers/specs/2026-05-15-rag-export-reassembly-design.md
git rm docs/superpowers/plans/2026-05-15-rag-export-reassembly.md
git commit -m "chore: remove implemented spec/plan for RAG export reassembly"
```

- [ ] **Step 5: Open a PR**

Push the branch and open a PR targeting `main`, linking issue cloud-llm-hub#88. Use the PR title `feat(rag-export): reassemble chunked source files in bulk export and per-entry`.
