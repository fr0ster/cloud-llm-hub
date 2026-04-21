# RAG Correction Layer — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class corrections layer to the cloud-llm-hub RAG, exposed as MCP tools (for agents) and REST endpoints (for UI), backed by shared core logic that extends document metadata with supersession/deprecation semantics.

**Architecture:** Single source of truth in `srv/rag-correction-core.ts` (pure logic, no I/O). MCP tool handlers (`srv/rag-mcp-tools.ts`) and REST route handlers (existing `srv/rag-handler.ts`, extended) both delegate to this core. Inactive-result filtering must live at the `IRag` boundary, not only in the REST query handler: add a local wrapper in `srv/agent-manager.ts` for injected collection stores so both `/v1/rag/.../query` and agent retrieval via `X-Rag-Collections` exclude `deprecated` / `superseded` by default. MCP tool entries are concatenated onto the entries list returned by `HandlerExporter` in `srv/agent-manager.ts`, so they flow through the same tool-vectorization and exposition-filtering pipeline as every other tool. No upstream changes to `@mcp-abap-adt/core` or `@mcp-abap-adt/llm-agent`.

**Tech Stack:** TypeScript strict, Express router, local `CollectionRegistry` from `srv/rag-collections.ts`, `@mcp-abap-adt/llm-agent` (`IRag`, `VectorRag`), Jest (ts-jest) for unit tests, Zod for tool input schemas, Biome for formatting.

**Spec:** `docs/superpowers/specs/rag-correction-layer.md`

**Scope of this plan (foundation only):**
- Metadata extension: `canonicalKey`, `tags`, `supersededBy`, `deprecatedAt`, `deprecatedReason`, `sessionId`.
- Core functions: `deprecate`, `correct`, `filterActive`, `resolveCanonicalChain`.
- Three MCP tools: `rag_add`, `rag_correct`, `rag_deprecate`. (`rag_search` is deferred — existing agent RAG retrieval already reads the same collections, but this plan must wire the inactive filter into the collection-store wrapper used on the agent path.)
- Two REST endpoints: `POST /v1/rag/collections/:id/documents/:did/deprecate`, `POST /v1/rag/collections/:id/documents/:did/correct`.
- Query default filter: exclude `deprecated` and `superseded` unless caller opts in, on both REST and agent retrieval paths.
- Unit tests for core + handler delegation.

**Out of scope (future plans):**
- UI buttons and stable message IDs (Plan 2).
- Auto-verification hooks on tool-call success (Plan 3).
- Weighted retrieval ranking, canonical-key-aware re-ranking in llm-agent (Plan 4).
- Session-lifecycle compaction.

---

## File Structure

**New files:**
- `srv/rag-correction-core.ts` — pure metadata/supersession logic. Exports types and functions. No I/O, no registry calls; takes documents as input and returns modified documents.
- `srv/rag-mcp-tools.ts` — three MCP tool entries (`rag_add`, `rag_correct`, `rag_deprecate`) with Zod schemas; handlers call core + registry.
- `test/unit/rag-correction-core.test.ts` — unit tests for core.
- `test/unit/rag-mcp-tools.test.ts` — unit tests for tool handlers with a mocked registry.

**Modified files:**
- `srv/rag-handler.ts` — add `deprecate` and `correct` REST routes; keep `/query` aligned with the same inactive-filter semantics.
- `srv/agent-manager.ts` — add a local `IRag` wrapper for inactive filtering on dynamic collection stores; concat local RAG tool entries onto the HandlerExporter entries.

---

## Task 1: Define correction metadata types and validation

**Files:**
- Create: `srv/rag-correction-core.ts`
- Test: `test/unit/rag-correction-core.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/rag-correction-core.test.ts
import {
  type CorrectionMetadata,
  validateCorrectionMetadata,
} from '../../srv/rag-correction-core';

describe('validateCorrectionMetadata', () => {
  it('accepts minimal valid metadata', () => {
    const meta: CorrectionMetadata = { canonicalKey: 'tutorial.book.package' };
    expect(() => validateCorrectionMetadata(meta)).not.toThrow();
  });

  it('accepts all optional fields', () => {
    const meta: CorrectionMetadata = {
      canonicalKey: 'tutorial.book.package',
      tags: ['verified'],
      sessionId: 'sess-1',
      supersededBy: 'doc-42',
      deprecatedAt: 1700000000,
      deprecatedReason: 'obsolete',
    };
    expect(() => validateCorrectionMetadata(meta)).not.toThrow();
  });

  it('rejects empty canonicalKey', () => {
    expect(() =>
      validateCorrectionMetadata({ canonicalKey: '' }),
    ).toThrow('canonicalKey');
  });

  it('rejects unknown tags', () => {
    expect(() =>
      validateCorrectionMetadata({
        canonicalKey: 'k',
        tags: ['bogus'] as unknown as CorrectionMetadata['tags'],
      }),
    ).toThrow('tag');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- rag-correction-core`
