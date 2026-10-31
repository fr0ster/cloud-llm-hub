# Agent profiles - host design

Superseded: internal RAG exclusions and legacy tool-name decisions are replaced by [the implemented unified RAG design](2026-10-31-unified-rag-tools-design.md).

Status: draft (design only, no code)
Date: 2026-10-30

<!-- docs-check:proposed-env: LLM_AGENT_PROFILES_COLLECTION, LLM_AGENT_PLANNER_RECORD, LLM_AGENT_PROFILE_TIMEOUT_MS are proposed here -->

## Intent

Implement `IAgentProfileSource` and `IAgentProfileRunner` from llm-agent 30.22.0
in the hub. Profiles, worker base text and planner text are RAG data. An edit
applies on the next planner call or task start, including tasks already queued;
a running task keeps its immutable snapshot. No prompt catalogue belongs in the
library. The library design and public `interfaces/agent-profile.ts` are the
contract; dialogue resolution is already implemented in llm-agent-libs.

Goals: discover functions by description, resolve exact names, build isolated
workers and enforce host tool ceilings regardless of prompt text. Keep current
destination binding, credentials, admission, usage and dialogue recovery.

Non-goals: code in this change, a profile editor, a new planning-variant knowledge
collection, semantic profile selection, new SAP privileges, or changes to library
verification rules. This supersedes the planner-variant direction in
`2026-10-24-planner-prompt-design.md`: planner variants are records in `agents`.
Existing semantic skill retrieval remains separate.

## Records and seeds

Create one hub-owned global collection through `CollectionRegistry` in
`srv/rag-collections.ts`: logical and physical id `agents`, configurable together.
It is not a preset (enabled by default), has no user/session owner or expiry, and
uses the configured persistent RAG backend, or memory when that backend is memory.
Mark collection metadata with `collectionKind: agents` (distinct from
`knowledge` and from record `kind`); preserve it through persistence and APIs.
Agents collections are configuration, excluded from knowledge/context retrieval.
Users create user-owned copies of the configured global collection and select
one for a session. Each session uses exactly one agents collection: full
replacement, no per-name overlay or fallback. Later global edits never flow into
a copy. Resolve exact collection identities, never same-named shadows.
Validate the configured id with `srv/collection-ids.ts`; reject invalid input
rather than silently normalizing it into a different configured name.

Use one unchunked `RagDocument` per record; do not upload through a chunking path.
`text` is the prompt body. Store these typed attributes in `metadata`:

| Field | Rule |
| --- | --- |
| `canonicalKey` | Exact stable name; equals document id. |
| `kind` | `profile`, `worker-base`, or `planner`. |
| `name` | Exact case-sensitive name, equal to id and canonical key. |
| `enabled` | Existing boolean flag; omitted legacy value means true. |
| `description` | Required string for profiles, used in discovery. |
| `tools` | Profiles only: `all`, `read-only`, or `{ allow?: string[], deny?: string[] }`. |
| `result` | Profiles only: `report` or `verdict`. |

Profile names use `[A-Za-z0-9][A-Za-z0-9_-]*`; no trimming, folding or aliases on
lookup. Reserve `_worker-base` for kind `worker-base`, and `planner` plus
`planner-<variant>` for kind `planner`; these are never listed as workers.
`_worker-base` is the only base record; the selected planner defaults to `planner`.
No profile ceiling or privilege field is accepted from data.

Seeds live next to `srv/skills`, in `srv/agent-profiles/*.md`, shipped in the
service build. Filename stem equals name. UTF-8 Markdown has strict YAML
frontmatter followed by the prompt body, for example:

```markdown
---
kind: profile
name: analyst
description: Reads evidence and returns an analysis report.
enabled: true
tools: read-only
result: report
---
Read the available evidence and report findings and remaining uncertainties.
```

Base/planner files contain only `kind`, `name`, optional `enabled`, and body.
The storage adapter generates `canonicalKey`; it is not an editable frontmatter
field. Preserve body text, including an explicitly empty string. Validate all
files before any seed writes: strict keys and types, matching filename/name/kind,
reserved names, result variants, tool policy shape and string arrays; reject YAML
duplicate keys and duplicate names across files. Errors name the file and field
without dumping prompt bodies. Invalid seeds fail startup even if a stored record
would otherwise take precedence.

