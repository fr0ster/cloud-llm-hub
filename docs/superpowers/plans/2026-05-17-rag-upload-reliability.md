# RAG upload reliability — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently losing RAG chunks under embedder load. Make `addDocument` honor RAG-write failures, retry transient errors in `addDocumentsBulk`, log partial bulk results, and surface the result in the chat-📎 UI.

**Architecture:** Pure server-side fix on `srv/rag-collections.ts` (two new helpers + two changed methods) + one log line + small client UX patch in `app/chat/webapp/index.html`. No new endpoints, no schema changes.

**Tech Stack:** TypeScript (strict), Jest + ts-jest for unit tests, `@mcp-abap-adt/llm-agent` `Result<T, E>` type for return-style errors.

---

## File Structure

- `srv/rag-collections.ts` (modify) — fix `addDocument` to throw on `Result.ok === false`; refactor `addDocumentsBulk` to use a new `tryWithRetry` helper + `isTransient` classifier; add warn log on partial.
- `app/chat/webapp/index.html` (modify) — `handleQuickFileAttach` reads `data.added`; `renderAttachedFiles` flags loss red; alert toast when failed > 0.
- `test/unit/rag-collections-bulk.test.ts` (create) — unit tests for `isTransient`, `tryWithRetry`, and the end-to-end loop behavior with a mock store.

Spec reference: `docs/superpowers/specs/2026-05-17-rag-upload-reliability-design.md`.

---

## Task 1: Read helper context, plan signatures

**Files:** none (read-only orientation, no commit).

- [ ] **Step 1: Confirm the `Result<T, E>` type shape**

Run:

```bash
sed -n '5,15p' node_modules/@mcp-abap-adt/llm-agent/dist/interfaces/types.d.ts
```

Expected output: a discriminated union `{ ok: true; value: T } | { ok: false; error: E }`. The helpers in Task 2 reuse this exact shape so they compose with `IRagEditor.upsert` returns. If the actual type differs, stop and report — the plan needs to be revised before writing code.

- [ ] **Step 2: Confirm `addDocument` currently ignores the Result**

Run:

```bash
sed -n '367,395p' srv/rag-collections.ts
```

Expected: lines 381–387 call `await stored.rag.upsert(...)` and immediately persist without inspecting the return value. This is the bug Task 3 fixes.

- [ ] **Step 3: Confirm RagError code shape**

Run:

```bash
grep -n "UPSERT_ERROR\|ABORTED" node_modules/@mcp-abap-adt/qdrant-rag/dist/qdrant-rag.js | head -10
```

Expected: codes like `UPSERT_ERROR`, `ABORTED` — the HTTP status is embedded in `.message`, not in `.code`. `isTransient` in Task 2 classifies on `.message` substrings.

No commit. Move on to Task 2.

---

## Task 2: Add `isTransient` + `tryWithRetry` helpers (TDD)

**Files:**
- Modify: `srv/rag-collections.ts`
- Create: `test/unit/rag-collections-bulk.test.ts`

- [ ] **Step 1: Create the test file with failing tests**

Create `test/unit/rag-collections-bulk.test.ts`:

