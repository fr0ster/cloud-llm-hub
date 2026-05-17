# RAG upload reliability — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently losing RAG chunks under embedder load. Make `addDocument` honor RAG-write failures (root cause), retry transient errors in `addDocumentsBulk`, log partial bulk results, and surface the result in the chat-📎 UI.

**Architecture:** Pure server-side fix on `srv/rag-collections.ts` (Result-aware `addDocument`, two new helpers, refactored `addDocumentsBulk`) + one warn log + small client UX patch in `app/chat/webapp/index.html`. No new endpoints, no schema changes.

**Tech Stack:** TypeScript (strict), Jest + ts-jest for unit tests, `@mcp-abap-adt/llm-agent` `Result<T, E>` type for return-style errors.

---

## File Structure

- `srv/rag-collections.ts` (modify) — `addDocument` inspects `Result.ok` and throws on `!ok`; add exported `isTransient` + `tryWithRetry`; `addDocumentsBulk` uses retry + emits a warn log on partial completion.
- `app/chat/webapp/index.html` (modify) — `handleQuickFileAttach` reads `data.added`; `renderAttachedFiles` flags loss red; alert toast when failed > 0.
- `test/unit/rag-collections-bulk.test.ts` (create) — unit tests for `isTransient`, `tryWithRetry`, plus integration tests against a stubbed RAG backend covering `addDocument` and `addDocumentsBulk` behavior under success / retry / permanent failure paths.

Spec reference: `docs/superpowers/specs/2026-05-17-rag-upload-reliability-design.md`.

---

## Task 1: Read helper context (orientation, no commit)

**Files:** none.

- [ ] **Step 1: Confirm the `Result<T, E>` shape**

```bash
sed -n '5,15p' node_modules/@mcp-abap-adt/llm-agent/dist/interfaces/types.d.ts
```

Expected: discriminated union `{ ok: true; value: T } | { ok: false; error: E }`. The fix in Task 2 destructures on `.ok`; if the actual type differs, stop and report.

- [ ] **Step 2: Confirm `addDocument` currently ignores the Result**

```bash
sed -n '367,395p' srv/rag-collections.ts
```

Expected: lines 381–387 do `await stored.rag.upsert(...)` and immediately persist without inspecting the return. This is the root cause Task 2 fixes.

- [ ] **Step 3: Confirm `RecencyBoostedRag` returns the Result instead of throwing**

```bash
sed -n '99,116p' srv/rag-collections.ts
```

Expected: `upsert` returns the result object from `writer.upsertRaw(...)` (or wraps it). No `throw` on `!res.ok` — that's why `addDocument` swallows failures today.

- [ ] **Step 4: Confirm RagError classification surface**

```bash
grep -n "UPSERT_ERROR\|ABORTED" node_modules/@mcp-abap-adt/qdrant-rag/dist/qdrant-rag.js | head -10
```

Expected: codes like `UPSERT_ERROR`, `ABORTED` — the HTTP status is embedded in `.message`, not in `.code`. `isTransient` in Task 3 classifies on `.message` substrings.

No commit. Move on.

---

## Task 2: `addDocument` honors `Result.ok` (root cause fix, TDD)

**Files:**
- Modify: `srv/rag-collections.ts`
- Create: `test/unit/rag-collections-bulk.test.ts`

This is the standalone fix that lets retry (Task 4) actually see failures. We pair it with a working integration test against a stubbed backend so future tasks reuse the same infrastructure.

- [ ] **Step 1: Create the test file with a failing integration test**

Create `test/unit/rag-collections-bulk.test.ts`:

```typescript
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    })),
  },
}));

import cds from '@sap/cds';
import { CollectionRegistry } from '../../srv/rag-collections';

type WriterScript = Array<{ ok: true } | { ok: false; error: Error }>;

/**
 * Build a CollectionRegistry whose RAG backend is a tiny scripted stub.
 * Each call to upsertRaw consumes the next entry from `script` (last entry
 * is reused if exhausted). Counters of upsertRaw calls are exposed for
 * assertions.
 */
async function makeRegistry(script: WriterScript, byId?: Map<string, WriterScript>) {
  const callsById = new Map<string, number>();
  const writer = {
    upsertRaw: async (id: string, _text: string, _meta: unknown) => {
      callsById.set(id, (callsById.get(id) ?? 0) + 1);
      // Per-id script wins over global script
      const perId = byId?.get(id);
      const s = perId ?? script;
      const idx = Math.min((callsById.get(id) ?? 1) - 1, s.length - 1);
      const next = s[idx];
      if (next.ok) return { ok: true as const, value: undefined };
      return { ok: false as const, error: next.error };
    },
    deleteByIdRaw: async () => ({ ok: true as const, value: true }),
  };
  const ragStub = {
    writer: () => writer,
    upsert: async (text: string, metadata: any) => {
      const { id, ...rest } = metadata;
      const r = await writer.upsertRaw(id, text, rest);
      return r.ok ? { ok: true as const, value: { id } } : r;
    },
    query: async () => ({ ok: true as const, value: [] }),
    getById: async () => ({ ok: true as const, value: null }),
    healthCheck: async () => ({ ok: true as const, value: undefined }),
    deleteById: async () => ({ ok: true as const, value: true }),
  };
  const registry = new CollectionRegistry(undefined as any);
  (registry as any).createRagStore = () => ragStub;
  registry.createCollection({
    id: 'test',
    displayName: 'Test',
    description: 'Test collection',
    scope: 'user',
    backend: 'mem',
  } as any);
  return { registry, callsById };
}

describe('addDocument (Result-aware)', () => {
  it('persists the document when upsert succeeds', async () => {
    const { registry } = await makeRegistry([{ ok: true }]);
    const doc = await (registry as any).addDocument('test', {
      id: 'a-0',
      text: 'hello',
      metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
    });
    expect(doc.id).toBe('a-0');
    expect(doc.createdAt).toBeDefined();
  });

  it('throws when upsert returns Result.ok=false', async () => {
    const { registry } = await makeRegistry([
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
    ]);
    await expect(
      (registry as any).addDocument('test', {
        id: 'a-0',
        text: 'hello',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
      }),
    ).rejects.toThrow(/503/);
  });

  it('does NOT persist the document when upsert fails', async () => {
    const { registry } = await makeRegistry([
      { ok: false, error: new Error('Qdrant upsert failed: 401') },
    ]);
    await expect(
      (registry as any).addDocument('test', {
        id: 'a-0',
        text: 'hello',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
      }),
    ).rejects.toThrow();
    // The stored.documents map must not contain a-0
    const stored = (registry as any).collections.get('test');
    expect(stored.documents.has('a-0')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests — expect 2 of the 3 to fail**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: "persists when upsert succeeds" passes (current behavior already allows that). The "throws when..." and "does NOT persist when..." tests fail because `addDocument` currently ignores `.ok`.

- [ ] **Step 3: Fix `addDocument` in `srv/rag-collections.ts`**

Find `addDocument` (~line 367). Replace the existing upsert block:

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
    // Upsert into RAG store. IRagEditor.upsert returns Result<T, RagError>;
    // a backend rejection comes back as { ok: false }, NOT a thrown error.
    // We must inspect .ok and throw on failure or chunks vanish silently.
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

- [ ] **Step 4: Run tests + type check**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: all 3 tests pass.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add srv/rag-collections.ts test/unit/rag-collections-bulk.test.ts
git commit -m "fix(rag): addDocument throws when stored.rag.upsert returns !ok"
```

---

## Task 3: `isTransient` + `tryWithRetry` helpers (TDD)

**Files:**
- Modify: `srv/rag-collections.ts`
- Modify: `test/unit/rag-collections-bulk.test.ts`

- [ ] **Step 1: Add helper unit tests**