Seeding applies only to the global collection, never user copies.

Startup in proposed `srv/lib/agent-profile-seeds.ts`:

1. Parse and validate the whole seed set; require the three starter profiles,
   `_worker-base`, and the configured planner record among seeds or stored records.
2. Await registry/backend restoration; ensure the exact global collection exists
   with the expected global scope and agents kind. A conflicting collection
   identity is a startup error.
3. At startup list existing ids of the global agents collection and upsert only
   absent seed records. Memory starts empty and receives all seeds.
4. Existing records are never overwritten from disk on purpose, including edited
   or disabled records. A rare race may rewrite a record with its valid seed
   content, which is acceptable. Never write half a record: each record is one
   upsert, whose atomicity is the DB provider's responsibility. Backend failure
   fails startup; partial seeding is safe to retry by listing ids again.
5. Validate existing configuration records and selected prompt presence before
   readiness; malformed records fail clearly, without repair. Disabled records
   stay disabled and are handled by the source policy at runtime.

Canonical ids are unique across all kinds. REST creates return conflict for an
existing id; updates replace that record explicitly. Legacy/imported duplicate
canonical keys or mismatched ids are invalid configuration, never latest-wins.
No seed fallback is used after startup. Deleting a seeded record leaves it absent
until restart, when absence permits seeding again; disable it for lasting removal.

Starter records:

| Name | Tools / result | Seed content |
| --- | --- | --- |
| `analyst` | `read-only` / `report` | Evidence gathering, analysis and a report; no writes. |
| `executor` | `all` / `report` | Current executor description and operational instructions. |
| `checker` | `read-only` / `verdict` | Current checker description, independent readback and JSON verdict instructions. |
| `_worker-base` | Not a worker | Common tool-use, impossibility and language guidance from `configureDestinationAgentBuilder`. |
| `planner` | Not a worker | Full host-owned planner instructions adapted for profile names and result kinds. |

Move `EXECUTOR_DESCRIPTION` and `CHECKER_DESCRIPTION` from `destinationWorkers()`
in `srv/agent-manager.ts` to seed descriptions. Move `HUB_DIALOGUE_STORAGE_RULES`
and the "fails twice" instruction into `executor` only: neither the shared base,
analyst, checker nor planner receives these rules as a shared append. Keep planner
briefing and verification guidance in its own seed, without copying that storage
rule block. Checker-specific verification text currently prepended to its task
moves into its profile body. No hard-coded prompt append restores moved rules.

## Fresh profile source

Proposed `srv/lib/agent-profile-source.ts` implements `IAgentProfileSource` with
typed record schemas. Bind user/session identity when wiring the source in
`srv/lib/dialogue-sessions.ts`; background reads must not depend on a later HTTP
request's ambient identity.

Every read resolves the session's selected agents collection and access using
`srv/lib/collection-access.ts`, then applies per-record enablement and visibility
from `srv/lib/record-policy.ts`. Only the configured global identity or an
agents collection owned by this user is eligible; admin status does not permit
selecting another user's private collection. Missing, deleted, foreign or
wrong-kind selections fail closed with a clear source error, never a silent
switch to the global collection. Do not expose foreign collection content.

Knowledge collection defaults, enablement and session context overrides in
`srv/lib/collection-toggle.ts` do not apply to agents collections. Only the
per-record `enabled` flag controls agent configuration enablement; disabled text
and descriptions never enter planner/worker context. Runtime reads validate
records in global and user collections alike and report malformed data as
`invalid`, even after successful write-time validation.

- `list()` scans all pages, validates visible profile records and returns their
  name, description and result, deterministically sorted by exact name. It omits
  disabled records and prompt records; an ineligible collection is a source error.
- `get(name)` performs exact id/canonical-key lookup, never vector search. Missing
  is `missing`; a disabled record is `disabled`; malformed visible content,
  duplicate identities or wrong kind/name is `invalid`.