Expected: FAIL — module not found.

- [ ] **Step 3: Create core module with minimal implementation**

```typescript
// srv/rag-correction-core.ts
export type CorrectionTag = 'verified' | 'deprecated' | 'superseded' | 'correction';

export interface CorrectionMetadata {
  canonicalKey: string;
  tags?: CorrectionTag[];
  sessionId?: string;
  supersededBy?: string;
  deprecatedAt?: number;
  deprecatedReason?: string;
}

const ALLOWED_TAGS: readonly CorrectionTag[] = [
  'verified',
  'deprecated',
  'superseded',
  'correction',
];

export function validateCorrectionMetadata(meta: CorrectionMetadata): void {
  if (!meta.canonicalKey || meta.canonicalKey.trim() === '') {
    throw new Error('canonicalKey must be a non-empty string');
  }
  if (meta.tags) {
    for (const t of meta.tags) {
      if (!ALLOWED_TAGS.includes(t)) {
        throw new Error(`unknown tag "${t}" — allowed: ${ALLOWED_TAGS.join(', ')}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- rag-correction-core`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/rag-correction-core.ts test/unit/rag-correction-core.test.ts
git commit -m "feat(rag): correction metadata types and validation"
```

---

## Task 2: Core deprecate function

**Files:**
- Modify: `srv/rag-correction-core.ts`
- Test: `test/unit/rag-correction-core.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/unit/rag-correction-core.test.ts`:

```typescript
import { deprecateMetadata } from '../../srv/rag-correction-core';

describe('deprecateMetadata', () => {
  it('marks a fresh entry as deprecated with timestamp and reason', () => {
    const input: CorrectionMetadata = { canonicalKey: 'k' };
    const now = 1800000000;
    const out = deprecateMetadata(input, 'obsolete pattern', now);
    expect(out.tags).toContain('deprecated');
    expect(out.deprecatedAt).toBe(now);
    expect(out.deprecatedReason).toBe('obsolete pattern');
  });

  it('is idempotent when already deprecated (keeps original timestamp)', () => {
    const input: CorrectionMetadata = {
      canonicalKey: 'k',
      tags: ['deprecated'],
      deprecatedAt: 100,
      deprecatedReason: 'first',
    };
    const out = deprecateMetadata(input, 'second', 200);
    expect(out.deprecatedAt).toBe(100);
    expect(out.deprecatedReason).toBe('first');
    expect(out.tags?.filter((t) => t === 'deprecated')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- rag-correction-core`
Expected: FAIL — `deprecateMetadata is not a function`.

- [ ] **Step 3: Implement**

Append to `srv/rag-correction-core.ts`:

```typescript
export function deprecateMetadata(
  current: CorrectionMetadata,
  reason: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CorrectionMetadata {
  validateCorrectionMetadata(current);
  const alreadyDeprecated = current.tags?.includes('deprecated') ?? false;
  if (alreadyDeprecated) {
    return current;
  }
  const nextTags: CorrectionTag[] = [...(current.tags ?? []), 'deprecated'];
  return {
    ...current,
    tags: nextTags,
    deprecatedAt: nowSeconds,
    deprecatedReason: reason,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- rag-correction-core`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add srv/rag-correction-core.ts test/unit/rag-correction-core.test.ts
git commit -m "feat(rag): deprecateMetadata core function"
```

---

## Task 3: Core correct function (supersession)

**Files:**
- Modify: `srv/rag-correction-core.ts`
- Test: `test/unit/rag-correction-core.test.ts`

- [ ] **Step 1: Add failing tests**

```typescript
import { buildCorrectionMetadata } from '../../srv/rag-correction-core';

