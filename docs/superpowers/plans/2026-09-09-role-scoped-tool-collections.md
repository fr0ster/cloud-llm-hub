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

**Skills are out of scope of the split itself** and are not role-governed
(v6.31.0). Mechanically today they route to the **reader** collection, because a
skill carries no `exposition`.

### Next: give skills their own collection

Decided 2026-09-10. Skills currently live in the SHARED TOOLS STORE —
`upsertRaw('skill:<name>', text, {})` in `agent-manager.ts`, and the class comment
records it: *"Skill ids already vectorized into THIS shared store"*. The agent's
`ragStores` are `['tools', 'history']`; there is no skills store.

That is why `skill-select.js` iterates **every** store looking for `skill:`-prefixed
ids — including the tool store. It is also why the two searches per request that
arrive without a role filter reach our collections at all.

Moving skills to an ordinary RAG collection of their own:

| Effect | |
|---|---|
| Skills leave the tool collections | the "entry with no exposition → reader" special case disappears with them |
| `skill-select` queries only the skills store | it stops touching tool storage |
| The `exposition: 'all'` searches | stop reaching our collections — the open `roleFilterReceived: false` question closes structurally |

So this is not an upstream issue after all: `skill-select` iterating all stores is
reasonable given skills could be anywhere. The problem is ours — we put skills in
the tool store.

#### Collections are partitioned on more than one axis

Recorded 2026-09-10, and it changes the shape of the above: **a skills collection is
not a singleton.** RAG collections here are partitioned **by user**, and
session-scoped ones **by session** on top of that. The machinery already exists for
the user knowledge collections — namespace `${userId}:${destination}`,
`getCollectionRegistry()`, `resolveRouteId()`, and the hourly
`sweepExpiredSessions()` that reaps expired session collections.

So "give skills their own collection" means giving them the same partitioning as the
other non-tool collections, not one global store beside the tool ones. That also
keeps the two axes clean and separate:

| Axis | Applies to | Isolates by |
|---|---|---|
| **role** | tool collections | what the caller may execute |
| **ownership** | skills, user knowledge | user, and session where session-scoped |

They are different questions — one is about permission, the other about whose data it
is — and the tool split deliberately does not touch the second.

#### Shared collections: a scope VALUE, not a third axis

Recorded 2026-09-10, corrected after review. There will also be **shared
collections** — content available to everyone, or to holders of some specific role
added later. That is *not* a third partitioning axis. It is two existing ones taking
particular values:

| | Values |
|---|---|
| **scope** | `global` \| `user` \| `session` |
| **authorization** | public \| role-gated |

A role-gated shared collection is simply `scope: global` plus an access policy. A
physically separate store is *how* that boundary gets enforced, not evidence of
another axis.

**And `global` has to come back before any of this.** It is not merely absent — it
was removed: `srv/rag-handler.ts` answers `400 "global collections are no longer
supported"`, and `srv/rag-collections.ts` admits only `user | session`. So the work
starts by finding out why it was dropped, not by re-adding it. Whatever the reason
was may still apply, or may be exactly the gap a role policy now fills.

Restoring it needs three things, and the third is the one worth stating: the scope
model back to `global`, an access policy (role → collection) held **beside**
`resolveExposition` rather than inside it, and **fail-closed pre-query selection** —
the collection is chosen before the search runs, never filtered out of the results
afterwards.

The "available to everyone" case is easy: `scope: global`, public, searched on every
request.

The **role-gated** case is not, and it is worth seeing why before it is built. For
tools, the retrieval filter is only the FIRST of two lines — `assertToolAllowed`
refuses the call whatever retrieval offered, which is why the leak we measured cost
wasted iterations rather than access. **A knowledge collection has no second line.**
Nothing executes; the content simply enters the prompt. Whatever gates retrieval IS
the control.

So a role-gated shared collection cannot be a post-filter over a shared store, the
way tool filtering began. It has to be a separate collection queried only when the
role grants it — the shape this plan already builds for tools, for a reason that
applies even more strongly here.

This also extends the role axis beyond tools: `resolveExposition` answers only in
tool-group levels (`readonly`, `high`, …) today. A role that grants a knowledge
collection is a different kind of answer — decide whether it belongs in that function
or beside it, rather than overloading the exposition groups with something that is
not a tool group.

**Where the work is:** route skill upserts into a skills collection resolved through
the existing per-user/per-session registry rather than the shared tools store, add it
to the agent's `ragStores` where they are assembled (`buildAgentForDestination`), and
drop the skill-id special cases from `ExpositionFilteringRag` (the
`vectorizedSkillIds` dedup guard moves with them).

Note the dedup guard exists because the builder re-vectorizes skills on every
`build()`, once per destination against the same shared store. Per-user collections
multiply that: check what the guard has to become before assuming it just moves.

**Verify:** `ragStoreKeys` in the pipeline diagnostic shows `skills`; a request logs
no `tool-rag` search without a role filter; skills still reach the executor (the
RAP prompts that depend on them still work).

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