- `getPrompts()` reads `_worker-base` and the configured planner by the same exact
  lookup and policy. Return both texts, including empty strings. Hub configuration
  requires these records: missing/disabled/invalid returns the corresponding
  error, not an omitted field that would trigger the library fallback prompt.

Return the library `Result` and `AgentProfileError`; transport/backend failure,
throws, cancellation and deadline expiry map to `unavailable`. Do not expose
hidden content in errors. No positive TTL, cached listing or stale fallback:
persistent reads must check authoritative current records and enablement, not
only the process's restored collection snapshot. Add typed fresh registry reads
where needed. Reuse immutable revisions only after checking current state.

The library `ProfileResolver` bounds discovery/selection/execution resolution
and runner calls, default 3,000 ms; pass `CallOptions.signal` through backend
work, stop on abort and ignore late results. Wire the configured deadline through
`profileTimeoutMs`, with no independent retry loop extending it. Failed discovery
prevents the planner call; selection queues nothing; execution-time failure
fails that queued task. Never substitute legacy workers or seed text. The library
rechecks at task start after acquiring its slot, rejects changed bound result
kinds, and retains a snapshot during execution.

## Runner and tool authority

Proposed `srv/lib/agent-profile-runner.ts` implements `IAgentProfileRunner`.
Refactor the worker/planner builders in `srv/agent-manager.ts` to accept supplied
text and immutable permissions. `createWorker` builds a fresh coordinator-less
worker named after the profile, using the existing destination MCP adapter,
`RecordingMcpClient`, `DialogueRagMcpClient`, result caps, retrieval, skills and
usage pipeline. Shared LLM/embedding clients are safe; mutable prompt, history
and policy state are task-local. No shared raw executor serves all profiles.

Compose through the library context assembler's static preamble: worker base,
profile body, then invariant library guidance (including request-time guidance
exactly once). Skills, brief, dependency results and timestamps remain request
content. `preparePlanner` builds a fresh call-scoped planner with the supplied
resolved system prompt and `PlannerToolsClient`; do not append
`HUB_DIALOGUE_PLANNER_SYSTEM` or rebuild the fallback in the hub. Release planner
tracking on completion, including failures. Dynamic concurrency facts stay in
prepared context rather than the stored static system text.

Bind destination and request identity as today in `srv/request-session.ts` and
`srv/agent-manager.ts`: per-request SAP connection headers/credentials travel
through the existing background task scope to tool calls. Profiles cannot select
credentials, users or destinations. Never persist headers in profiles or state.

### Effective permissions

Add a typed immutable policy in proposed `srv/lib/agent-profile-tools.ts`,
propagated through request/task scope. Code owns report and verdict ceilings:
report may use the destination's installed, classified tools within caller role
grants; verdict is always restricted to the read-only subset. Unknown tool
identities are denied. `analyst` narrows report to read-only through its policy.
No new profile name requires code: the result kind selects the code-owned role.

Effective set = role ceiling intersect caller/destination grants intersect
inherited parent restrictions intersect profile policy. `all` means that ceiling;
`read-only` intersects its read-only subset; omitted allow preserves the ceiling,
present allow (including empty) intersects exact names, and deny always removes.
Reject unsupported policies and unregistered policy names as invalid; no glob,
name-prefix grant or dynamic capability expansion. Tool identities are the exact
registered invocation names; reject ambiguous collisions between providers.

Read-only follows trusted host effect classification in
`srv/lib/tool-authorization.ts`, not model assertions or an external client's
unverified hints:

- SAP: preserve `isReadOnlyTool` and its explicit exceptions for the installed
  catalogue. Read/search/check/validate and the listed test/analysis handlers
  count as read-only under this existing hub definition. It permits diagnostic
  test execution; it does not promise zero server-side diagnostic side effects.
  Runtime program/class execution, object/package mutations, activation,
  transport changes and destructive handlers are excluded. Exposition alone is
  insufficient; explicit mutating exceptions win. Classify newly installed tools
  in code before admitting them; a name resembling `Get` alone grants nothing.
- RAG: `rag_list`, search and record reads are read-only and retain record policy.
  `rag_add`, `rag_correct`, `rag_deprecate`, record enablement and collection/data
  mutations are writes. Session collection toggles also mutate state and are
  excluded from read-only workers.
