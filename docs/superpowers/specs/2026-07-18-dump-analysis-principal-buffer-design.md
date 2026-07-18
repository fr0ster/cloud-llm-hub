# Principal-Scoped Dump Analysis & Large-Artifact Buffer — Design

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
   | Home | **mcp-abap-adt (core)** | **cloud-llm-hub**, principal-scoped |

3. **Caching policy in core; storage injected from the consumer (ports & adapters).**
   The knowledge "a dump is immutable", "a class source has an ETag", "what the key is",
   "how to validate" is ABAP domain → lives in **core** (mcp-abap-adt, which this team
   develops). The **storage + principal-scoping + access isolation** is a consumer concern →
   injected into core via an `ICache` interface. Core takes an optional `cache?: ICache`; if
   provided it uses it with its own policy, if not it stays stateless as today. Core calls
   `get(key)/set(key,value)` on a **domain** key and stays oblivious to the caller; the injected
   adapter **namespaces the key by the access principal** (decision 4), so access isolation comes
   for free.

4. **Principal-scoped by security, not convenience.** Dumps are access-controlled (MCP_Analyst
   role, per-request SAP credentials, fail-closed). A dump fetched by user A must never be served
   to user B. Core is consumer-agnostic and cannot enforce this — so cloud-llm-hub owns the
   isolation. **The owner is the stable access principal, not any session.** The planner surface
   is stateless and the executor session is ephemeral (`agent-step-<UUID>`), so there is no
   durable session to key on — the owner is an opaque `principalHash` over `cds.context.user.id`
   + auth mode + the **resolved** SAP identity that gated the fetch (formal definition, and why
   raw identities never enter keys/logs, in Phase 1). (The existing `sessionCollectionId`,
   `${logicalId}__s_<hash of userId+NUL+sessionId>` in `srv/collection-ids.ts`, is for genuine
   sessions and is **not** the mechanism here — see Phase 1.) The key must also carry the
   **resolved** system scope, because one principal can address several systems/clients:
   `{ principalHash, resolvedDestination, resolvedClient, dump_id }` — `dump_id` alone can collide
   across systems (the ADT id string embeds `_<SID>_` incidentally, but the key must not rely on
   that).

5. **No section-fetch tool explosion.** Adding `get_dump_section` × N re-strains tool selection
   — the very problem v6.27.0 fought. The mechanism must not add many tools.

6. **Determinism where structure is known; semantics only for the unstructured tail.**
   Semantic top-K retrieval **does not guarantee recall** — proven by tool selection, where
   relevant tools (GetPackageContents, RuntimeListFeeds) were missed until we fixed the corpus,
   and the mechanism itself remained fragile. "With everything needed" is a recall guarantee that
   top-K cannot give. A dump's chapters are a **known, finite, named set** (canonical titles per
   the parser: `Error analysis`, `What happened?`, `Source Code Extract`, `Active Calls/Events`,
   `Chain of Exception Objects`, …). Do not *guess*
   them by embedding — **select them by rule/metadata** (`WHERE chapter IN (...)`). Recall is
   guaranteed by **structure**, not by similarity. The **semantic RAG is demoted from "the
   retrieval engine" to a best-effort supplement** for genuinely unstructured content only.

## Architecture