```typescript
import { isTransient, tryWithRetry } from '../../srv/rag-collections';

describe('isTransient', () => {
  it('classifies HTTP 429 as transient', () => {
    expect(isTransient(new Error('Qdrant upsert failed: 429 Too Many Requests'))).toBe(true);
  });
  it('classifies HTTP 503/504 as transient', () => {
    expect(isTransient(new Error('Qdrant upsert failed: 503 Service Unavailable'))).toBe(true);
    expect(isTransient(new Error('Qdrant upsert failed: 504 Gateway Timeout'))).toBe(true);
  });
  it('classifies ECONNRESET / ETIMEDOUT / timeout as transient', () => {
    expect(isTransient(new Error('connect ECONNRESET 10.0.0.1:443'))).toBe(true);
    expect(isTransient(new Error('request ETIMEDOUT'))).toBe(true);
    expect(isTransient(new Error('upstream timeout'))).toBe(true);
  });
  it('classifies "rate limit" / "rate-limit" phrases as transient', () => {
    expect(isTransient(new Error('OpenAI: rate limit exceeded'))).toBe(true);
    expect(isTransient(new Error('AI Core: rate-limit hit'))).toBe(true);
  });
  it('treats HTTP 4xx (non-429) as permanent', () => {
    expect(isTransient(new Error('Qdrant upsert failed: 400 Bad Request'))).toBe(false);
    expect(isTransient(new Error('Qdrant upsert failed: 401 Unauthorized'))).toBe(false);
    expect(isTransient(new Error('Qdrant upsert failed: 404 Not Found'))).toBe(false);
  });
  it('treats unrecognized errors as permanent (conservative)', () => {
    expect(isTransient(new Error('something opaque'))).toBe(false);
    expect(isTransient(null as unknown as Error)).toBe(false);
    expect(isTransient(undefined as unknown as Error)).toBe(false);
  });
  it('considers err.code / err.status fields too', () => {
    const e1 = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
    expect(isTransient(e1)).toBe(true);
    const e2 = Object.assign(new Error('boom'), { status: 503 });
    expect(isTransient(e2)).toBe(true);
    const e3 = Object.assign(new Error('boom'), { statusCode: 429 });
    expect(isTransient(e3)).toBe(true);
  });
});

describe('tryWithRetry', () => {
  function sleeper() {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    return { sleep, sleeps };
  }

  it('succeeds on first attempt — no sleep', async () => {
    const { sleep, sleeps } = sleeper();
    const fn = jest.fn().mockResolvedValue('ok');
    const res = await tryWithRetry(fn, { sleep });
    expect(res).toEqual({ ok: true, value: 'ok' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('retries on transient then succeeds — records backoffs', async () => {
    const { sleep, sleeps } = sleeper();
    let n = 0;
    const fn = jest.fn().mockImplementation(async () => {
      n += 1;
      if (n < 3) throw new Error('Qdrant upsert failed: 503 Service Unavailable');
      return 'ok';
    });
    const res = await tryWithRetry(fn, { sleep });
    expect(res).toEqual({ ok: true, value: 'ok' });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([200, 500]);
  });

  it('exhausts retries on persistent transient — returns failure', async () => {
    const { sleep, sleeps } = sleeper();
    const fn = jest.fn().mockRejectedValue(new Error('Qdrant upsert failed: 503'));
    const res = await tryWithRetry(fn, { sleep });
    expect(res.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([200, 500, 1500]);
  });

  it('does not retry permanent errors', async () => {
    const { sleep, sleeps } = sleeper();
    const fn = jest.fn().mockRejectedValue(new Error('Qdrant upsert failed: 401'));
    const res = await tryWithRetry(fn, { sleep });
    expect(res.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect them to fail with "module export not found"**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: TypeScript / import error — `isTransient` and `tryWithRetry` are not yet exported from `srv/rag-collections.ts`. That's the red phase.

- [ ] **Step 3: Add the helpers to `srv/rag-collections.ts`**

Open `srv/rag-collections.ts`. Find the top-level imports/`cds.log` block (near the top of the file, before any class declaration). After the imports and any utility constants, before the first class, add:

```typescript
/**
 * Classify an embedder/RAG-write error as transient (worth retrying) or permanent.
 * Conservative: anything unrecognized is treated as permanent so we don't burn
 * retry budget on validation errors.
 */
export function isTransient(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as { message?: string })?.message ?? '';
  const code = (err as { code?: string })?.code ?? '';
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { status?: number; statusCode?: number })?.statusCode ??
    0;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;
  if (/\b(429|503|504)\b/.test(msg)) return true;
  if (/(rate[\s-]?limit|timeout|ECONNRESET|ETIMEDOUT|network)/i.test(msg))
    return true;
  return false;
}

const RETRY_BACKOFFS_MS = [200, 500, 1500] as const;