- Local cloud: `GetDumpSection` in `srv/lib/cloud-local-tools.ts` reads existing
  evidence and is read-only, subject to its `system` exposition grant. Future
  local tools need explicit effect classification.
- External/client tools default to forbidden unless host registration supplies a
  trusted identity, effect and execution guard. Verdict/read-only workers receive
  none of today's untrusted client tools or supplied external results.

### Enforcement points

One policy predicate filters definitions and guards execution before dispatch:

| Path | Required host change |
| --- | --- |
| Offered SAP/local definitions and tool-RAG candidates | Filter `ExpositionFilteringRag`, MCP `listTools` and reselection in `srv/agent-manager.ts`; apply policy after retrieval too. |
| Embedded and network MCP invocation | Guard `RecordingMcpClient` and `invokeEmbeddedTool` in `srv/agent-manager.ts`, and the call handler in `srv/mcp-manager.ts`, alongside `assertToolAllowed` in `srv/lib/tool-authorization.ts`. |
| Local RAG definitions and calls | Apply identical guard in `srv/lib/dialogue-rag-tools.ts`, `srv/rag-tool-dispatcher.ts` and `srv/agent-mcp-rag.ts`; direct dispatcher entry cannot bypass it. |
| External/client calls and results | Filter definitions before the loop; authorize before emitting a client execution request. Resume accepts only a matching outstanding authorized tool/call/task binding and rechecks current caller authority plus the task snapshot before consuming its result. |
| Nested execution | Carry the parent effective policy through any `execute_step`, child worker or delegation entry. Child permissions intersect parent permissions; reject paths that cannot preserve this context. No unrestricted destination handle escape. |
| Queued/restarted/resumed tasks | New attempts resolve current profile/base before building; same live attempt keeps its snapshot. Persisted pending tool calls never restore privileges from state. Reconstruct guarded context before continuation, or fail the continuation and require a new attempt. |

Keep `srv/lib/gatekeeper.ts` admission, leases, cancellation and draining around
these paths. It controls capacity/lifecycle, not tool authorization; placing a
check only there does not secure dispatch. Replace the checker-only boolean scope
in `srv/request-session.ts` with a composable policy scope while preserving any
legacy read-only restriction. Missing required worker scope fails closed. A
rejected call performs no backend/client invocation and returns a named tool
error; prompt wording and hiding definitions are insufficient.

The gate principle remains: better extra eligible tools/context than missing;
the LLM decides relevance. No score thresholds for tools, skills or profiles.
Authorization filtering is mandatory and independent of retrieval relevance.

## Configuration and administration

Add to `srv/agent-config.ts` and document deployment configuration:

| Variable | Default / meaning |
| --- | --- |
| `LLM_AGENT_PROFILES_COLLECTION` | `agents`; exact hub-owned global collection id. |
| `LLM_AGENT_PLANNER_RECORD` | `planner`; exact planner-kind record (`planner-<variant>` allowed). Deployment selection, read fresh each call. |
| `LLM_AGENT_PROFILE_TIMEOUT_MS` | `3000`; positive finite integer, wired as library `profileTimeoutMs`. |
| `LLM_AGENT_MODEL` | Existing main model configuration; the only model name that may be required. |
| `LLM_AGENT_PLANNER_MODEL` | Existing optional override; absent uses main model. |
| `LLM_AGENT_CLASSIFIER_MODEL` | Existing optional override; absent uses main model. |

No per-profile model variable, required checker model, seed directory override or
new backend variable. Use existing RAG backend configuration. Environment changes
are deployment changes; editing selected record bodies requires no restart.

Use existing authenticated REST RAG administration in `srv/rag-handler.ts`, with
strict profile-record validation and canonical-id create/update semantics for
all agents collections. Global mutations (text, metadata, enablement, delete,
bulk import, collection replacement or deletion) require `MCP_Admin`. User-copy
mutations require its authenticated owner via REST; admin status grants no
cross-owner write access. Preserve collection identity, ownership and schema on
edits. Restrict generic chunked imports to prevent invalid configuration records.
REST reads retain record visibility rules; no disabled body leak.
Never modify agents data from a cached copy: partial updates read the authoritative store. Every write attempt that may reach the store invalidates only the affected record?s cached entry in this process, including failed attempts. Other records? cached entries remain untouched; bulk writes invalidate each written record. Catalog-only updates preserve document entries. Deleting a whole collection removes that collection?s entry.