```
Planner (Claude Code)
   │  execute_step  ("analyse the latest dump for user X")
   ▼
cloud-llm-hub  (USER + ACCESS principal aware)
   ├─ analyze_dump tool (intent) + deterministic chapter profiles           [Phase 1]
   ├─ de-pad + split-by-chapter (lifted parseDump/MAJOR_TITLES)             [Phase 1 → moves to core in Phase 2]
   ├─ DumpBufferStore (injected iface): {principalHash,resolvedDest,resolvedClient,dump_id}→chapters [Phase 1 default = in-mem LRU; swap-in persistent later]
   ├─ semantic cache: principal-scoped RAG (unstructured tail + memoised results)     [Phase 3]
   └─ ICache adapter: principal-scoped, access-isolated storage               [Phase 2 injects into core]
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

- Consume the **existing** `RuntimeGetDumpById` (formatted view) via the embedded MCP client.
- **Reuse the existing parser**, don't reinvent: `parseDump` + the canonical `MAJOR_TITLES` set
  already live in `docs/examples/abap-dump-monitor/srv/dump-parser.ts`. **Lift it into a shared
  `srv/lib/` module** (it is not currently importable from `srv/`) and de-pad + split by its
  canonical titles. Titles are exact: `What happened?`, `Error analysis`, `Source Code Extract`,
  `Active Calls/Events`, `Chain of Exception Objects`, `Contents of system fields`, … — match
  the parser's set, **not** ad-hoc names.
- **Deterministic analysis profiles**: an `intent` → a fixed set of **canonical section ids**
  (with an alias map to the exact titles above). Initial profile `root-cause` =
  `Error analysis` + `Chain of Exception Objects` + `Source Code Extract` + `Active Calls/Events`
  (+ `What happened?`). Recall is guaranteed by construction — **no semantic step.**
- **Buffer = a non-vector raw keyed store.** NOT the RAG collection: `addDocument` embeds
  `doc.text` on upsert (`srv/rag-collections.ts` `stored.rag.upsert(doc.text, …)`), so buffering a
  95K-token dump there just moves the size problem into the embedder. Phase 1 uses a plain keyed
  store `key → parsed chapters`; immutable → no validation. (RAG enters only in Phase 3, and only
  for the unstructured tail.)
- **Key = the stable access principal + RESOLVED system scope, NOT the executor session.** The
  planner surface `/mcp/agent/stream/http` is **stateless** (`sessionIdGenerator: undefined`) and
  each `execute_step` runs under an **ephemeral** executor session `agent-step-<UUID>`
  (`srv/agent-mcp.ts`). Scoping the buffer to that session would miss on the very next
  `execute_step` from the same planner — so it **must not** be the owner.
  - **Principal is an opaque `principalHash`, never raw identities.**
    `principalHash = hash(cds.context.user.id + authMode + resolvedSapIdentity)`.
    `resolvedSapIdentity` is the SAP user the fetch **actually runs as** — for basic / on-prem it is
    `x-sap-login`; for a destination **service user** (OAuth2 client-credentials) it is that service
    user; for **principal propagation** (SAML bearer) it is the propagated SAP user — read from the
    **resolved** connection auth, not the raw header. `authMode` distinguishes the same login reached
    via a different auth path. **Raw user id / SAP login never appear in a key, file, or log** — the
    key is the hash only (consistent with the credential masking added in v6.14.2).
  - **Bias to narrow, never broad.** A missed cache-hit just re-fetches (cheap; immutable) — a
    wrong-principal hit **leaks** an access-controlled dump. So a shared SAP service user is still
    isolated by `cds.context.user.id`, and any doubt **widens the principal, never the reuse.**
  - **System scope = the resolved `{ destination, client }`** (after `resolveDestinationSapConfig`
    applies defaults), **never the raw header** — otherwise "client omitted → default" and
    "client passed = the default" produce two keys for one system.
  - Full key: `{ principalHash, resolvedDestination, resolvedClient, dump_id }`.
- **Buffer behind an injected store interface (DI) — implementation is a config choice.**
  Same ports-and-adapters principle as core's `ICache` (decision 3): `analyze_dump` and the
  profiles depend on a small `DumpBufferStore` **interface** (`get(key)`/`set(key,chapters)`/
  eviction), never on a concrete store. **Whichever implementation we configure/inject is what
  runs** — so "in-memory vs persistent" is not a hard design choice, it's the injected adapter.
  - **Default (ships in Phase 1):** an **in-memory, LRU-bounded** adapter — hard cap
    (`LLM_AGENT_DUMP_BUFFER_MAX` entries *and* a total-bytes ceiling) so a ~400 KB de-padded dump
    cannot reintroduce the OOM risk v6.24.5/6.25.0 fought; **absolute TTL** (configurable minutes)
    + LRU — there is **no stable session** to hang expiry on (stateless surface, ephemeral
    executor session), so eviction is time+size based, not session-based; **does not survive
    restart** (a dropped dump is re-fetched — immutable, so always correct); not shared across CF
    instances (re-fetch on the other instance is fine).
  - **Swappable without touching `analyze_dump`:** a persistent (DB/file) or cross-instance
    `DumpBufferStore` adapter can be injected later; the consumer code does not change.
    **This is a distinct contract from core's `ICache`** — do not conflate them:
    `DumpBufferStore` caches **sectioned chapters** (cloud-llm-hub, access-scoped by principal),
    while core's `ICache` (Phase 2) dedups the **raw artifact fetch** (core, domain-keyed). In
    Phase 2 they **compose**: core caches the raw dump + owns the sectioning, so cloud-llm-hub's
    layer becomes a **thin adapter over core's sectioned reads** (and may keep a small
    sectioned-result cache) — but the two are not one storage contract.
  - Rationale for the default staying in-memory: the buffer is a *within-principal, short-lived optimisation
    over an immutable, re-fetchable artifact* — never a source of truth — so durability buys no
    correctness, only cost; the interface keeps the door open regardless.
- **Interface = one server-side tool `analyze_dump(dump_ref, intent)`**, injected into the
  executor's embedded MCP adapter (our code — no core change, no `HandlerExporter` change). It
  carries the `intent`, which a generic result-transform cannot: the transform seam exists
  (`callToolHandler` in the embedded adapter) but is **intent-blind**, so it could only shrink
  generically, not select a profile. `externalTools` is the **client-side** channel (`body.tools`,
  executed by the caller) and is therefore not the vehicle for a server-executed tool. One
  well-outcome-framed tool ≠ the section-tool explosion decision 5 forbids.

**Outcome:** "planner delegates → gets an analysable dump" is closed **via the `analyze_dump`
tool**, with no core change and one (not N) added tools.

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
- **Memoisation** of prior conclusions (`prompt → result`) in the principal-scoped RAG (or the genuine chat session, when present).
- Generalise the immutable buffer to **version-pinned** reads.
- (Separate initiative) a **deterministic anchor layer for tool selection** — the retrospective
  lesson from v6.27.0 (B): a known, finite category shouldn't rely on top-K similarity.

## Non-goals / out of scope

- Caching aggregates (where-used, search, package-tree) — no reliable cheap validation.
- Semantic retrieval as the recall guarantee for structured content.
- Cross-**principal** (cross-user) sharing of a fetched artifact — forbidden by access control. Same principal reusing a dump across the stateless executor's ephemeral calls IS allowed — that reuse is the point.
- Returning the full 185K formatted dump to any LLM.

## Review resolutions (spec review, 2026-07-18)

- **Buffer key** must be `{ principalHash, resolvedDestination, resolvedClient, dump_id }`, not
  `dump_id` alone — the executor session is ephemeral, so the owner is the **principal** (opaque
  hash), and the system scope is the **resolved** destination/client (decision 4).
- **Phase 1 buffer is non-vector raw storage**, not the RAG collection (which embeds on upsert) —
  RAG is Phase 3, unstructured tail only (Phase 1 bullet 4).
- **Reuse `parseDump`/`MAJOR_TITLES`** (lifted into `srv/lib/`); profiles reference the parser's
  canonical titles via an alias map, not ad-hoc names (Phase 1 bullets 2-3).
- **Interface resolved to one server-side `analyze_dump` tool** — the transform seam is
  intent-blind, `externalTools` is client-side (Phase 1 bullet 5).

## Open questions (to resolve when planning Phase 1)

1. **Profiles**: the initial set beyond `root-cause` (e.g. `short-dump-source`, `auth`,
   `performance`) — start with `root-cause` only and add on demand.
2. **De-pad fidelity**: how aggressively to collapse internal box padding without losing
   alignment that carries meaning (source-line columns, hex dumps). The lifted `parseDump`
   already preserves `sourceExtract` spans — measure de-pad against its output.
3. **`dump_ref` resolution**: `analyze_dump` takes a concrete `dump_id` or a descriptor
   ("latest for user X") that it resolves via `RuntimeListFeeds` first — decide the arg shape.
