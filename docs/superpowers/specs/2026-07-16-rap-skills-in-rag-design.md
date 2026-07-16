# RAP skills in RAG — design

**Status:** proposed · **Date:** 2026-07-16

## TL;DR

Our RAP skills exist in the repo but **never reach the executor**, and their content is
one-line stubs carrying no usable rules.

The good news, established by reading the *installed* library and the *running* prod app:
llm-agent already injects skills, and it selects them **through the same RAG results it
uses for tools** — exactly where we wanted them. So the work is almost entirely **content**,
plus a small amount of wiring. No custom matcher. No llm-agent 17→20 migration.

---

## Problem

Three gaps, all verified:

1. **Content is empty.** All 16 files in `srv/presets/rap-skills/` are one-liners
   (1715 bytes total). `creating-draft-table.md` is literally:
   > *"Create a draft table that mirrors the persistent table with CDS alias field names
   > and the draft admin include for RAP BO creation."*

   It states *what*, never *how* — no field naming, no keys. The model gets one sentence
   and improvises the rest from general (often wrong) ABAP knowledge.

2. **No skills reach `execute_step`.** `getCollectionRegistry()` is called only from
   `server.ts` and `openai-handler.ts`. `agent-mcp.ts` never touches it. The chat path
   takes `ragCollectionIds` from the request body and swaps `deps.ragStores` per request;
   the MCP planner has no body param and no UI, so nothing is ever selected.

3. **Default OFF.** `preset: true` → `defaultEnabled = !preset` → opt-in. Even seeded,
   they stay off.

---

## How skill injection actually works (verified, not assumed)

**Correction to an earlier assumption:** the staged `DefaultPipeline` (which has a
`skill-select` stage) is **not** what we run. Prod diagnostics say so plainly:

```
hasPipelineExecutor: false, hasPipelineStages: false,
stageIds: [], ragStoreKeys: [ 'tools', 'history' ]
```

We use the **hardcoded flow** (`llm-agent-libs/dist/agent.js`) — deliberately, per our own
comment: *"Default hardcoded flow — matches PoC for minimal token overhead."*

That flow supports skills anyway:

```js
if (this.config.skillInjectionEnabled !== false && this.deps.skillManager) {
    // 1. find skill:* ids among the RAG results ALREADY retrieved (same ones as tools)
    const ragSkillNames = new Set(allRagResults
        .map(r => r.metadata.id)
        .filter(id => id?.startsWith('skill:'))
        .map(id => id.slice(6)));

    // 2. fallback: if none found, run a dedicated RAG query across ALL deps.ragStores
    // 3. skillManager.listSkills() → keep the ones whose name matched
    // 4. skill.getContent() → "### Skill: <name>\n<content>" → injected as context
}
```

**Consequences for the design:**

| Fact | Consequence |
|---|---|
| Skills are matched **via RAG results**, keyed by an id prefix `skill:` | Semantic retrieval is **free** — RAG is already semantic. No custom matcher. |
| `skillManager` is only used for `listSkills()` + `getContent()` | It is a **content source**, not a search engine. `matchSkills` (substring) is never called here. |
| `skillInjectionEnabled` defaults to enabled | Nothing to turn on. |
| Our `mode` is `smart` (default) | The `mode === 'hard'` branch (inject *all* skills) does not apply — RAG matching is the path. |

**The contract we must satisfy:** each skill needs a RAG document whose
`metadata.id` is `skill:<name>`, where `<name>` equals the skill's `name` from SKILL.md.

---

## Architecture

```
srv/skills/<name>/SKILL.md         content (Agent Skills standard)
        │
        ├──► FileSystemSkillManager(['srv/skills'])  → builder.withSkillManager(...)
        │        provides listSkills() / getContent()
        │
        └──► RAG docs, id = "skill:<name>"           → a rag store in deps.ragStores
                 provides the semantic match

agent.js hardcoded flow:
  RAG query → results contain tools AND skill:* → skills' content injected → tool selection
```

Wiring happens at the **agent** level (`agent-manager.ts`), not per handler — so chat and
`execute_step` behave identically, with no per-request `deps` hack.

### Components

| Unit | Responsibility |
|---|---|
| `srv/skills/*/SKILL.md` | the rules (content) |
| `srv/skills-corpus.ts` | build RAG docs from the skills, ids `skill:<name>` |
| `srv/agent-manager.ts` | `withSkillManager(...)` + register the skills store |

### Decision — the skill docs get their OWN store

A separate store registered in `deps.ragStores`. Settled by reading `agent.js:502`:

```js
const storeEntries = Object.entries(this.deps.ragStores);   // ALL stores
const originalEmbedding = mkEmbed(combinedActionText);      // embedding is cached
const ragQueryResults = await Promise.all(storeEntries.map(([name, store]) => ...));
```

The **initial** query already fans out over **every** store, **each with its own K**, reusing
one cached embedding. So a separate skills store:

- costs **no extra query** — it rides in the same `Promise.all`
- costs **no extra embed** — the embedding is cached across stores
- takes **no `ragQueryK` slots from tools** — K is per store, not shared
- never reaches the fallback at `agent.js:603` (that fires only when the initial results
  contain no `skill:*` at all)

Putting skills into the shared `tools` store was considered and rejected: it buys nothing and
makes skills compete with tools for the same K (prod K=15).

---

## Three separate things — nothing moves

There is an existing structure that must be left intact:

```
docs/tutorials/rap-bo-book-catalog/skills/   source of truth (16 one-liners + README)
              │  presets-content-drift.test.ts asserts byte-for-byte equality
              ▼
srv/presets/rap-skills/                      shipped mirror, declared in PRESET_PACKS
                                             seeded per-user, preset:true → opt-in
```

| | **Product skills** (new) | **Preset packs** (existing) |
|---|---|---|
| Location | `srv/skills/` | `srv/presets/{rap-skills,rap-context}/` |
| Source of truth | itself | `docs/tutorials/rap-bo-book-catalog/{skills,context}/` |
| Nature | product invariant — the real rules | tutorial material / user knowledge |
| Content | full rules (field naming, keys, gotchas) | one-line task hooks |
| Delivery | always, via `deps.ragStores` + skill manager | seeded per user, opt-in, chat only |
| Versioned | in git with the code | in git, mirrored by a drift test |

**The 16 preset stubs do NOT move and are NOT edited.** An earlier draft of this spec said
"move `srv/presets/rap-skills/` → `srv/skills/`"; that was wrong. It would have broken
`PRESET_PACKS` (`srv/presets.ts:23`), `presets.test.ts:49`, and the drift test
(`presets-content-drift.test.ts:5`), and it would have dragged the tutorial into a change
that has nothing to do with it.

`srv/skills/` is **new and additive**. The two sets overlap in subject but not in purpose:
the preset ones are tutorial hooks; the product ones are the rules the executor must follow.
No existing test changes.

---

## Content — sourced from the live system, not from memory

**Rule: never write these rules from the assistant's general ABAP knowledge.** The
`execute_step` contract itself says general knowledge of *how* SAP works is likely wrong for
a given system. A working RAP BO already exists on DEV — package `TEST_RAG_APP`, 19
`ZDEMO01_*` objects — so every rule is read from reality and reviewed by the user.

**Worked example — the draft-table rule, derived by diffing the two real tables:**

| `ZDEMO01_TBOOK` (persistent) | `ZDEMO01_DBOOK` (draft) |
|---|---|
| `key book_uuid : sysuuid_x16` | `key bookuuid : sysuuid_x16` |
| `pub_year` | `pubyear` |
| `currency_code` | `currencycode` |
| `local_last_changed_at` | `locallastchangedat` |
| — | `"%admin" : include sych_bdl_draft_admin_inc;` |

Rule: **draft fields are named after the CDS element names** (lowercase, no underscores),
not the persistent table's DB field names. Types stay identical. Keys = `client` + the
persistent key in CDS naming. Gotcha: `@Semantics.amount.currencyCode` must point at the
draft's **own** field (`'zdemo01_dbook.currencycode'`).

### Naming policy is out of scope

Customers have their own conventions. Skills state only what the **platform** requires and
say "name per the project's policy". `ZDEMO01_`/`T`/`D`/`DOM_`/`DE_` appear only as clearly
labelled illustration, never as a rule. The prefix already arrives in the prompt; no policy
mechanism is built (YAGNI).

---

## Error handling

Skills are **not** on the critical path. Missing directory, unparsable SKILL.md, or a failed
embedder → log a `warn` and continue with no skills (today's behaviour). A skill problem must
never fail a request.

## Embeddings

16 skills embedded at startup on the shared embedder (~1 s). **Not** added to the build-time
bundle: that holds 258 tools at 3.7 MB, and this is negligible next to it. Revisit if the
corpus grows.

## Testing

- corpus: ids are exactly `skill:<name>` and match the SKILL.md `name`
- the skills store is registered in `deps.ragStores` (so the initial fan-out query hits it)
- existing preset tests (`presets.test.ts`, `presets-content-drift.test.ts`) still pass untouched
- injection: a semantically close prompt puts the right skill's content into context;
  an unrelated prompt does not (assert via the `skills_selected` session-log step)
- tool selection is unaffected: `skill:*` lives in its own store and is never offered as a tool
- degradation: embedder/dir failure → no skills, no throw
- wiring: the built agent exposes a skill manager

## Out of scope

- `llm-agent 17 → 20` (three majors; **not needed** — all of this exists in 17.0.0)
- The server-side `res.on('close')` abort that kills in-flight work (separate open item)
- A naming-policy mechanism
- Migrating `rap-context` to skills