Extend REST collection creation with an explicit copy operation: create a new
user-owned agents collection from the current records of the configured global
one, including enabled flags and prompt bodies. Validate the complete copy with
the same record schema before publishing it; invalid source data or a failed
copy leaves no selectable partial collection. Validate every subsequent record
write, including bulk/replacement paths. Copies have independent identities and
no synchronization or seed repair.

Enforce write protection by resolved collection identity, kind and owner in
shared write guards and registry mutations. The LLM never writes any agents
collection, including its caller's own copy or an admin caller's global one.
Reject all MCP/tool writes in `srv/rag-tool-dispatcher.ts` and
`srv/agent-mcp-rag.ts`, including copy creation, enable/delete/bulk and indirect
paths. Copy creation and user edits are REST-only; no MCP mutation tool is added.
Startup seeding uses a narrowly scoped internal global create-only authority.

### Session selection

Add typed `agentsCollectionId` session configuration, keyed by authenticated user
and issued session id, persisted/restored with the session and cleared with its
state. On session creation, default to the configured global identity and persist
the resolved choice; migrate sessions lacking the field to that default. A
selection is an exact physical identity, never a knowledge collection toggle.

Extend existing REST `POST /v1/session` and MCP `session_open` inputs/responses
with this optional field. Execution inputs do not set the selection. To change
the selection, call `session_open` or `POST /v1/session` again for the same session.
Omission preserves an existing selection. Only the session owner may set it,
and only to the configured global collection or their own agents collection.
MCP selection changes session configuration only; it cannot create/copy or write
an agents collection. Validate selection on set and every source read; reject
foreign/missing/deleted/wrong-kind ids without changing the stored choice or
silently falling back. New calls and queued task starts use the current choice;
a running task retains its immutable snapshot. Persist and restore this field in
the session record, independently of dialogue prompt snapshots and context toggles.

WebUI adds only a session agents selector (configured global plus the user's own
copies), using these APIs, and a REST-backed copy action in existing collection
controls. Reuse record controls with global admin-only and user owner-only writes;
server checks remain authoritative. Exclude agents collections from knowledge
context toggles. Existing worker-name labels display arbitrary profile names
without hard-coded executor/checker lists. A dedicated per-user settings app is
out of scope.

## Migration and persisted dialogues

Wire paired `profileSource`/`profileRunner` in `srv/lib/dialogue-sessions.ts` for
both session and task board construction. Replace dialogue's fixed worker map
with discovery; preserve `executor` and `checker` seed identities. Direct
`execute_step` and fixed/adaptive compatibility entry points in
`srv/agent-manager.ts` must use the same guarded executor profile factory wherever
they run moved executor instructions; preserve their orchestration modes without
adding profile discovery to library APIs that do not support it. No entry path
retains a second hard-coded copy of executor storage rules.

Update `srv/lib/dialogue-store.ts`'s exhaustive typed Zod shapes to round-trip
optional step/task `result` fields from 30.22.0. Keep plan version 1, task ids,
worker names, verdicts, checked task/source bindings and old check/checking
normalization. Library restore maps absent legacy role metadata: checker to
verdict, other names to report. No offline rewrite or mutable profile lookup may
reinterpret completed attempts. Disabled/deleted profiles do not erase existing
verification or delivery gates. Old checker plans require an enabled verdict
profile named `checker`, or explicit reopening and reassignment.

Store no prompt bodies, credentials or tool authorization in dialogue state.
Interrupted work retains existing recovery/consent behavior; never automatically
repeat mutations after restart. Recovered new attempts use fresh profiles and
current caller grants. Restore cannot resume an external tool call without a
reconstructed authorized task context.

