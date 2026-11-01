# Source trust and provenance (minimum)

Status: approved, 2026-11-01. Roadmap step 3 (context classes and trust), the minimum needed for agents with
long-term memory and learning (step 4).

## Why

Contradictory facts and instructions reach the model from several places in one context: the target SAP
system, documentation, RAG collections, session history and planner memory. Today none of these items says
where it came from or how far it can be trusted. The model then either picks one at random (first or last
item), refuses to choose, or spends tokens discussing the conflict. Agents with long-term memory make this
worse: what an agent once remembered can be stale or wrong, and it must not silently beat a fresh read from
the system.

An experiment on SAP AI Core (2026-11-01) put two contradictory neutral statements into one context, each
tagged only `[source A; trust 5]` / `[source B; trust 3.5]`, with scores and order swapped. Claude 4.5/4.6,
gpt-5, gpt-5-mini, gemini-2.5-pro and gemini-2.5-flash followed the higher score in practically every run,
even at 5 vs 4.5, without any explanation of the scale. gpt-4o and gpt-4.1-mini slipped at close gaps;
gpt-4.1-mini followed item order unless the prompt explained the scale. Without tags, models picked the first
or last item or refused. Tagged runs were not slower (often faster). Conclusion: a numeric trust tag next to
each context item is an effective, cheap way to make conflict resolution predictable.

## Goals

1. Every informational collection and every informational record has a trust score. It is mandatory: there is
   always an effective value.
2. Every informational item that reaches an LLM carries its source class and effective trust in a short tag.
3. An administrator (`MCP_Admin`) can set trust on global informational collections and their records.
4. The agent preset (system prompt, base skills, corrections) has the highest trust and is never compared by
   trust.
5. Prompts tell the model how to use the tags: prefer higher trust on conflict and say which source it relied
   on.

## Non-goals (deferred, see `docs/rfcs/BACKLOG.md` → Trust and provenance)

- Global trust evaluators, choosing an evaluator per user, conflict resolution and voting between evaluators.
- Role-based access restrictions on global sources and creating new global collections (global sources stay
  the preconfigured ones).
- Session trust sets and promotion of session scores at the end of a session.
- Users setting their own trust on user collections and overriding global scores. User collections get the
  class default. (The user may decide later that this belongs in scope; nothing in this design blocks it.)
- Coordinator proposals to change trust.
- The learning process itself (short-term → long-term memory) and the memory collections it will write; this
  design only defines their trust classes so step 4 can use them.

## Anti-goals

- A trust number that only some LLM paths show. A path that renders source content without the tag is a bug.
- Trust as an access-control mechanism. Trust never hides or blocks content; access stays with scopes/roles.
- Heuristic or score-threshold filtering by trust (consistent with the tool gate principle: the model decides).

## Content model