describe('buildCorrectionMetadata', () => {
  it('marks predecessor as superseded and links new to old', () => {
    const old: CorrectionMetadata = { canonicalKey: 'k', tags: ['verified'] };
    const { predecessor, next } = buildCorrectionMetadata({
      predecessor: old,
      predecessorId: 'doc-1',
      newEntryId: 'doc-2',
      reason: 'fix field name',
    });
    expect(predecessor.tags).toContain('superseded');
    expect(predecessor.supersededBy).toBe('doc-2');
    expect(next.tags).toContain('correction');
    expect(next.canonicalKey).toBe('k');
  });

  it('rejects when predecessor has no canonicalKey', () => {
    const old = { canonicalKey: '' } as CorrectionMetadata;
    expect(() =>
      buildCorrectionMetadata({
        predecessor: old,
        predecessorId: 'x',
        newEntryId: 'y',
        reason: 'r',
      }),
    ).toThrow('canonicalKey');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- rag-correction-core`
Expected: FAIL — `buildCorrectionMetadata is not a function`.

- [ ] **Step 3: Implement**

```typescript
export interface BuildCorrectionInput {
  predecessor: CorrectionMetadata;
  predecessorId: string;
  newEntryId: string;
  reason: string;
  nowSeconds?: number;
}

export function buildCorrectionMetadata(input: BuildCorrectionInput): {
  predecessor: CorrectionMetadata;
  next: CorrectionMetadata;
} {
  validateCorrectionMetadata(input.predecessor);
  const predTags: CorrectionTag[] = [
    ...(input.predecessor.tags ?? []).filter((t) => t !== 'superseded'),
    'superseded',
  ];
  const predecessor: CorrectionMetadata = {
    ...input.predecessor,
    tags: predTags,
    supersededBy: input.newEntryId,
  };
  const next: CorrectionMetadata = {
    canonicalKey: input.predecessor.canonicalKey,
    tags: ['correction'],
    sessionId: input.predecessor.sessionId,
  };
  return { predecessor, next };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- rag-correction-core`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add srv/rag-correction-core.ts test/unit/rag-correction-core.test.ts
git commit -m "feat(rag): buildCorrectionMetadata for supersession"
```

---

## Task 4: Active-result filter

**Files:**
- Modify: `srv/rag-correction-core.ts`
- Test: `test/unit/rag-correction-core.test.ts`

- [ ] **Step 1: Add failing tests**

```typescript
import { filterActive } from '../../srv/rag-correction-core';

describe('filterActive', () => {
  type Row = { metadata: CorrectionMetadata };
  const rows: Row[] = [
    { metadata: { canonicalKey: 'a', tags: ['verified'] } },
    { metadata: { canonicalKey: 'b', tags: ['deprecated'] } },
    { metadata: { canonicalKey: 'c', tags: ['superseded'] } },
    { metadata: { canonicalKey: 'd' } },
  ];

  it('excludes deprecated and superseded by default', () => {
    const out = filterActive(rows, (r) => r.metadata);
    expect(out.map((r) => r.metadata.canonicalKey)).toEqual(['a', 'd']);
  });

  it('includes inactive when includeInactive is true', () => {
    const out = filterActive(rows, (r) => r.metadata, { includeInactive: true });
    expect(out).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- rag-correction-core`
Expected: FAIL — `filterActive is not a function`.

- [ ] **Step 3: Implement**

```typescript
export interface FilterActiveOptions {
  includeInactive?: boolean;
}

export function filterActive<T>(
  items: readonly T[],
  getMeta: (item: T) => CorrectionMetadata | undefined,
  options: FilterActiveOptions = {},
): T[] {
  if (options.includeInactive) {
    return [...items];
  }
  return items.filter((item) => {
    const tags = getMeta(item)?.tags ?? [];
    return !tags.includes('deprecated') && !tags.includes('superseded');
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- rag-correction-core`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add srv/rag-correction-core.ts test/unit/rag-correction-core.test.ts
git commit -m "feat(rag): filterActive for excluding deprecated and superseded entries"
```

---

## Task 5: REST endpoint — deprecate document

**Files:**
- Modify: `srv/rag-handler.ts`

Read first: `srv/rag-handler.ts:287-331` (existing GET/PUT/DELETE on `/rag/collections/:id/documents/:did`) for the exact shape of `registry.getDocument`, `registry.updateDocument`, and the `json`/`error` helpers used below.

- [ ] **Step 1: Add route after the existing DELETE at line 331**

```typescript
  // POST /v1/rag/collections/:id/documents/:did/deprecate
  router.post(
    '/rag/collections/:id/documents/:did/deprecate',
    async (req: Request, res: Response) => {
      try {
        const { id, did } = req.params;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
        if (!reason.trim()) {
          error(res, 400, 'reason is required');
          return;
        }
        const doc = registry.getDocument(id, did);
        if (!doc) {
          error(res, 404, 'Document not found');
          return;
        }
        const { deprecateMetadata, validateCorrectionMetadata } = await import(
          './rag-correction-core.js'
        );
        const currentMeta = (doc.metadata ?? {}) as Parameters<
          typeof deprecateMetadata
        >[0];
        if (!currentMeta.canonicalKey) {
          error(res, 422, 'Document has no canonicalKey — cannot deprecate');
          return;
        }
        validateCorrectionMetadata(currentMeta);
        const nextMeta = deprecateMetadata(currentMeta, reason);
        const updated = await registry.updateDocument(id, did, {
          ...doc,
          metadata: { ...doc.metadata, ...nextMeta },
        });
        if (!updated) {
          error(res, 404, 'Document not found during update');
          return;
        }
        json(res, 200, updated);
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    },
  );
```

- [ ] **Step 2: Add the new route to the endpoints log at line 451**

In the existing `log.info('RAG management routes registered', { ... endpoints: [...] })` array, add:

```typescript
      'POST /v1/rag/collections/:id/documents/:did/deprecate',
```

- [ ] **Step 3: Type-check**

Run: `npm run test:check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add srv/rag-handler.ts
git commit -m "feat(rag): REST endpoint to deprecate a RAG document"
```

---

## Task 6: REST endpoint — correct document

**Files:**
- Modify: `srv/rag-handler.ts`

- [ ] **Step 1: Add route after the deprecate route from Task 5**

```typescript
  // POST /v1/rag/collections/:id/documents/:did/correct
  // Body: { newText: string, reason: string, newMetadata?: Partial<CorrectionMetadata> }
  router.post(
    '/rag/collections/:id/documents/:did/correct',
    async (req: Request, res: Response) => {
      try {
        const { id, did } = req.params;
        const { newText, reason, newMetadata } = req.body ?? {};
        if (!newText || typeof newText !== 'string') {
          error(res, 400, 'newText is required');
          return;
        }
        if (!reason || typeof reason !== 'string') {
          error(res, 400, 'reason is required');
          return;
        }
        const predecessor = registry.getDocument(id, did);
        if (!predecessor) {
          error(res, 404, 'Predecessor document not found');
          return;
        }
        const predMeta = (predecessor.metadata ?? {}) as Record<string, unknown>;
        if (!predMeta.canonicalKey) {
          error(res, 422, 'Predecessor has no canonicalKey — cannot correct');
          return;
        }

        const { buildCorrectionMetadata } = await import(
          './rag-correction-core.js'
        );

        // Create the new document first (needs an ID to link predecessor to).
        const newDoc = await registry.addDocument(id, {
          text: newText,
          metadata: { ...predMeta, ...(newMetadata ?? {}), tags: ['correction'] },
        });

        const { predecessor: predNext } = buildCorrectionMetadata({
          predecessor: predMeta as Parameters<typeof buildCorrectionMetadata>[0]['predecessor'],
          predecessorId: did,
          newEntryId: newDoc.id,
          reason,
        });

        const updatedPred = await registry.updateDocument(id, did, {
          ...predecessor,
          metadata: { ...predecessor.metadata, ...predNext },
        });

        json(res, 201, { predecessor: updatedPred, next: newDoc, reason });
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    },
  );
```

- [ ] **Step 2: Add to the endpoints log**

```typescript
      'POST /v1/rag/collections/:id/documents/:did/correct',
```

- [ ] **Step 3: Type-check**

Run: `npm run test:check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add srv/rag-handler.ts
git commit -m "feat(rag): REST endpoint to correct a RAG document with supersession"
```

---

## Task 7: Default-filter inactive entries at the `IRag` boundary

**Files:**
- Modify: `srv/agent-manager.ts`
- Modify: `srv/openai-handler.ts`
- Modify: `srv/rag-handler.ts:414-447`
- Test: `test/unit/rag-correction-core.test.ts` or a focused wrapper test if preferred

- [ ] **Step 1: Add a local wrapper in `srv/agent-manager.ts`**

Place it near `ExpositionFilteringRag` so both wrappers live together:

```typescript
import type { CorrectionMetadata } from './rag-correction-core.js';
import { filterActive } from './rag-correction-core.js';

export class ActiveFilteringRag implements IRag {
  constructor(private inner: IRag) {}

  async upsert(
    text: string,
    metadata: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) {
    return this.inner.upsert(text, metadata, options);
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: {
      signal?: AbortSignal;
      ragFilter?: { namespace?: string; includeInactive?: boolean };
    },
  ) {
    const includeInactive = options?.ragFilter?.includeInactive === true;
    const overFetchK = includeInactive ? k : Math.max(k * 3, 20);
    const result = await this.inner.query(embedding, overFetchK, options);
    if (!result.ok) return result;

    const filtered = filterActive(
      result.value,
      (r) => r.metadata as CorrectionMetadata | undefined,
      { includeInactive },
    ).slice(0, k);

    return { ok: true as const, value: filtered };
  }

  async healthCheck() {
    return this.inner.healthCheck();
  }
}
```

This wrapper is required because filtering only in `/v1/rag/.../query` does not affect the agent path that injects dynamic collection stores into `deps.ragStores`.

- [ ] **Step 2: Wrap dynamic collection stores on the agent path**

In `srv/openai-handler.ts`, where dynamic stores are injected for `X-Rag-Collections`, wrap each store as:

```typescript
mergedStores[key] = new ExpositionFilteringRag(new ActiveFilteringRag(store));
```

If import direction makes that awkward, move `ActiveFilteringRag` to a small local module (for example `srv/rag-filtering-rag.ts`) and import it from both `agent-manager.ts` and `openai-handler.ts`.

- [ ] **Step 3: Keep the REST `/query` endpoint aligned**

Find the block starting `router.post('/rag/collections/:id/query', ...)` at line 414. Replace it with:

```typescript
  // POST /v1/rag/collections/:id/query
  router.post(
    '/rag/collections/:id/query',
    async (req: Request, res: Response) => {
      try {
        const store = registry.getRagStore(req.params.id);
        if (!store) {
          error(res, 404, `Collection "${req.params.id}" not found`);
          return;
        }

        const { text, k, namespace, includeInactive } = req.body;
        if (!text) {
          error(res, 400, 'text is required');
          return;
        }

        const { TextOnlyEmbedding } = await import('@mcp-abap-adt/llm-agent');
        const { filterActive } = await import('./rag-correction-core.js');
        const embedding = new TextOnlyEmbedding(text);
        const limit = k || 10;
        const queryK = includeInactive === true ? limit : Math.max(limit * 3, 20);
        const result = await store.query(embedding, queryK, {
          ragFilter: namespace ? { namespace } : undefined,
        });

        if (!result.ok) {
          error(res, 500, `Query failed: ${result.error}`);
          return;
        }

        const filtered = filterActive(
          result.value,
          (r) => r.metadata as CorrectionMetadata | undefined,
          { includeInactive: includeInactive === true },
        ).slice(0, limit);

        json(res, 200, { results: filtered });
      } catch (err) {
        error(res, 500, (err as Error).message);
      }
    },
  );
```

Add this import at the top of the file:

```typescript
import type { CorrectionMetadata } from './rag-correction-core.js';
```

and in the handler use:

```typescript
        const filtered = filterActive(
          result.value,
          (r) => r.metadata as CorrectionMetadata | undefined,
          { includeInactive: includeInactive === true },
        ).slice(0, limit);
```

- [ ] **Step 4: Type-check**

Run: `npm run test:check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add srv/agent-manager.ts srv/openai-handler.ts srv/rag-handler.ts
git commit -m "feat(rag): filter inactive RAG documents on REST and agent paths"
```

---

## Task 8: MCP tool handlers module

**Files:**
- Create: `srv/rag-mcp-tools.ts`
- Test: `test/unit/rag-mcp-tools.test.ts`

Read first: `srv/agent-manager.ts:1043-1115` to understand the `entries` shape (`{ toolDefinition, handler }`) and the two handler call signatures (length 1 = closure, length ≥ 2 = direct). Our tools use `length === 2` (direct) with our own context. Also read `srv/rag-collections.ts:308-382` first: the local `CollectionRegistry.addDocument(...)` requires a document `id`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/rag-mcp-tools.test.ts
import { buildRagToolEntries } from '../../srv/rag-mcp-tools';

describe('buildRagToolEntries', () => {
  const fakeRegistry = {
    getDocument: jest.fn(),
    addDocument: jest.fn(),
    updateDocument: jest.fn(),
  } as unknown as Parameters<typeof buildRagToolEntries>[0]['registry'];

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns three entries named rag_add, rag_correct, rag_deprecate', () => {
    const entries = buildRagToolEntries({ registry: fakeRegistry });
    expect(entries.map((e) => e.toolDefinition.name).sort()).toEqual([
      'rag_add',
      'rag_correct',
      'rag_deprecate',
    ]);
  });

  it('rag_add upserts a new document with canonicalKey', async () => {
    (fakeRegistry.addDocument as jest.Mock).mockResolvedValue({
      id: 'doc-1',
      text: 'hello',
      metadata: { canonicalKey: 'k' },
    });
    const entries = buildRagToolEntries({ registry: fakeRegistry });
    const ragAdd = entries.find((e) => e.toolDefinition.name === 'rag_add');
    const result = await ragAdd!.handler(
      {},
      {
        collectionId: 'c1',
        text: 'hello',
        canonicalKey: 'k',
        tags: ['verified'],
      },
    );
    expect(fakeRegistry.addDocument).toHaveBeenCalledWith('c1', {
      id: expect.any(String),
      text: 'hello',
      metadata: { canonicalKey: 'k', tags: ['verified'] },
    });
    expect(result).toMatchObject({ id: 'doc-1' });
  });

  it('rag_deprecate rejects when predecessor has no canonicalKey', async () => {
    (fakeRegistry.getDocument as jest.Mock).mockReturnValue({
      id: 'doc-1',
      text: 't',
      metadata: {},
    });
    const entries = buildRagToolEntries({ registry: fakeRegistry });
    const ragDeprecate = entries.find(
      (e) => e.toolDefinition.name === 'rag_deprecate',
    );
    await expect(
      ragDeprecate!.handler(
        {},
        { collectionId: 'c1', documentId: 'doc-1', reason: 'gone' },
      ),
    ).rejects.toThrow('canonicalKey');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- rag-mcp-tools`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

```typescript
// srv/rag-mcp-tools.ts
import { z } from 'zod';
import {
  buildCorrectionMetadata,
  type CorrectionMetadata,
  deprecateMetadata,
  validateCorrectionMetadata,
} from './rag-correction-core.js';
import type { CollectionRegistry } from './rag-collections.js';

export interface RagToolContext {
  // Future: sessionId, userId, roles. For now empty — kept for symmetry with other tool handlers.
}

export interface BuildRagToolEntriesOptions {
  registry: CollectionRegistry;
}

interface ToolEntry {
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
  };
  handler: (context: RagToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const tagsSchema = z
  .array(z.enum(['verified', 'deprecated', 'superseded', 'correction']))
  .optional();

export function buildRagToolEntries(
  opts: BuildRagToolEntriesOptions,
): ToolEntry[] {
  const { registry } = opts;

  const ragAdd: ToolEntry = {
    toolDefinition: {
      name: 'rag_add',
      description:
        'Add a new document to a RAG collection with correction-layer metadata (canonicalKey, tags, sessionId).',
      inputSchema: {
        collectionId: z.string(),
        text: z.string(),
        canonicalKey: z.string(),
        tags: tagsSchema,
        sessionId: z.string().optional(),
      },
    },
    handler: async (_ctx, args) => {
      const parsed = z
        .object({
          collectionId: z.string(),
          text: z.string(),
          canonicalKey: z.string(),
          tags: tagsSchema,
          sessionId: z.string().optional(),
        })
        .parse(args);
      const meta: CorrectionMetadata = {
        canonicalKey: parsed.canonicalKey,
        ...(parsed.tags ? { tags: parsed.tags } : {}),
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      };
      validateCorrectionMetadata(meta);
      return registry.addDocument(parsed.collectionId, {
        id: crypto.randomUUID(),
        text: parsed.text,
        metadata: meta as unknown as Record<string, unknown>,
      });
    },
  };

  const ragDeprecate: ToolEntry = {
    toolDefinition: {
      name: 'rag_deprecate',
      description:
        'Mark an existing RAG document as deprecated. Provide a human-readable reason.',
      inputSchema: {
        collectionId: z.string(),
        documentId: z.string(),
        reason: z.string().min(1),
      },
    },
    handler: async (_ctx, args) => {
      const { collectionId, documentId, reason } = z
        .object({
          collectionId: z.string(),
          documentId: z.string(),
          reason: z.string().min(1),
        })
        .parse(args);
      const doc = registry.getDocument(collectionId, documentId);
      if (!doc) {
        throw new Error(`Document ${documentId} not found in ${collectionId}`);
      }
      const currentMeta = (doc.metadata ?? {}) as CorrectionMetadata;
      if (!currentMeta.canonicalKey) {
        throw new Error('Document has no canonicalKey — cannot deprecate');
      }
      validateCorrectionMetadata(currentMeta);
      const nextMeta = deprecateMetadata(currentMeta, reason);
      return registry.updateDocument(collectionId, documentId, {
        ...doc,
        metadata: { ...doc.metadata, ...nextMeta },
      });
    },
  };

  const ragCorrect: ToolEntry = {
    toolDefinition: {
      name: 'rag_correct',
      description:
        'Replace an existing RAG document with a corrected version. The predecessor is marked superseded; a new correction entry is created.',
      inputSchema: {
        collectionId: z.string(),
        predecessorId: z.string(),
        newText: z.string(),
        reason: z.string().min(1),
      },
    },
    handler: async (_ctx, args) => {
      const { collectionId, predecessorId, newText, reason } = z
        .object({
          collectionId: z.string(),
          predecessorId: z.string(),
          newText: z.string(),
          reason: z.string().min(1),
        })
        .parse(args);
      const predecessor = registry.getDocument(collectionId, predecessorId);
      if (!predecessor) {
        throw new Error(`Predecessor ${predecessorId} not found`);
      }
      const predMeta = (predecessor.metadata ?? {}) as CorrectionMetadata;
      if (!predMeta.canonicalKey) {
        throw new Error('Predecessor has no canonicalKey — cannot correct');
      }
      const newDoc = await registry.addDocument(collectionId, {
        id: crypto.randomUUID(),
        text: newText,
        metadata: { ...predMeta, tags: ['correction'] } as unknown as Record<
          string,
          unknown
        >,
      });
      const { predecessor: predNext } = buildCorrectionMetadata({
        predecessor: predMeta,
        predecessorId,
        newEntryId: newDoc.id,
        reason,
      });
      const updatedPred = await registry.updateDocument(
        collectionId,
        predecessorId,
        {
          ...predecessor,
          metadata: { ...predecessor.metadata, ...predNext },
        },
      );
      return { predecessor: updatedPred, next: newDoc, reason };
    },
  };

  return [ragAdd, ragDeprecate, ragCorrect];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- rag-mcp-tools`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check**

Run: `npm run test:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add srv/rag-mcp-tools.ts test/unit/rag-mcp-tools.test.ts
git commit -m "feat(rag): MCP tools rag_add, rag_correct, rag_deprecate"
```

---

## Task 9: Wire MCP tools into agent-manager

**Files:**
- Modify: `srv/agent-manager.ts:1043` (line of `const entries = exporter.getHandlerEntries();`)

Read first: `srv/agent-manager.ts:1030-1090` to see exactly where `entries` is constructed and used, and what `handlerMap` and `listToolsHandler` expect.

- [ ] **Step 1: Import the builder at the top of the file**

Near the other local imports (around line 50-60), add:

```typescript
import { buildRagToolEntries } from './rag-mcp-tools.js';
```

- [ ] **Step 2: Use the existing shared registry**

Verify that a `CollectionRegistry` is already reachable where `exporter.getHandlerEntries()` is called. Grep for `CollectionRegistry` in `srv/agent-manager.ts` to find it:

Run: `grep -n CollectionRegistry srv/agent-manager.ts`

Use the existing singleton accessor already defined in `srv/agent-manager.ts`:

```typescript
const localEntries = buildRagToolEntries({ registry: getCollectionRegistry() });
```

Do not add a second singleton to `srv/rag-handler.ts`; the server already initializes RAG routes from `getCollectionRegistry()`.

- [ ] **Step 3: Append local tool entries**

Immediately after line 1043 (`const entries = exporter.getHandlerEntries();`), replace that line with:

```typescript
  const coreEntries = exporter.getHandlerEntries();
  const localEntries = buildRagToolEntries({ registry: getCollectionRegistry() });
  const entries = [...coreEntries, ...localEntries];
```

- [ ] **Step 4: Type-check**

Run: `npm run test:check`
Expected: no errors.

- [ ] **Step 5: Lint**

Run: `npm run lint:check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add srv/agent-manager.ts
git commit -m "feat(rag): expose rag_add/correct/deprecate as MCP tools"
```

---

## Task 10: End-to-end smoke test via REST

**Files:**
- None (manual verification).

- [ ] **Step 1: Start the server locally**

Run: `npm run start` (or `cds watch --profile development`)
Expected: server listening, RAG routes registered.

- [ ] **Step 2: Create a collection**

```bash
curl -X POST http://localhost:4004/v1/rag/collections \
  -H 'Content-Type: application/json' \
  -d '{"id":"test-corrections","displayName":"Test Corrections","scope":"user"}'
```

Expected: 201 with metadata body.

- [ ] **Step 3: Add a document**

```bash
curl -X POST http://localhost:4004/v1/rag/collections/test-corrections/documents \
  -H 'Content-Type: application/json' \
  -d '{"text":"Package ZDEMO2_BOOK_CATALOG","metadata":{"canonicalKey":"tutorial.book.package"}}'
```

Expected: 201 with `id`. Save the id as `$ID1`.

- [ ] **Step 4: Correct it**

```bash
curl -X POST http://localhost:4004/v1/rag/collections/test-corrections/documents/$ID1/correct \
  -H 'Content-Type: application/json' \
  -d '{"newText":"Package $TEST_JK01_BOOK","reason":"user asked for $TEST_ prefix"}'
```

Expected: 201 with `{predecessor, next, reason}`. Predecessor tags include `superseded`; `next` is in the same collection.

- [ ] **Step 5: Query and confirm correction wins**

```bash
curl -X POST http://localhost:4004/v1/rag/collections/test-corrections/query \
  -H 'Content-Type: application/json' \
  -d '{"text":"package for book catalog","k":10}'
```

Expected: only the corrected document returned; the predecessor is filtered out (not in results).

- [ ] **Step 5a: Confirm the same collection behaves correctly on the agent path**

Use the same collection via `X-Rag-Collections` or `rag_collections` in a chat-completions request and verify the retrieved context does not include the superseded predecessor by default.

- [ ] **Step 6: Query with includeInactive=true and confirm both appear**

```bash
curl -X POST http://localhost:4004/v1/rag/collections/test-corrections/query \
  -H 'Content-Type: application/json' \
  -d '{"text":"package for book catalog","k":10,"includeInactive":true}'
```

Expected: both predecessor (tags include `superseded`) and successor returned.

- [ ] **Step 7: Deprecate the successor**

```bash
curl -X POST http://localhost:4004/v1/rag/collections/test-corrections/documents/$ID2/deprecate \
  -H 'Content-Type: application/json' \
  -d '{"reason":"approach reverted"}'
```

Expected: 200 with `tags` including `deprecated` and `deprecatedReason`.

- [ ] **Step 8: Final query returns nothing (both inactive)**

Expected: `results: []`.

- [ ] **Step 9: Clean up**

```bash
curl -X DELETE http://localhost:4004/v1/rag/collections/test-corrections
```

- [ ] **Step 10: Commit a note**

If any adjustment was needed in earlier tasks to make the smoke test pass, commit it with `fix(rag): ...`. Otherwise no commit.

---

## Task 11: Document the new contract

**Files:**
- Modify: `CLAUDE.md` (project root)

- [ ] **Step 1: Add a new subsection under the MCP Transport / Endpoints list**

In the existing `### MCP Transport` section of `CLAUDE.md`, after the `/v1/destinations/*` bullets, add:

```markdown
- **RAG corrections**: `POST /v1/rag/collections/:id/documents/:did/deprecate` and `.../correct` — mark entries deprecated or supersede them with a corrected version. Backed by `srv/rag-correction-core.ts`. Query endpoint filters `deprecated` and `superseded` by default; pass `{"includeInactive":true}` to see all.
- **MCP tools for RAG corrections**: `rag_add`, `rag_correct`, `rag_deprecate` — exposed alongside ABAP tools to every destination. Enable via skill / role exposition filtering.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: rag correction endpoints and MCP tools in CLAUDE.md"
```

---

## Task 12: Delete the plan

Per project convention (`docs/superpowers/plans/` keeps only active plans), delete this file once all tasks above are merged.

- [ ] **Step 1: Remove the plan file**

```bash
git rm docs/superpowers/plans/2026-04-21-rag-correction-layer-foundation.md
git commit -m "chore: remove completed rag-correction-layer foundation plan"
```

Spec (`docs/superpowers/specs/rag-correction-layer.md`) stays — the remaining plans (UI, auto-verification, retrieval re-ranking) still depend on it. Delete the spec only after all four plans ship, or sooner if the spec is cancelled.

---

## Self-review notes

- **Spec coverage (foundation slice only):** §1 namespaces are represented implicitly via collection IDs + metadata. §2 indexing gates — only the default-filter part is here; auto-verification gates come in Plan 3. §3 MCP tools — three of four present (`rag_search` deferred because existing query endpoint + agent retrieval already serve that role). §4 retrieval ordering — only the default exclusion of inactive; weighted ranking deferred to Plan 4. §5 UI — deferred to Plan 2. §6 auto-verification — Plan 3. §7 session lifecycle — not in scope.
- **Placeholders:** none — every code block is concrete. Task 9 Step 2 has a conditional ("create singleton if none exists") because the recon did not conclusively locate an existing accessor; the engineer will see which branch applies on reading the file.
- **Type consistency:** `CorrectionMetadata`, `CorrectionTag`, `deprecateMetadata`, `buildCorrectionMetadata`, `filterActive` names used consistently across Tasks 1–4, 5–7, 8, 9.
