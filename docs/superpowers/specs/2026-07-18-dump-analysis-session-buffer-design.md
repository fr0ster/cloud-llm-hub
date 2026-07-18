# Session-Scoped Dump Analysis & Large-Artifact Buffer — Design

**Date:** 2026-07-18
**Status:** Design (approved for phasing; Phase 1 to be planned)

## Problem

An external planner (Claude Code, etc.) reaches an SAP system **only** through the
planner MCP surface `/mcp/agent/stream/http` — i.e. via `execute_step`, which routes
through the SmartAgent **executor** (an LLM). When the planner asks the executor to read
a large ABAP artifact — a full ST22 short dump — the executor cannot return it: the
**formatted dump is ~185K tokens** (95% whitespace padding; ~95K even de-padded), which,
together with the ~236 tool schemas + system prompt, exceeds the model's context window.
Result: HTTP 400 from AI Core. This is a hard **LLM context limit**, not a cap we add
(the transparent `execute_step` from v6.26.1 removes all of our own limits).

The naive fixes fail:
- **Raise the executor's output cap** → 400s on large input (v6.26.0, reverted).
- **Expose the raw tool to the planner** → only works because Claude Code happens to have
  a 1M window here; a normal 200K client breaks, and shovelling 185K of padding is waste.
- **Return the whole dump to any LLM** → if it doesn't fit, no LLM can analyse it. Dead end.

The real goal is **not caching** — it is **assembling the LLM context with exactly what a
prompt needs: complete, but minimal.** Caching is a means to that end.

## Key decisions (settled during design)

1. **Cache only what has reliable validation.** No reliable validation → not cacheable.
   - *Immutable* (dumps by id, version-pinned reads): validation trivial (never changes) → cache.
   - *Single object* (source/def): validate with an **ETag** (a light ADT round-trip) → cache.
   - *Aggregates* (where-used, search, package-tree): depend on the whole system's state, have
     no cheap reliable validator → **never cached, always fresh from ADT.**

2. **Two distinct caches, two homes.**
   | | Technical cache | Semantic cache |
   |---|---|---|
   | What | raw artifact, keyed | prior query results + extracted content |
   | Purpose | never hit ADT twice | assemble relevant context for a prompt |
   | Validation | ETag / immutable | (own layer) |
   | Home | **mcp-abap-adt (core)** | **cloud-llm-hub**, session-scoped |

3. **Caching policy in core; storage injected from the consumer (ports & adapters).**
   The knowledge "a dump is immutable", "a class source has an ETag", "what the key is",
   "how to validate" is ABAP domain → lives in **core** (mcp-abap-adt, which this team
   develops). The **storage + session-scoping + access isolation** is a consumer concern →
   injected into core via an `ICache` interface. Core takes an optional `cache?: ICache`; if
   provided it uses it with its own policy, if not it stays stateless as today. Core calls
   `get(key)/set(key,value)` on a **domain** key and stays oblivious to sessions; the injected
   adapter **namespaces the key by `user:session`**, so access isolation comes for free.

4. **Session-scoped by security, not convenience.** Dumps are access-controlled (MCP_Analyst
   role, per-request SAP credentials, fail-closed). A dump fetched under user A's session must
   never be served to user B. Core is consumer-agnostic and cannot enforce this — so the buffer
   **must** be session/user-scoped, which is exactly what cloud-llm-hub's existing session-RAG
   namespace (`userId:destination` + session-id) already provides. One dump re-embedded per
   session is required by security, not waste.

5. **No section-fetch tool explosion.** Adding `get_dump_section` × N re-strains tool selection
   — the very problem v6.27.0 fought. The mechanism must not add many tools.

6. **Determinism where structure is known; semantics only for the unstructured tail.**
   Semantic top-K retrieval **does not guarantee recall** — proven by tool selection, where
   relevant tools (GetPackageContents, RuntimeListFeeds) were missed until we fixed the corpus,
   and the mechanism itself remained fragile. "With everything needed" is a recall guarantee that
   top-K cannot give. A dump's chapters are a **known, finite, named set** (`Error analysis`,
   `What happened`, `Source Code Extract`, `Call Stack`, `System environment`, …). Do not *guess*
   them by embedding — **select them by rule/metadata** (`WHERE chapter IN (...)`). Recall is
   guaranteed by **structure**, not by similarity. The **semantic RAG is demoted from "the
   retrieval engine" to a best-effort supplement** for genuinely unstructured content only.