Append to `test/unit/rag-collections-bulk.test.ts`:

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
  it('considers err.code / err.status / err.statusCode fields', () => {
    const e1 = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
    expect(isTransient(e1)).toBe(true);
    const e2 = Object.assign(new Error('boom'), { status: 503 });
    expect(isTransient(e2)).toBe(true);
    const e3 = Object.assign(new Error('boom'), { statusCode: 429 });
    expect(isTransient(e3)).toBe(true);
  });
  it('classifies wrapped RagError by message — UPSERT_ERROR code alone is not enough', () => {
    // The UPSERT_ERROR code covers both transient (HTTP 5xx in body) and
    // permanent (validation) cases — classification must come from message.
    const t1 = Object.assign(
      new Error('Error: Request failed with status code 503'),
      { code: 'UPSERT_ERROR' },
    );
    const t2 = Object.assign(
      new Error('Error: Request failed with status code 500'),
      { code: 'UPSERT_ERROR' },
    );
    const t3 = Object.assign(new Error('502 Bad Gateway'), {
      code: 'UPSERT_ERROR',
    });
    expect(isTransient(t1)).toBe(true);
    expect(isTransient(t2)).toBe(true);
    expect(isTransient(t3)).toBe(true);

    const p1 = Object.assign(new Error('validation failed: max length 500'), {
      code: 'UPSERT_ERROR',
    });
    const p2 = Object.assign(new Error('validation failed'), {
      code: 'UPSERT_ERROR',
    });
    expect(isTransient(p1)).toBe(false);
    expect(isTransient(p2)).toBe(false);
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
    const fn = jest.fn().mockRejectedValue(new Error('Qdrant upsert failed: 503 Service Unavailable'));
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

  it('canSleep=false blocks further retry without calling onSleep', async () => {
    const { sleep, sleeps } = sleeper();
    const onSleep = jest.fn();
    const fn = jest.fn().mockRejectedValue(new Error('Qdrant upsert failed: 503 Service Unavailable'));
    const res = await tryWithRetry(fn, {
      sleep,
      canSleep: () => false,
      onSleep,
    });
    expect(res.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1); // only initial attempt
    expect(sleeps).toEqual([]);
    expect(onSleep).not.toHaveBeenCalled();
  });

  it('onSleep is called before each backoff sleep', async () => {
    const { sleep, sleeps } = sleeper();
    const onSleepCalls: number[] = [];
    const onSleep = (ms: number) => onSleepCalls.push(ms);
    const fn = jest.fn().mockRejectedValue(new Error('Qdrant upsert failed: 503 Service Unavailable'));
    const res = await tryWithRetry(fn, { sleep, onSleep });
    expect(res.ok).toBe(false);
    expect(onSleepCalls).toEqual([200, 500, 1500]);
    expect(sleeps).toEqual([200, 500, 1500]);
  });
});
```

- [ ] **Step 2: Run the tests — expect them to fail with "module export not found"**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: TypeScript / import error — `isTransient` and `tryWithRetry` are not yet exported. Red phase.

- [ ] **Step 3: Add the helpers to `srv/rag-collections.ts`**

Open `srv/rag-collections.ts`. At the top level (after the imports, before the first class declaration), add:

```typescript
/**
 * HTTP/status-context regex used by isTransient — matches "status 503",
 * "HTTP 502", "status code 429", "429 Too Many Requests",
 * "503 Service Unavailable", etc.
 * Deliberately does NOT match bare 3-digit numbers like "max length 500"
 * because that triggered false positives against UPSERT_ERROR-wrapped
 * validation errors.
 */
const TRANSIENT_HTTP_RE =
  /\b(?:status(?: code)?|http)\s*:?\s*(?:429|5\d\d)\b|\b429\s+too many requests\b|\b5\d\d\s+(?:bad gateway|service unavailable|gateway timeout|internal server error)\b/i;

const TRANSIENT_NETWORK_RE =
  /(rate[\s-]?limit|timeout|ECONNRESET|ETIMEDOUT|network)/i;

/**
 * Classify an embedder/RAG-write error as transient (worth retrying) or
 * permanent. Conservative: anything unrecognized is treated as permanent
 * so we don't burn retry budget on validation errors.
 *
 * Check order (first match wins):
 *  1. err.status / err.statusCode (429 or 5xx) → transient
 *  2. err.code === ETIMEDOUT or ECONNRESET → transient
 *  3. err.message matches an HTTP/status-context signal or a network
 *     keyword (rate-limit, timeout, ECONNRESET, ETIMEDOUT, network)
 *  4. everything else → permanent
 *
 * Today's RagError carries (message, code) only — no structured HTTP
 * fields — so for RagError instances step 3 is what gets used. Steps 1
 * and 2 are forward-compat for plain Error shapes from HTTP clients.
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
  if (TRANSIENT_HTTP_RE.test(msg)) return true;
  if (TRANSIENT_NETWORK_RE.test(msg)) return true;
  return false;
}

const RETRY_BACKOFFS_MS = [200, 500, 1500] as const;

/** Max total ms a single bulk call may spend sleeping in retry backoff. */
export const RETRY_BUDGET_MS = 30_000;

