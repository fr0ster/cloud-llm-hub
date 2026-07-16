# RAP skills in RAG — design

**Status:** proposed · **Date:** 2026-07-16

## TL;DR

Our RAP rules never reach the executor, and their content is one-line stubs.

llm-agent already does almost all of the plumbing: it vectorizes skills, matches them
semantically through the same RAG query it uses for tools, and injects their content. But
**our own exposition filter silently drops every one of them** — so wiring it up naively
would ship a feature that does nothing.

Work: unblock the filter, compose a **known, deploy-time pool** of mandatory skills
(plugin + preset), and write real content sourced from the live system.

---

## Division of labour

**llm-agent is agnostic** — it knows nothing about ABAP. It offers a contract
(`ISkillManager`), a loader, vectorization, matching and injection.

**cloud-llm-hub is gnostic** — it knows the domain. So *we* decide **which skills are
mandatory**, and that pool must be **known at deploy time**, not assembled from whatever a
user happened to enable.

---

## Problem

1. **Content is empty.** The 16 files in `srv/presets/rap-skills/` are one-liners
   (1715 bytes total). `creating-draft-table.md` is literally:
   > *"Create a draft table that mirrors the persistent table with CDS alias field names
   > and the draft admin include for RAP BO creation."*

   It states *what*, never *how* — no field naming, no keys. The model gets one sentence and
   improvises the rest from general (often wrong) ABAP knowledge.

2. **No skills reach `execute_step`.** `getCollectionRegistry()` is called only from
   `server.ts` and `openai-handler.ts`; `agent-mcp.ts` never touches it. The chat path takes
   `ragCollectionIds` from the request body — the MCP planner has no body param and no UI, so
   nothing is ever selected.

3. **Default OFF.** `preset: true` → `defaultEnabled = !preset` → opt-in.

---

## How it actually works (read from the installed library and running prod)

**Correction:** the staged `DefaultPipeline` (with its `skill-select` stage) is **not** what
we run. Prod says so:

```
hasPipelineExecutor: false, hasPipelineStages: false,
stageIds: [], ragStoreKeys: [ 'tools', 'history' ]
```

We use the **hardcoded flow** — deliberately: *"Default hardcoded flow — matches PoC for
minimal token overhead."* It supports skills anyway.

**Vectorization is automatic** (`builder.js:888`):

```js
if (this._skillManager && toolsRag) {
    for (const s of skillsResult.value) {
        const text = `Skill: ${s.name}\n${s.description}`;
        await toolsRag.writer?.()?.upsertRaw(`skill:${s.name}`, text, {});
    }
}
```

**Selection + injection** (`agent.js:596`):

```js
if (this.config.skillInjectionEnabled !== false && this.deps.skillManager) {
    const ragSkillNames = /* skill:* ids among the RAG results already retrieved */;
    // fallback: dedicated query across all stores if none found
    // skillManager.listSkills() → keep matched → skill.getContent() → inject
}
```

| Fact | Consequence |
|---|---|
| The builder writes skills into **`toolsRag`**, hardcoded | **No separate store.** We do not build a corpus — `skills-corpus.ts` is unnecessary. |
| Embedded text is only **`Skill: <name>\n<description>`** | The **`description` is the semantic hook**. The body is injected after the match, never matched. Content must be written accordingly. |
| Matching happens on the normal RAG results | Semantic retrieval is **free**. No custom matcher; `matchSkills` (substring) is never called on this path. |
| `skillInjectionEnabled` defaults on; our `mode` is `smart` | Nothing to switch on; the `mode === 'hard'` "inject everything" branch does not apply. |
| `withSkillManager` beats the plugin (`builder.js:880`: `if (plugins.skillManager && !this._skillManager)`) | Setting ours **silently discards the plugin's**. Composition is mandatory, not optional. |

---

## Blocker — our own exposition filter drops every skill

The builder upserts skills with **empty metadata** (`upsertRaw(..., text, {})`). Our
`ExpositionFilteringRag` (v6.22.0 security fix) excludes anything untagged:

```js
const filtered = result.value.filter(
  (r) => !!r.metadata.exposition && allowed.has(r.metadata.exposition),
);
```

Both chat and `execute_step` always pass `ragFilter.exposition`, so the filter is always
active → **every `skill:*` entry is discarded**. Wiring `withSkillManager` without fixing
this ships a no-op.

**Fix:** let `skill:*` ids bypass the exposition filter. This does not reopen the hole the
v6.22.0 fix closed: that fix stops an **untagged tool** from becoming callable by any role.
A skill is **not callable** — it is instruction text. Tool access stays gated by exposition;
a reader-role user may read a rule about draft tables but still cannot invoke a create tool.

The bypass must be narrow: only ids matching `skill:`, nothing else.

---

## Architecture

```
plugin skills ─┐                                    (llm-agent plugin: PluginExports.skillManager)
               ├─► CompositeSkillManager (ours) ──► builder.withSkillManager(...)
preset skills ─┘                                             │
   (srv/skills/, in code)                                    ▼
                                          builder vectorizes each skill into toolsRag
                                          as  skill:<name>  =  "Skill: <name>\n<description>"
                                                              │
ExpositionFilteringRag: let skill:* through ◄─────────────────┘
                                                              │
agent.js hardcoded flow — ONE RAG query, two independent consumers:

  RAG query
    ├─► tool:*  → tools selected            (agent.js:562)   ─┐
    └─► skill:* → skillManager.getContent() (agent.js:596)   ─┤
                                                              ▼
                                            assemble → skill content appended
                                            to the system message (agent.js:707)
                                                              ▼
                                                     streaming tool loop
```

