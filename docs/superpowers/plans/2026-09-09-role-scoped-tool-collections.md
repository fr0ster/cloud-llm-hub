# Plan — role-scoped tool collections (2026-09-09)

## TL;DR

Split the tool corpus into two RAG collections along the **role boundary**, and search
them separately. A tool a role cannot run is then not in the collection that role
searches — so it cannot reach the model's context at all, and "the filter did not get
the role" stops being a possible failure.

## Why, given the filter already exists

`v6.31.0` made the filter fail closed: no role → Reader level. That closes the hole,
but by defaulting rather than by construction — the write tools are still *in* the
collection being searched, and a post-filter is what keeps them out.

Measured on staging before the fix: of three searches on one request, two ran with
`exposition: 'all'` and returned all 56 tools, `CreateDomain` among them, to a caller
holding only `MCP_Reader`. `roleFilterReceived: false` in the debug log still marks
those steps — the source was never found.

Split collections make that class of bug impossible instead of defaulted away.

## The split is by ROLE, not by semantics

Do **not** route by "does it modify". `high` is not a synonym for modifiable — of its
156 tools roughly 70 are reads (`GetPackage`, `GetDomain`, `GetTable`, `GetDdl`, …).
Deriving a second opinion about what modifies is how the boundary drifts from the one
actually enforced.

The boundary is what `resolveExposition` already computes:

| Collection | Contents | Count |
|---|---|---|
| **reader** | `readonly` + `search` + `system` | 64 |
| **developer** | `high` + `compact` | 183 |

`low` is placed in the **writer** collection. No role grants that level, so it is
unreachable either way — but giving it a home keeps `collectionFor()` total, rather
than leaving a group that maps to nothing.

## The bundle needs no regeneration

`srv/tool-embeddings.json` carries `exposition` on **every one of its 237 entries**:

```
readonly 34 · system 31 · search 4 · high 168
```

So the loader routes each precomputed entry into its collection from data already in
the file. This matters: regenerating the bundle would need live AI Core credentials,
and a mis-load silently costs the 90-second cold start back (the fingerprint check
fails, everything re-vectorizes at runtime, nothing errors — it just goes slow).

**Verify explicitly** that a cold start still loads from the bundle after the split.

## Search

Two **separate** searches, each with its own K — the budget is not divided:

```
step 1: search(reader collection, k)        always
step 2: search(developer collection, k)     only if the role grants that level
        merge, rank
```

A Developer therefore sees more tools than a Reader, which is the intent.

Generalise on the role's granted levels rather than hardcoding two, so a third
collection later needs no restructuring.

**Skills are out of scope** and are not role-governed (v6.31.0). Note what that
means mechanically here: a skill carries no `exposition`, so it routes to the
**reader** collection — which is the collection searched on every request, so
skills keep reaching every caller exactly as before.

## Where the work is

| File | Change |
|---|---|
| `srv/agent-manager.ts` — `createToolsRagStore` | build two backends instead of one |
| `srv/agent-manager.ts` — `ensureSharedToolsVectorized` | route bundle load + runtime vectorization by `exposition` |
| `srv/agent-manager.ts` — `ExpositionFilteringRag` | hold the collections; `query()` runs one search per granted level |
| writer path | `upsertRaw` / `upsertPrecomputedRaw` route by `metadata.exposition` |

The class implements `IRag, IRagEditor`: `upsert`, `deleteById`, `getById`, `writer()`,
`query()`, `healthCheck()`. All must keep working across two backends.

## Keep the post-filter

Belt and braces. It costs nothing once the collections are split, and it still catches
an untagged tool that somehow entered the wrong collection.

## Verification

1. Unit: a reader-level query never returns a `high`/`compact` id, with the write
   collection populated — otherwise the test passes vacuously.
2. Cold start on staging loads from the bundle (log line `Shared tool corpus ready
   (bundle)`), **not** a runtime vectorization.
3. Live on staging with the reader-only service key: ask for a create and confirm the
   model reports no such tool, then read back that nothing was created.

## Traps already paid for

- `npm install --package-lock-only` against an existing lock reports "up to date" and
  re-resolves nothing.
- `npm update` undoes what `overrides` resolved; a clean regeneration applies them.
- `--package-lock-only` writes a lockfile for the current platform only, so `npm ci`
  rejects it as out of sync. Use a full `npm install`.
- A failed MTA deploy stays an active operation and blocks the next one until
  `cf deploy -i <id> -a abort`.