All new and changed implementation boundaries use explicit types and discriminated
unions: no `any`, no `unknown` except narrowed caught errors, and no
`as unknown as`. Use concrete JSON value/tool argument types, strict schemas and
typed adapters for legacy RAG/library boundaries; do not spread untyped metadata
into public profiles. Existing loose signatures are not a precedent for new code.

## Validation and rollout

Host tests under `test/unit/` (proposed `agent-profile-source.test.ts`,
`agent-profile-seeds.test.ts`, `agent-profile-runner.test.ts`,
`agent-profile-tools.test.ts`, plus existing dialogue-store/route fixtures):

- Memory seeding, persistent missing-only insertion, disabled/edited records
  surviving restart, invalid frontmatter, duplicate keys/names, id conflicts,
  concurrent service startup and backend failure. A race may rewrite valid seed content; each record uses one upsert.
- Copy current global records and enabled flags; independent identities, no later
  global propagation, no overlay, no user seeding; schema validation on copy and
  every write, atomic failed copies and runtime `invalid` for malformed records.
- Exact lookup and full paginated discovery; disabled record visibility and no
  description/body leak. Knowledge collection toggles and session overrides do
  not affect agents reads; agents never enter knowledge/context retrieval.
- Default global and explicit own-copy session selection through REST/MCP/session
  APIs, persistence/restoration, selection changes at call/task start, exact ids
  and private-name shadowing. Reject foreign selections even for admins, missing,
  deleted and wrong-kind collections; preserve selection on failed updates and
  never silently fall back or mix records from different collections.
- Fresh edits on planner/corrective calls and queued task start; immutable running
  snapshot; changed result kind rejected; empty text preserved; deadline,
  cancellation, late results, missing/invalid records and no stale fallback.
- Prompt composition order, one library suffix, no executor storage/retry rules
  in analyst/checker/base/planner; arbitrary profile names and planner variants;
  isolated concurrent workers and correct per-request SAP credentials.
- Host conformance: `all` cannot widen ceilings, deny wins, empty allow denies,
  verdict is read-only even with `all`, unknown/colliding tools fail closed.
  For every execution row above, test both offered-definition filtering and a
  forged direct call absent from definitions. Verify no backend/client side
  effect for denied MCP, RAG, cloud-local, external, nested and resumed calls.
  Include external result replay/mismatched ids, lost scope after restart and
  nested executor escalation; also prove allowed reads still work.
- Global admin-only REST writes; user-copy owner-only REST creation/writes and
  non-owner rejection, including admins. LLM/MCP writes rejected for global and
  user collections even for their owner/admin, including copy, enable/delete/bulk
  and indirect paths; MCP session selection remains allowed.
- Legacy dialogue fixtures and additive result round-trips, missing checker,
  disabled profiles, source-bound verdicts and unchanged recovery/delivery gates.

Run focused Jest suites with `--maxWorkers=1`, then repository type checking,
lint checks and docs checks. `tsconfig.typecheck.json` does not exist in this
working copy; if introduced before implementation, list every new test file in
it. Keep tests included in the applicable TypeScript project either way.

Implementation rollout bumps both `@mcp-abap-adt/llm-agent` and
`@mcp-abap-adt/llm-agent-libs` to `^30.22.0` in `package.json` and the lockfile,
then adds seeds, fresh source, guarded runner and dialogue integration together.
Before enabling traffic, seed/validate the selected backend and verify default
executor/checker compatibility. Smoke test adding a profile without code, editing
its prompt/tools and the planner body, and disabling it: changes appear on the
next call/start and disabled workers never run. Persistent seed updates do not
change existing records; administrators must explicitly update them.

## Future work (not in this change)

Collections created by another running instance become visible after the registry snapshot is replaced by provider-level reads (separate task); with one instance this does not arise.

- Show the executor's tool trace to verdict workers.
- Classify context parts (system prompt, agent experience, session info, additional collections), with trust levels for additional collections.
- Per-user agent experience updated by a learner inline after a session or in a separate offline process, chosen by config; a separate process promotes user experience into the global one with consent.
- Per-user settings app.

This change writes the design document only. Implementation, dependency updates,
tests and commits are subsequent work.