**Skills do NOT influence which tools get selected.** Tools are chosen first (`:562`), skills
after (`:596`), and the content lands post-assembly (`:707`). Both read the *same* RAG
results, but independently. (The "skills feed the tool query" wording belongs to the staged
`DefaultPipeline` — which we do not run.)

Wired at the **agent** level (`agent-manager.ts`), so chat and `execute_step` behave
identically, with no per-request `deps` hack.

### Components

| Unit | Responsibility |
|---|---|
| `srv/skills/<name>/SKILL.md` | the rules (content) |
| `srv/lib/composite-skill-manager.ts` | merge N `ISkillManager`s into one known pool |
| `srv/agent-manager.ts` | build the pool, `withSkillManager(...)`, log it at startup |
| `ExpositionFilteringRag` | allow `skill:*` through the role filter |

### The pool is deterministic

Composed at startup from the plugin loader's skills **and** the preset skills, then logged
(names + count + source) so the mandatory pool is visible and auditable in the deploy log —
not a function of what a user enabled.

**Name collisions:** preset (in-code) wins over plugin, and the collision is logged. Rationale:
the in-code set is the product's own contract; a plugin must not silently redefine a rule.

---

## Three separate things — nothing moves

```
docs/tutorials/rap-bo-book-catalog/skills/   prompt example for the tutorial
              │  presets-content-drift.test.ts asserts byte-for-byte equality
              ▼
srv/presets/rap-skills/                      shipped mirror, in PRESET_PACKS, opt-in
```

| | **Product skills** (new) | **Preset packs** (existing) |
|---|---|---|
| Location | `srv/skills/` | `srv/presets/{rap-skills,rap-context}/` |
| Nature | product invariant — the real rules, mandatory | tutorial material / user knowledge |
| Content | full rules (field naming, keys, gotchas) | one-line task hooks |
| Delivery | always, in the deploy-time pool | seeded per user, opt-in, chat only |

**The preset stubs do NOT move and are NOT edited.** An earlier draft said "move
`srv/presets/rap-skills/` → `srv/skills/`" — that was wrong: it would break `PRESET_PACKS`
(`srv/presets.ts:23`), `presets.test.ts:49`, and the drift test
(`presets-content-drift.test.ts:5`), and would drag the tutorial into an unrelated change.
`srv/skills/` is **new and additive**; no existing test changes.

---

## Content — sourced from the live system, not from memory

**Rule: never write these rules from the assistant's general ABAP knowledge.** The
`execute_step` contract itself says general knowledge of *how* SAP works is likely wrong for
a given system. A working RAP BO exists on DEV — package `TEST_RAG_APP`, 19 `ZDEMO01_*` objects
— so every rule is read from reality and reviewed by the user.

**Because only `description` is matched**, each SKILL.md needs a description that reads like
the request a user would make ("create the draft table for a RAP BO"), while the body carries
the rules.

**Worked example — the draft-table rule, derived by diffing the two real tables:**

| `ZDEMO01_TBOOK` (persistent) | `ZDEMO01_DBOOK` (draft) |
|---|---|
| `key book_uuid : sysuuid_x16` | `key bookuuid : sysuuid_x16` |
| `pub_year` | `pubyear` |
| `currency_code` | `currencycode` |
| `local_last_changed_at` | `locallastchangedat` |
| — | `"%admin" : include sych_bdl_draft_admin_inc;` |

Rule: **draft fields are named after the CDS element names** (lowercase, no underscores), not
the persistent table's DB field names. Types stay identical. Keys = `client` + the persistent
key in CDS naming. Gotcha: `@Semantics.amount.currencyCode` must point at the draft's **own**
field (`'zdemo01_dbook.currencycode'`).

### Naming policy is out of scope

Customers have their own conventions. Skills state only what the **platform** requires and say
"name per the project's policy". `ZDEMO01_`/`T`/`D`/`DOM_`/`DE_` appear only as clearly labelled
illustration, never as a rule. The prefix already arrives in the prompt; no policy mechanism is
built (YAGNI).

---

## Error handling

Skills are **not** on the critical path. Missing directory, unparsable SKILL.md, a plugin that
fails to load, or a failed embedder → log a `warn` and continue without them. A skill problem
must never fail a request.

## Testing

- composite: merges plugin + preset; preset wins a name collision; both sources listed
- the exposition filter lets `skill:*` through and still drops untagged **tools**
- injection: a semantically close prompt puts the right skill's content into context; an
  unrelated one does not (assert via the `skills_selected` session-log step)
- degradation: plugin/embedder/dir failure → no skills, no throw
- existing preset tests (`presets.test.ts`, `presets-content-drift.test.ts`) still pass untouched

## Open question for implementation

The skills are vectorized into `toolsRag`, which we load from the **precomputed bundle**
(`srv/tool-embeddings.json`, 258 entries, v6.21.0). Must confirm `planBundleLoad` treats
`skill:*` entries as expected rather than as missing/changed tools — and that the skills are
(re)vectorized once per shared store, not per destination.

## Out of scope

- `llm-agent 17 → 20` (three majors; **not needed** — all of this exists in 17.0.0)
- The server-side `res.on('close')` abort that kills in-flight work (separate item)
- A naming-policy mechanism
- Migrating `rap-context` to skills