export interface TryWithRetryOptions {
  /** Override the sleep function (tests inject a fake to avoid real waits). */
  sleep?: (ms: number) => Promise<void>;
  /** Predicate: may the helper sleep `delay` ms now? Defaults to () => true. */
  canSleep?: (delay: number) => boolean;
  /** Notification: account for a sleep that's about to happen. Defaults to noop. */
  onSleep?: (delay: number) => void;
}

/**
 * Run `fn`. On transient failure, retry with [200ms, 500ms, 1500ms] backoff
 * (max 3 retries, total worst-case ~2.2s of delay per failing call).
 * Returns `{ ok: true, value }` or `{ ok: false, error }`.
 *
 * `canSleep` / `onSleep` let a caller (e.g. addDocumentsBulk) impose a
 * shared retry-sleep budget across multiple invocations. When omitted the
 * helper is budget-naive.
 */
export async function tryWithRetry<T>(
  fn: () => Promise<T>,
  opts: TryWithRetryOptions = {},
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const canSleep = opts.canSleep ?? (() => true);
  const onSleep = opts.onSleep ?? (() => undefined);
  let lastErr: Error | undefined;
  for (let i = 0; i <= RETRY_BACKOFFS_MS.length; i += 1) {
    if (i > 0) {
      const delay = RETRY_BACKOFFS_MS[i - 1];
      onSleep(delay);
      await sleep(delay);
    }
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const isLast = i === RETRY_BACKOFFS_MS.length;
      const nextDelay = isLast ? 0 : RETRY_BACKOFFS_MS[i];
      if (!isTransient(lastErr) || isLast || !canSleep(nextDelay)) {
        return { ok: false, error: lastErr };
      }
    }
  }
  return {
    ok: false,
    error: lastErr ?? new Error('tryWithRetry: unreachable'),
  };
}
```

- [ ] **Step 4: Run tests — expect green**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: 14 helper tests pass (8 `isTransient` + 6 `tryWithRetry`) on top of the 3 from Task 2 → 17 total in this suite.

- [ ] **Step 5: Commit**

```bash
git add srv/rag-collections.ts test/unit/rag-collections-bulk.test.ts
git commit -m "feat(rag): add isTransient + tryWithRetry helpers"
```

---

## Task 4: Wire retry into `addDocumentsBulk` + warn log on partial

**Files:**
- Modify: `srv/rag-collections.ts`
- Modify: `test/unit/rag-collections-bulk.test.ts`

- [ ] **Step 1: Add integration tests for the bulk loop**

Append to `test/unit/rag-collections-bulk.test.ts`:

```typescript
describe('addDocumentsBulk integration', () => {
  function docs(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `chunk-${i}`,
      text: 'x',
      metadata: { source: 'a.md', chunkIndex: i, totalChunks: n },
    }));
  }

  it('all chunks succeed → added equals total, errors empty', async () => {
    const { registry } = await makeRegistry([{ ok: true }]);
    const res = await (registry as any).addDocumentsBulk('test', docs(5));
    expect(res.added).toBe(5);
    expect(res.errors).toEqual([]);
  });

  it('transient failures eventually succeed via retry', async () => {
    const byId = new Map<string, WriterScript>();
    // chunks 1 and 3 fail twice with a transient error, then succeed
    byId.set('chunk-1', [
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
      { ok: true },
    ]);
    byId.set('chunk-3', [
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
      { ok: true },
    ]);
    const { registry, callsById } = await makeRegistry([{ ok: true }], byId);
    const res = await (registry as any).addDocumentsBulk('test', docs(5));
    expect(res.added).toBe(5);
    expect(res.errors).toEqual([]);
    expect(callsById.get('chunk-1')).toBe(3);
    expect(callsById.get('chunk-3')).toBe(3);
  });

  it('permanent failures count as failed without retry', async () => {
    const byId = new Map<string, WriterScript>();
    byId.set('chunk-2', [
      { ok: false, error: new Error('Qdrant upsert failed: 401 Unauthorized') },
    ]);
    const { registry, callsById } = await makeRegistry([{ ok: true }], byId);
    const res = await (registry as any).addDocumentsBulk('test', docs(5));
    expect(res.added).toBe(4);
    expect(callsById.get('chunk-2')).toBe(1);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toMatch(/chunk-2/);
  });

  it('emits a warn log when added < total', async () => {
    const byId = new Map<string, WriterScript>();
    byId.set('chunk-2', [
      { ok: false, error: new Error('Qdrant upsert failed: 401 Unauthorized') },
    ]);
    const warns: any[] = [];
    const originalLog = cds.log;
    (cds as any).log = (_name: string) => ({
      info: () => undefined,
      warn: (msg: string, ctx?: unknown) => warns.push({ msg, ctx }),
      error: () => undefined,
      debug: () => undefined,
    });
    try {
      const { registry } = await makeRegistry([{ ok: true }], byId);
      await (registry as any).addDocumentsBulk('test', docs(5));
    } finally {
      (cds as any).log = originalLog;
    }
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const partial = warns.find((w) => /partial/i.test(w.msg));
    expect(partial).toBeDefined();
    expect(partial.ctx.total).toBe(5);
    expect(partial.ctx.added).toBe(4);
    expect(partial.ctx.failed).toBe(1);
  });

  it('stops retrying once the shared retry-sleep budget is exhausted', async () => {
    // Use a tiny budget (1000 ms) so 1 full chunk-retry (2200 ms) blows it,
    // and an instant sleep so the test is fast.
    const instantSleep = (_ms: number) => Promise.resolve();
    const transient = (): WriterScript => [
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
      { ok: true },
    ];
    const byId = new Map<string, WriterScript>();
    for (let i = 0; i < 5; i += 1) byId.set(`chunk-${i}`, transient());
    const { registry, callsById } = await makeRegistry([{ ok: true }], byId);
    const res = await (registry as any).addDocumentsBulk('test', docs(5), undefined, {
      sleep: instantSleep,
      budgetMs: 1000,
    });
    // chunk-0 spends 200+500=700ms in retry (budget left: 300), tries 1500
    // backoff → canSleep(1500) === false → stops on 3rd attempt. Other
    // chunks: budget already > 700 used; canSleep(200) checks 700+200<=1000
    // → true for chunk-1 1st retry. After chunk-1's 200ms retry budget=900;
    // canSleep(500) returns 900+500<=1000 → false. Chunk-1 stops there.
    // Subsequent chunks have budget ≥ 900 used, canSleep(200) false → no
    // retry, single attempt each.
    expect(callsById.get('chunk-0')).toBe(3); // initial + 2 retries
    expect(callsById.get('chunk-1')).toBe(2); // initial + 1 retry
    expect(callsById.get('chunk-2')).toBe(1); // initial only
    expect(callsById.get('chunk-3')).toBe(1);
    expect(callsById.get('chunk-4')).toBe(1);
    expect(res.added).toBe(0); // all transient-failing, none recovered
    expect(res.errors.length).toBe(5);
  });

  it('successful chunks continue after budget is exhausted', async () => {
    const instantSleep = (_ms: number) => Promise.resolve();
    // First 2 chunks always fail transiently (exhaust budget quickly).
    // chunks 2..4 succeed on first try.
    const exhaust: WriterScript = [
      { ok: false, error: new Error('Qdrant upsert failed: 503 Service Unavailable') },
    ];
    const byId = new Map<string, WriterScript>();
    byId.set('chunk-0', exhaust);
    byId.set('chunk-1', exhaust);
    for (let i = 2; i < 5; i += 1) byId.set(`chunk-${i}`, [{ ok: true }]);
    const { registry, callsById } = await makeRegistry([{ ok: true }], byId);
    const res = await (registry as any).addDocumentsBulk('test', docs(5), undefined, {
      sleep: instantSleep,
      budgetMs: 500, // less than even 1 full retry chain
    });
    // chunks 0..1 each consumed enough budget that chunks 2..4 still got
    // attempted once and succeeded.
    expect(callsById.get('chunk-2')).toBe(1);
    expect(callsById.get('chunk-3')).toBe(1);
    expect(callsById.get('chunk-4')).toBe(1);
    expect(res.added).toBe(3); // chunks 2..4
    expect(res.errors.length).toBe(2); // chunks 0..1
  });
});
```

Notes about the warn-log test:
- Replacing `cds.log` globally before constructing the registry is necessary because the registry / bulk loop will reference `cds.log('rag-collections')` at call time. The `try/finally` ensures other tests aren't affected.
- The file-level `jest.mock('@sap/cds', ...)` supplies a runtime mock for `rag-collections.ts`; the warn-log test temporarily replaces that mocked `cds.log` implementation.

- [ ] **Step 2: Run tests — expect 3 of the 6 to fail**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected:
- "all chunks succeed" — passes (no retry needed).
- "transient failures eventually succeed via retry" — fails (no retry yet).
- "permanent failures count as failed without retry" — passes (current swallow-errors loop already counts as 4 added, 1 errors; 401 isn't transient anyway). Verify this.
- "emits a warn log when added < total" — fails (no log today).
- "stops retrying once the shared retry-sleep budget is exhausted" — fails because the current loop does not call `tryWithRetry` or account for retry sleeps. The fourth arg is passed through `(registry as any)`, so TypeScript will not catch the signature mismatch in this red phase.
- "successful chunks continue after budget is exhausted" — passes even before budget plumbing because chunks 2..4 succeed on their first attempt. It remains useful as a regression test after the refactor.

Confirm exact failures before continuing.

- [ ] **Step 3: Refactor `addDocumentsBulk`**

Find `addDocumentsBulk` (~line 395) in `srv/rag-collections.ts`. Replace the body:

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

with (adding an optional fourth `options` arg for budget+sleep injection — backward compatible because the existing call sites don't pass it):

Update the method signature in `srv/rag-collections.ts`:

```typescript
  async addDocumentsBulk(
    collectionId: string,
    docs: Omit<RagDocument, 'createdAt'>[],
    namespace?: string,
    options?: {
      /** Override sleep — tests inject instant resolve to avoid real waits. */
      sleep?: (ms: number) => Promise<void>;
      /** Override the shared retry-sleep budget (ms). Defaults to RETRY_BUDGET_MS. */
      budgetMs?: number;
    },
  ): Promise<{ added: number; errors: string[] }> {
```

And the body:

```typescript
    const errors: string[] = [];
    let added = 0;
    const budgetMs = options?.budgetMs ?? RETRY_BUDGET_MS;
    const sleep = options?.sleep;
    let retrySleepSpentMs = 0;

    for (const doc of docs) {
      const result = await tryWithRetry(
        () => this.addDocument(collectionId, doc, namespace),
        {
          sleep,
          canSleep: (delay) => retrySleepSpentMs + delay <= budgetMs,
          onSleep: (delay) => {
            retrySleepSpentMs += delay;
          },
        },
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
- `tryWithRetry` and `RETRY_BUDGET_MS` are exported from the same file (Task 3); no import needed.
- `cds.log('rag-collections')` is the standard CAP logger handle. If the file already defines a module-level `log = cds.log(...)`, reuse it. Otherwise the inline call is fine — it's per-bulk, not hot path.
- The new `options` arg is optional and not passed by any production caller in this PR — the budget-exhaustion tests use it to keep runtime sub-second. Production paths fall through to the real setTimeout-backed sleep and the full 30s budget.

- [ ] **Step 4: Run tests + type check**

Run: `npm run test:unit -- --testPathPatterns="rag-collections-bulk"`
Expected: 23 tests pass (3 addDocument + 14 helpers + 6 bulk integration).

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add srv/rag-collections.ts test/unit/rag-collections-bulk.test.ts
git commit -m "feat(rag): retry transient bulk failures with budget + warn log on partial"
```

---

## Task 5: Client UX — chat-📎 surfaces added/chunks, alerts on loss

**Files:**
- Modify: `app/chat/webapp/index.html`

- [ ] **Step 1: Update `handleQuickFileAttach`**

Find `handleQuickFileAttach`:

```bash
grep -n "function handleQuickFileAttach" app/chat/webapp/index.html
```

Locate the current success block:

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

Immediately after `handleQuickFileAttach`. Replace the current block:

```javascript
            bar.innerHTML = attachedFiles.map((f, i) =>
                `<span style="color:#00bfff">&#x1F4CE; ${escapeHtml(f.name)}</span> <span style="color:#555">(${f.chunks} chunks)</span> <button onclick="removeAttachedFile(${i})" style="background:none;border:none;color:#ff5555;cursor:pointer;font-size:11px;font-family:'Courier New',monospace">[x]</button>`
            ).join(' &nbsp; ');
```

with:

```javascript
            bar.innerHTML = attachedFiles.map((f, i) => {
                const countSpan = f.failed > 0
                    ? `<span style="color:#ff5555" title="${f.failed} chunk(s) failed — some content may be missing">(${f.added}/${f.chunks} chunks)</span>`
                    : `<span style="color:#555">(${f.chunks} chunks)</span>`;
                return `<span style="color:#00bfff">&#x1F4CE; ${escapeHtml(f.name)}</span> ${countSpan} <button onclick="removeAttachedFile(${i})" style="background:none;border:none;color:#ff5555;cursor:pointer;font-size:11px;font-family:'Courier New',monospace">[x]</button>`;
            }).join(' &nbsp; ');
```

- [ ] **Step 3: Update Manage `uploadFile` status to also color red on partial**

Find the Manage upload success block:

```bash
grep -n "Uploaded:" app/chat/webapp/index.html
```

Locate (around line 1741):

```javascript
                statusEl.textContent = `Uploaded: ${data.chunks} chunks, ${data.added} added`;
                statusEl.style.color = '#00ff00';
```

Replace with:

```javascript
                const chunks = data.chunks;
                const added = typeof data.added === 'number' ? data.added : chunks;
                statusEl.textContent = `Uploaded: ${chunks} chunks, ${added} added`;
                statusEl.style.color = added < chunks ? '#ff5555' : '#00ff00';
```

No alert is added in the Manage flow — the status line is already in the user's focus when they pressed Upload, so a modal would be redundant. Chat-📎 gets a toast because its bar is peripheral to chat activity.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): both upload paths surface added/chunks; partial = red"
```

---

## Task 6: Final verification + cleanup + PR

**Files:** none.

- [ ] **Step 1: Full unit-test pass**

Run: `npm run test:unit`
Expected: full suite green, including the 23 rag-collections-bulk tests (3 addDocument + 14 helpers + 6 bulk integration).

- [ ] **Step 2: Lint + tsc**

Run: `npm run lint:check`
Run: `npx tsc --noEmit`
Both: clean.

- [ ] **Step 3: Manual smoke against deploy (passive observations)**

After deploy to `deploy/acme-sandbox/dev`:

1. Small chat-📎 upload → green `(N chunks)`, no alert.
2. Large chat-📎 upload (≥30 chunks) **during an active chat session** that's actively hitting AI Core → expect `(N/N chunks)` green far more reliably than before. Per issue #90 acceptance: **≥95% of uploads should report `added === chunks`**. Repeat a handful of times if needed to sample.
3. When `added < chunks` is observed: chat-📎 bar shows `(M/N chunks)` in red, alert fires once. Manage upload of the same file shows `Uploaded: N chunks, M added` styled red.
4. `cf logs cloud-llm-hub-srv --recent | grep "Bulk add partial"` — every partial bulk must have a warn line with `collection`, `total`, `added`, `failed`, `firstErrors`.
5. Manage panel upload of a healthy large file → `Uploaded: N chunks, N added` green; no regression.

- [ ] **Step 4: Delete spec + plan**

Per `CLAUDE.md` rule: drop spec/plan once implemented.

```bash
git rm docs/superpowers/specs/2026-05-17-rag-upload-reliability-design.md \
       docs/superpowers/plans/2026-05-17-rag-upload-reliability.md
git commit -m "chore: remove implemented spec/plan for RAG upload reliability"
```

- [ ] **Step 5: Push + PR**

```bash
git push -u origin rag-upload-reliability
gh pr create --base main --head rag-upload-reliability \
  --title "fix(rag): silent chunk loss — Result-aware addDocument, retry, observability, chat-📎 feedback" \
  --body "Closes #90.

## Summary
- \`addDocument\` now inspects \`Result.ok\` from \`stored.rag.upsert\` and throws on failure (root cause of silent loss).
- \`addDocumentsBulk\` wraps each chunk in \`tryWithRetry\` with [200ms, 500ms, 1500ms] backoff. Transient errors (HTTP 429/5xx, ECONNRESET/ETIMEDOUT, rate-limit) get up to 3 retries; permanent errors fail fast.
- A warn log fires on partial bulks with collection/total/added/failed/firstErrors.
- chat-📎 attached-files bar now shows \`added/chunks\` parity and turns red with an alert when chunks were lost.

## Test plan
- [x] 23 unit/integration tests in test/unit/rag-collections-bulk.test.ts
- [x] tsc + lint clean
- [ ] Manual smoke against acme-sandbox/dev: large chat-📎 upload, retry recovery, warn log present

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
