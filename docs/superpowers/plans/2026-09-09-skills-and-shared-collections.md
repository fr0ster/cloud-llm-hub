# Plan — skills and shared RAG collections (2026-09-09)

## TL;DR

The **tool** side of this is done and shipped in v6.32.0 — two collections split by
the role boundary, searched separately. What remains is the other axis: where skills
live, and the shared collections that are coming.

## The collection model, as stated by the owner (2026-09-10)

Four kinds, distinguished by **who fills them and when** — not by storage:

| Kind | Filled | Purpose | Access |
|---|---|---|---|
| **skills** | optionally at startup, pre-configured | **configuration** for enriching every request's context — the consumer's prompt | everyone |
| **user** | at runtime, by the consumer through a dedicated tool, or by the LLM asked to save something | that user's own material | its owner |
| **session** | same, but scoped to the session | same, shorter-lived | its owner, that session |
| **global** | **not at startup** — they simply exist in the vector DB | shared knowledge | **requires a role**, which does not exist yet |

Two things follow that are easy to miss:

- **Skills are configuration, not knowledge.** They shape how the prompt is built on
  every request. That is why they are not role-governed (v6.31.0) and why they are
  filled from disk at startup rather than written to at runtime.
- **Global collections are not created by us.** They are already in the vector DB;
  our side is only the access decision. So the work is a role → collection policy and
  fail-closed pre-query selection, not ingestion.

**Prerequisite, stated plainly:** without a vectorizing text model the agent cannot
work at all. Any store arrangement assumes an embedder is present.

> Note for whoever implements this: that last point sits awkwardly against the code,
> which has a no-embedder path (`createToolsRagStore` returns in-memory stores when
> `getOrCreateEmbedder` yields nothing), and against a review comment claiming
> in-memory is the default RAG type for native Anthropic/DeepSeek. Settle which is
> true before building on either — the answer changes whether that branch needs the
> same collection treatment or should fail loudly instead.

## Context: what already shipped

Tool collections are split by role (`collectionFor()` in `srv/agent-manager.ts`),
each searched separately with its own K, and the embedding bundle routes into them
from the `exposition` its entries already carry. Verified on all three environments —
`Shared tool corpus ready (bundle) { loaded: 225, supplemented: 0 }`.

That closed the retrieval half of the role model. The rest is below.

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

**First unknown to settle — it decides the size of this.** We do not upsert skills;
the **llm-agent builder** does, on every `build()`, into whichever store it is given.
`ragStores` appears once in `agent-manager.ts`, and only to read its keys. So moving
skills is not "redirect our upsert" — it is "hand the builder a different store", and
whether its API accepts one is unverified. Check that before estimating anything else
here.

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