## Architecture

```
Planner (Claude Code)
   │  execute_step  ("analyse the latest dump for user X")
   ▼
cloud-llm-hub  (SESSION + USER + ACCESS aware)
   ├─ semantic cache: session RAG (unstructured tail + memoised results)   [Phase 3]
   ├─ deterministic analysis profiles (intent → fixed set of chapters)      [Phase 1]
   ├─ de-pad + split-by-chapter                                             [Phase 1 → moves to core in Phase 2]
   └─ ICache adapter: session-scoped, access-isolated storage               [Phase 2 injects into core]
        │  get(key)/set(key,value) on a domain key
        ▼
mcp-abap-adt  (core — CONSUMER-AGNOSTIC, stateless)
   ├─ RuntimeGetDumpById (raw ADT fetch)                                    [exists]
   ├─ caching policy: immutable / ETag / never  + optional ICache           [Phase 2]
   └─ de-pad + section param                                                [Phase 2]
        ▼
   ADT  (one heavy call per artifact; deduped by the technical cache)
```

## Phase 1 — NOW (cloud-llm-hub only; no core change, no wait)

Productise exactly the flow already proven by hand (fetch → de-pad → chapters → root cause).

- Consume the **existing** `RuntimeGetDumpById` via the embedded MCP client.
- **De-pad** the formatted view (strip the ~95% whitespace padding).
- **Split by chapter** using the chapter table the dump already carries.
- **Deterministic analysis profiles**: an `intent` → a fixed set of chapters. Initial profile
  `root-cause` = `Error analysis` + `What happened` + `Source Code Extract` + `Call Stack`.
  Recall is guaranteed by construction — **no semantic step.**
- **Session buffer** the fetched dump in our session-scoped store, key = `dump_id` (immutable →
  no validation); access isolation is inherited from the `user:session` namespace.
- **Interface without tool bloat** — one of two, decided at plan time (see Open Questions):
  - (a) a **single** tool `analyze_dump(dump | "latest for user", intent)`, or
  - (b) a **pipeline transform** that de-pads + keeps only profile chapters from a dump-tool
    result *before* it reaches the LLM context — **zero** new tools.

**Outcome:** "planner delegates → gets an analysable dump" is closed, with no core change and no
tool-selection strain.

## Phase 2 — mcp-abap-adt (core; this team)

Move what is ABAP domain / technical cache:
- **`ICache` interface + DI hook** — optional `cache` in the constructor; absent → stateless as
  today.
- **Caching policy in core**: immutable(dump/version) → cache; single object → **ETag**-validate;
  aggregates → **never**.
- **De-pad + sectioning in core** (`RuntimeGetDumpById(dump_id, section?)`). Afterwards
  cloud-llm-hub **drops** its Phase-1 local de-pad and only **injects the storage adapter**.
- ETag validation for single-object reads.

Phase 1 works without this; Phase 2 makes it "correct" and reusable.

## Phase 3 — LATER (future)

- **Semantic RAG for the unstructured tail only** (huge variable/memory sections, "where is X
  mentioned") — best-effort supplement, explicitly **not** a recall guarantee.
- **Memoisation** of prior conclusions (`prompt → result`) in the session RAG.
- Generalise the immutable buffer to **version-pinned** reads.
- (Separate initiative) a **deterministic anchor layer for tool selection** — the retrospective
  lesson from v6.27.0 (B): a known, finite category shouldn't rely on top-K similarity.

## Non-goals / out of scope

- Caching aggregates (where-used, search, package-tree) — no reliable cheap validation.
- Semantic retrieval as the recall guarantee for structured content.
- Cross-session/cross-user sharing of a fetched artifact — forbidden by access control.
- Returning the full 185K formatted dump to any LLM.

## Open questions (to resolve when planning Phase 1)

1. **Interface**: single `analyze_dump` tool vs. a pipeline result-transform (zero new tools).
   The transform keeps the tool count flat but is less explicit; the tool is explicit but adds
   one entry to the corpus. Lean: the transform if it can be scoped to dump-tool results cleanly.
2. **Profiles**: the initial set beyond `root-cause` (e.g. `short-dump-source`, `auth`,
   `performance`) — start with `root-cause` only and add on demand.
3. **De-pad fidelity**: how aggressively to collapse internal box padding without losing
   alignment that carries meaning (source-line columns, hex dumps).