Records in collections fall into these groups (user's model, 2026-11-01):

1. **System:** the system prompt and base skills.
2. **Corrections of the system prompt:** additional notes under learning, long-term and short-term. They override
   the system prompt and base skills. The learning process (step 4) decides whether a correction helps or harms
   and then folds it into the base system prompt and skills.
3. **MCP tool groups:** collections listing MCP tools — ABAP read-only, ABAP read-write, RAG tools, documentation
   tools, and so on.
4. **Informational skills and collections:** any other information.

An **agent** is a preset of system collections (system prompt, base skills, corrections). There is a
preconfigured variant of the system prompt and base skills, and an agent variant; the selected agent overrides
the preconfigured settings.

Independently, every collection has a visibility **scope**: global (preconfigured, visible to everyone; access
may later be restricted by role), user (the user and the admin, persistent) and session (the same, temporary).

Loading: the system prompt, base skills and corrections are loaded into the context directly, without semantic
search. Everything else — tool groups, informational skills and collections — is found by semantic search in
RAG. Tool results (target system, documentation) arrive through tool calls.

## Trust

- **Agent preset** (groups 1 and 2): highest trust. Its layers resolve by override order (agent over
  preconfigured, correction over base), never by trust, and are not tagged.
- **MCP tool groups** (group 3): affect only tool selection; not tagged.
- **Informational records** (group 4) and **tool results**: trust applies here. This is where conflicting
  items meet in one context and the model must resolve them.

Trust is a number from 0 to 5 with at most one decimal (0 = unreliable, 5 = fully reliable).

| Class | Applies to | Default | Who changes it |
|---|---|---|---|
| `global` | global informational collections and records (preconfigured informational skills) | deploy config | `MCP_Admin` per collection / record |
| `user` | user-scope informational collections and records (incl. presets) | deploy config | — (deferred) |
| `session` | session-scope informational collections, session history recall, planner memory | deploy config | — |
| `system` | results of target-system tools (embedded mcp-abap-adt) | deploy config | deploy config |
| `docs` | results of documentation MCP servers (external MCP per role, separate spec) | deploy config | deploy config |

Deploy config: one variable `LLM_AGENT_TRUST_DEFAULTS`, comma list `class=value`, e.g.
`global=4.5,system=4.5,docs=3.5,user=3,session=2`. Missing classes take these built-in defaults (the example
values). Invalid values fail startup with a clear error.

Class resolution (my calls):

- Short-term corrections live in session scope and long-term corrections in user scope (confirmed); both are
  part of the agent preset, so scope does not change their trust.
- Presets are user-scope copies of informational collections; they are class `user`.
- `system` is exactly the embedded mcp-abap-adt tool set, identified by its registry origin. RAG tools and
  hub-internal (orchestration, planning) tools are not tagged.

Effective trust of a record = record trust if set, else its collection's trust, else the class default of the
collection's scope. Effective trust of a tool result = the class default of the tool's class (`system`, `docs`).

## How it reaches the model

One tag format everywhere, placed directly before the item text:

`[source: <class>:<name>; trust <n>]`

where `<name>` is the collection display name and record id for RAG items, the tool name for tool results,
and is omitted where there is nothing useful (`[source: session; trust 2]`). Brackets inside names are
escaped the same way planner blocks already escape them.

Paths that must carry the tag (from the code survey):

1. `rag_search` hits: add `source` and `trust` fields to each hit (JSON), next to `collection`.
2. `rag_read`, `collection_records`: add `trust` and `source` to `attributes` (`recordAttributes()`).
3. Chat auto-retrieval (`collection-retrieval.ts`, appended after `RAG_CONTEXT_MARKER`): each hit gets the tag
   instead of the bare `\n---\n` join.
4. Library pipeline RAG stores (`ContextAssembler` sections) and session history ("Relevant History"): each
   rendered item gets the tag.
5. Planner/coordinator blocks (`[planning knowledge]`, `[session memory]`, `search_knowledge`): the item header
   `(<collection>/<record>)` gains `; trust <n>`.
6. Target-system tool results (embedded mcp-abap-adt): the tool result text gets a first line with the tag.
   The tag is added at the LLM boundary only (my call): recording, result parsing (reviewer/checker) and the
   truncation count see the untagged result.
7. Informational skills found by semantic selection (`## Active Skills` block): each skill gets the tag after its
   `### Skill: <name>` header. Base skills are part of the agent preset and are not tagged.
8. Dependency results passed to workers and checkers (`[result of step …]`): carry no tag of their own; the
   worker output keeps whatever tags the worker quoted. (My call: tagging derived results would need trust
   propagation rules, which belong to step 4.)

The agent preset is not tagged; the prompt rule states that the agent's own instructions outrank everything in
context.

Prompt rule, added once to the coordinator, planner-create, planner-revise and the worker base profile:

"Context items may carry `[source: …; trust 0–5]`. Your own instructions outrank them. When items conflict,
prefer the higher trust, say briefly which source you relied on, and when trust is equal, say that the sources
conflict instead of choosing silently."

## Persistence

- Collections: new catalog attribute `trust` (number, optional in storage). Add it to `encodeAttributes`,
  `decodeRecord` (whitelist) and `canonicalCollectionMeta`, and to `CollectionMeta`. A stored collection without
  `trust` reads as unset → class default. No data migration is needed.
- Records: payload metadata key `trust` (number, optional), reserved like the other bookkeeping keys so users
  cannot spoof it through free-form metadata on add/update.
- Global informational sources: effective trust comes from the trust store, else the `global` class default.
- Validation in one helper used by every write path: 0 ≤ n ≤ 5, one decimal; else 400 / tool error
  `INVALID_TRUST`.

## Changing trust

Only `MCP_Admin`, only on global informational sources and their records. Today these are the preconfigured
informational skills (file skills); a skill is addressed by its name as the record. File skills are not catalog
collections, so global trust is stored by the hub in a small persistent trust store keyed by source and record
(my call). Today's code does not separate base skills from informational skills; the builder adds that marker
(skill front matter) so base skills join the agent preset and are excluded from trust.

- REST: `PUT /v1/rag/collections/:id` accepts `trust`; new `PATCH /v1/rag/collections/:id/documents/:did/trust`
  `{ trust: number | null }` (null clears the record override).
- MCP (same tools on every connection): `collection_set_trust({ collection, trust })` and
  `record_set_trust({ collection, record, trust | null })`, write-effect, admin-gated by the existing
  `collectionAccessError` guard; non-admin → 403 / `FORBIDDEN`, non-global source → `TRUST_FIXED`
  (class default applies).
- Every change records previous value, new value, actor and time in a trust history attribute on the
  collection / record (last 20 entries).
- Cache: a trust write invalidates only that record/collection (cache-only-in-DB-provider rule).

## WebUI

MANAGE panel: each collection row shows its effective trust and class. Admins see the global informational sources
(informational skills) with an inline-editable trust. Document rows show a record override when set. Verified via Playwright through the
approuter.

## Library (llm-agent) part

- Planner retrieval items and the `ContextAssembler` item rendering accept an optional `trust` and `source`
  and render the tag. No behaviour change when absent.
- Released before the hub part (version PR → signed tags → npm by the user).

## Acceptance

- Unit tests per tagged path (1–6) asserting the exact tag text, including escaping and the default fallback.
- Persistence round-trip for collection and record trust on PGlite; stored collection without trust reads the
  class default.
- Admin/non-admin/non-global tests for both REST and MCP setters; spoofed `trust` in free-form record metadata
  is rejected or stripped.
- `LLM_AGENT_TRUST_DEFAULTS` parsing tests (valid, partial, invalid).
- POC check: a user-collection record that contradicts a target-system read produces an answer that follows the
  system (higher trust) and names the source; after the admin lowers a preconfigured informational skill's trust,
  a conflicting user record with higher trust wins.

## Left to the builder

File layout, helper names, exact JSON field order, UI styling, trust history storage shape, test structure.