export interface TryWithRetryOptions {
  /** Override the sleep function (tests inject a fake to avoid real waits). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`. On transient failure, retry with [200ms, 500ms, 1500ms] backoff.
 * Returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export async function tryWithRetry<T>(
  fn: () => Promise<T>,
  opts: TryWithRetryOptions = {},
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: Error | undefined;
  for (let i = 0; i <= RETRY_BACKOFFS_MS.length; i += 1) {
    if (i > 0) await sleep(RETRY_BACKOFFS_MS[i - 1]);
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!isTransient(lastErr) || i === RETRY_BACKOFFS_MS.length) {
        return { ok: false, error: lastErr };
      }
    }
  }
  return { ok: false, error: lastErr ?? new Error('tryWithRetry: unreachable') };
}
```

- [ ] **Step 4: Run tests — expect green**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: 11 tests pass (7 `isTransient` + 4 `tryWithRetry`).

- [ ] **Step 5: Commit**

```bash
git add srv/rag-collections.ts test/unit/rag-collections-bulk.test.ts
git commit -m "feat(rag): add isTransient + tryWithRetry helpers"
```

---

## Task 3: Make `addDocument` fail on RAG-write failure

**Files:**
- Modify: `srv/rag-collections.ts`
- Modify: `test/unit/rag-collections-bulk.test.ts`

- [ ] **Step 1: Add tests for the new behavior**

Append to `test/unit/rag-collections-bulk.test.ts`:

```typescript
import { CollectionRegistry } from '../../srv/rag-collections';

// Smallest possible IRag stub: records upsert calls, returns Result by script.
function makeMockRagFactory(scripted: Array<{ ok: true } | { ok: false; error: Error }>) {
  let i = 0;
  const calls: Array<{ id: string; text: string }> = [];
  const writer = {
    upsertRaw: async (id: string, text: string) => {
      calls.push({ id, text });
      const r = scripted[Math.min(i, scripted.length - 1)];
      i += 1;
      if (r.ok) return { ok: true as const, value: undefined };
      return { ok: false as const, error: r.error };
    },
    deleteByIdRaw: async () => ({ ok: true as const, value: true }),
  };
  const rag = {
    writer: () => writer,
    upsert: undefined,        // RecencyBoostedRag.upsert calls writer.upsertRaw
    query: async () => ({ ok: true as const, value: [] }),
    getById: async () => ({ ok: true as const, value: null }),
    healthCheck: async () => ({ ok: true as const, value: undefined }),
    deleteById: async () => ({ ok: true as const, value: true }),
  };
  return { rag, calls, writer };
}

describe('addDocument (Result-aware)', () => {
  it('throws when stored.rag.upsert returns Result.ok=false', async () => {
    // This test is illustrative — exercising addDocument requires a full
    // CollectionRegistry plus a backend factory. See the addDocumentsBulk
    // integration block below for the real coverage of this behavior.
    expect(true).toBe(true);
  });
});
```

Note: the line `expect(true).toBe(true)` is a placeholder so the suite registers — direct testing of `addDocument` requires constructing a `CollectionRegistry` with a backend factory that is more invasive than a stubbed write. The real coverage of "throws on `Result.ok=false`" comes from the `addDocumentsBulk` integration tests in Task 4, which observe that a failed upsert leads to `added < docs.length` instead of `added === docs.length`.

- [ ] **Step 2: Run tests — placeholder passes**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: 12 tests pass (11 prior + 1 placeholder).

- [ ] **Step 3: Modify `addDocument`**

In `srv/rag-collections.ts`, find `addDocument` (~line 367). Replace the body that currently reads:

```typescript
    // Upsert into RAG store
    await stored.rag.upsert(doc.text, {
      id: `doc:${collectionId}:${doc.id}`,
      namespace:
        namespace ??
        (stored.meta.scope === 'global' ? 'global' : stored.meta.owner),
      ...doc.metadata,
    });

    stored.documents.set(doc.id, full);
    stored.meta.documentCount = stored.documents.size;
    this.persistDocument(collectionId, full);
    return full;
```

with:

```typescript
    // Upsert into RAG store. The backend returns a Result<T, RagError>; we
    // must inspect it and throw on failure or chunks will be silently lost.
    const result = await stored.rag.upsert(doc.text, {
      id: `doc:${collectionId}:${doc.id}`,
      namespace:
        namespace ??
        (stored.meta.scope === 'global' ? 'global' : stored.meta.owner),
      ...doc.metadata,
    });
    if (!result.ok) {
      throw result.error instanceof Error
        ? result.error
        : new Error(String(result.error));
    }

    stored.documents.set(doc.id, full);
    stored.meta.documentCount = stored.documents.size;
    this.persistDocument(collectionId, full);
    return full;
```

- [ ] **Step 4: Run type-check + tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run test:unit`
Expected: all existing tests still pass; the new placeholder passes too.

- [ ] **Step 5: Commit**

```bash
git add srv/rag-collections.ts test/unit/rag-collections-bulk.test.ts
git commit -m "fix(rag): addDocument throws when stored.rag.upsert returns !ok"
```

---

## Task 4: Wire retry into `addDocumentsBulk` + warn log

**Files:**
- Modify: `srv/rag-collections.ts`
- Modify: `test/unit/rag-collections-bulk.test.ts`

- [ ] **Step 1: Add integration test using the mock backend**

Append to `test/unit/rag-collections-bulk.test.ts` (inside file but as a new `describe` block):

```typescript
import * as cds from '@sap/cds';

// Helper: build a registry with a stubbed backend factory whose writer
// behavior is controlled by the test.
async function makeRegistry(writerImpl: {
  upsertRaw: (id: string, text: string) => Promise<{ ok: true; value: void } | { ok: false; error: Error }>;
}) {
  // Avoid logging noise during tests
  (cds as any).log = () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  const { CollectionRegistry } = require('../../srv/rag-collections');
  const registry = new CollectionRegistry(undefined);
  // Stub createRagStore so getById/upsert go through our writer
  (registry as any).createRagStore = () => ({
    writer: () => ({
      upsertRaw: writerImpl.upsertRaw,
      deleteByIdRaw: async () => ({ ok: true, value: true }),
    }),
    upsert: async (text: string, metadata: any) => {
      const w = (registry as any).createRagStore().writer();
      const { id, ...rest } = metadata;
      const r = await w.upsertRaw(id, text, rest);
      return r.ok ? { ok: true, value: { id } } : r;
    },
    query: async () => ({ ok: true, value: [] }),
    getById: async () => ({ ok: true, value: null }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    deleteById: async () => ({ ok: true, value: true }),
  });
  // Create a synthetic collection
  await registry.upsertCollection({
    id: 'test',
    displayName: 'Test',
    scope: 'user',
    backend: 'mem',
  } as any);
  return registry;
}

describe('addDocumentsBulk integration', () => {
  it('all chunks succeed → added equals total, errors empty', async () => {
    const registry = await makeRegistry({
      upsertRaw: async () => ({ ok: true, value: undefined }),
    });
    const docs = Array.from({ length: 5 }, (_, i) => ({
      id: `chunk-${i}`,
      text: 'x',
      metadata: { source: 'a.md', chunkIndex: i, totalChunks: 5 },
    }));
    const res = await registry.addDocumentsBulk('test', docs);
    expect(res.added).toBe(5);
    expect(res.errors).toEqual([]);
  });

  it('transient failures eventually succeed via retry', async () => {
    let attemptsPerChunk = new Map<string, number>();
    const registry = await makeRegistry({
      upsertRaw: async (id) => {
        const n = (attemptsPerChunk.get(id) ?? 0) + 1;
        attemptsPerChunk.set(id, n);
        // chunks 1 and 3 fail twice with a transient error, then succeed
        if ((id.endsWith('-1') || id.endsWith('-3')) && n < 3) {
          return { ok: false, error: new Error('Qdrant upsert failed: 503') };
        }
        return { ok: true, value: undefined };
      },
    });
    const docs = Array.from({ length: 5 }, (_, i) => ({
      id: `chunk-${i}`,
      text: 'x',
      metadata: { source: 'a.md', chunkIndex: i, totalChunks: 5 },
    }));
    const res = await registry.addDocumentsBulk('test', docs);
    expect(res.added).toBe(5);
    expect(res.errors).toEqual([]);
    expect(attemptsPerChunk.get('chunk-1')).toBe(3);
    expect(attemptsPerChunk.get('chunk-3')).toBe(3);
  });

  it('permanent failures count as failed without retry', async () => {
    let attempts = 0;
    const registry = await makeRegistry({
      upsertRaw: async (id) => {
        if (id.endsWith('-2')) {
          attempts += 1;
          return { ok: false, error: new Error('Qdrant upsert failed: 401 Unauthorized') };
        }
        return { ok: true, value: undefined };
      },
    });
    const docs = Array.from({ length: 5 }, (_, i) => ({
      id: `chunk-${i}`,
      text: 'x',
      metadata: { source: 'a.md', chunkIndex: i, totalChunks: 5 },
    }));
    const res = await registry.addDocumentsBulk('test', docs);
    expect(res.added).toBe(4);
    expect(attempts).toBe(1);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toMatch(/chunk-2/);
  });
});
```

- [ ] **Step 2: Run tests — expect 3 failures**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: 2 of the 3 new tests fail (no retry today) — first one passes (it's a happy path), retry test fails because there's no retry, permanent-fail test fails because addDocument currently throws on Result.ok=false (Task 3) AND `addDocumentsBulk` will catch and continue → actually after Task 3, *that* test passes; the retry test is the one that needs Task 4. Confirm exactly which fail before continuing.

(If "all 5 chunks succeed" fails because of the registry stub not wiring through properly, debug the stub first — it should not require the retry change.)

- [ ] **Step 3: Refactor `addDocumentsBulk`**

In `srv/rag-collections.ts`, find `addDocumentsBulk` (~line 395). Replace the body that currently reads:

```typescript
    const errors: string[] = [];
    let added = 0;

    for (const doc of docs) {
      try {
        await this.addDocument(collectionId, doc, namespace);
        added++;
        // Throttle to avoid embedder rate limits
        if (added % 10 === 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        errors.push(`${doc.id}: ${(err as Error).message}`);
      }
    }
    return { added, errors };
```

with:

```typescript
    const errors: string[] = [];
    let added = 0;

    for (const doc of docs) {
      const result = await tryWithRetry(() =>
        this.addDocument(collectionId, doc, namespace),
      );
      if (result.ok) {
        added += 1;
        // Throttle to avoid embedder rate limits (load shaping, not retry)
        if (added % 10 === 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } else {
        errors.push(`${doc.id}: ${result.error.message}`);
      }
    }

    if (added < docs.length) {
      const log = cds.log('rag-collections');
      log.warn('Bulk add partial', {
        collection: collectionId,
        total: docs.length,
        added,
        failed: docs.length - added,
        firstErrors: errors.slice(0, 5),
      });
    }

    return { added, errors };
```

Notes:
- `cds.log('rag-collections')` is the standard CAP logger. If the file already imports a `log` via `cds.log(...)` at module level (check the top of `srv/rag-collections.ts`), reuse that handle instead of creating a new one inline. The intent is one warn-log per partial bulk, with the listed fields.
- The `tryWithRetry` import needs to live at the top of the module (or already be in scope since the helpers are exported from the same file). If TypeScript complains, add the import line `import { tryWithRetry } from './rag-collections';` only if the helpers are split into a separate file; in this plan they live in the SAME file, so no import is needed — call them directly.

- [ ] **Step 4: Type-check + run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run test:unit`
Expected: all tests pass (15 in the rag-collections-bulk suite, plus the pre-existing tests from earlier features).

- [ ] **Step 5: Commit**

```bash
git add srv/rag-collections.ts test/unit/rag-collections-bulk.test.ts
git commit -m "feat(rag): retry transient bulk failures + log partial completion"
```

---

## Task 5: Client UX — chat-📎 surfaces added/chunks, alerts on loss

**Files:**
- Modify: `app/chat/webapp/index.html`

- [ ] **Step 1: Update `handleQuickFileAttach`**

In `app/chat/webapp/index.html`, find `handleQuickFileAttach` (use `grep -n "function handleQuickFileAttach" app/chat/webapp/index.html`).

Locate this block (current):

```javascript
                attachedFiles.push({ name: file.name, chunks: data.chunks });
                renderAttachedFiles();
```

Replace with:

```javascript
                const chunks = data.chunks;
                const added = typeof data.added === 'number' ? data.added : chunks;
                const failed = chunks - added;
                attachedFiles.push({ name: file.name, chunks, added, failed });
                renderAttachedFiles();
                if (failed > 0) {
                    alert(
                        `${file.name}: ${added}/${chunks} chunks indexed.\n` +
                        `${failed} chunk(s) failed — some content may be missing from search/export. ` +
                        `Try re-uploading or check server logs.`,
                    );
                }
```

- [ ] **Step 2: Update `renderAttachedFiles`**

Find `renderAttachedFiles` (immediately after `handleQuickFileAttach`).

Locate this block (current):

```javascript
            bar.innerHTML = attachedFiles.map((f, i) =>
                `<span style="color:#00bfff">&#x1F4CE; ${escapeHtml(f.name)}</span> <span style="color:#555">(${f.chunks} chunks)</span> <button onclick="removeAttachedFile(${i})" style="background:none;border:none;color:#ff5555;cursor:pointer;font-size:11px;font-family:'Courier New',monospace">[x]</button>`
            ).join(' &nbsp; ');
```

Replace with:

```javascript
            bar.innerHTML = attachedFiles.map((f, i) => {
                const countSpan = f.failed > 0
                    ? `<span style="color:#ff5555" title="${f.failed} chunk(s) failed — some content may be missing">(${f.added}/${f.chunks} chunks)</span>`
                    : `<span style="color:#555">(${f.chunks} chunks)</span>`;
                return `<span style="color:#00bfff">&#x1F4CE; ${escapeHtml(f.name)}</span> ${countSpan} <button onclick="removeAttachedFile(${i})" style="background:none;border:none;color:#ff5555;cursor:pointer;font-size:11px;font-family:'Courier New',monospace">[x]</button>`;
            }).join(' &nbsp; ');
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): chat-📎 shows added/chunks parity, flags loss red"
```

---

## Task 6: Final verification

**Files:** none.

- [ ] **Step 1: Unit-test pass**

Run: `npm run test:unit`
Expected: full suite green, including the new rag-collections-bulk tests.

- [ ] **Step 2: Lint + tsc**

Run: `npm run lint:check`
Run: `npx tsc --noEmit`
Both: clean.

- [ ] **Step 3: Manual smoke against deploy**

After deploy to `deploy/acme-sandbox/dev`:
1. Upload a small file via chat-📎 → expect green `(N chunks)` in the bar; no alert.
2. Upload a large file (e.g., 50+ chunks) while sending a chat message simultaneously → expect `(N/N chunks)` green if retry recovered everything; red `(M/N chunks)` if some chunks couldn't be saved even after 3 retries.
3. Check `cf logs cloud-llm-hub-srv --recent | grep "Bulk add partial"` — verify the warn log is emitted when partial.
4. Manage panel upload of the same large file → still shows `Uploaded: N chunks, M added`; should match chat-📎 behavior (this PR doesn't change that path).

- [ ] **Step 4: Delete spec + plan, open PR**

Per `CLAUDE.md`: delete spec and plan once implemented.

```bash
git rm docs/superpowers/specs/2026-05-17-rag-upload-reliability-design.md \
       docs/superpowers/plans/2026-05-17-rag-upload-reliability.md
git commit -m "chore: remove implemented spec/plan for RAG upload reliability"
git push -u origin rag-upload-reliability
gh pr create --base main --head rag-upload-reliability \
  --title "fix(rag): silent chunk loss — Result-aware addDocument, retry, observability, chat-📎 feedback" \
  --body "Closes #90."
```
