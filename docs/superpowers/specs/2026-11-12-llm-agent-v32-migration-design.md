# Hub migration to llm-agent v32 (RAG collection isolation and roles)

Status: draft for review, 2026-11-12.

## Why

The current release must deliver assistants with long-term memory and
learning. Those need per-user and per-session collections isolated by the
library, not by hub checks.

llm-agent v31 introduced owner-bound collections. v32 completed the model:
- a collection has one owner (`session`, `user` or `global`);
- other users get access only through roles bound to the collection.

The hub is on llm-agent 30.x and does its own access checks, so it has to
move to v32.

## Goals

- The hub runs on published npm packages:
  - `@mcp-abap-adt/llm-agent`, `llm-agent-libs`, `llm-agent-server-libs`,
    `pg-vector-rag`, `hana-vector-rag` and `qdrant-rag` at ^32.0.0;
  - the other `@mcp-abap-adt/*` LLM packages at the versions released with
    32.0.0 (their peer range is `llm-agent ^32.0.0`).
- Every RAG call carries a caller and a session. Every collection the agent
  sees is owner-bound by the library (llm-agent `docs/MIGRATION-v31.md` and
  `docs/MIGRATION-v32.md`).
- Existing data on the POC (HANA via HDI) and in local stores (PG, Qdrant)
  is migrated in place. Afterwards, every user and session still sees
  exactly their own documents.
- The same tool set is offered on every channel (MCP, `/v1`, WebUI), as
  today.

## Non-goals

- New memory or learning features. This migration only makes them possible.
- Role administration UI or REST. The hub wires the backend role stores but
  creates no roles. Sharing collections between users comes later.
- Changing which collections exist, or what agent profiles contain.
- Per-user config layer, "prepare"/"keep" requests, tool-search changes.

## Anti-goals

- A client attached to another user's session or collection through any
  implicit fallback: a cookie, an empty header, or an admin flag.
- `file:` dependencies or `npm pack` tarballs of llm-agent in the hub.
- Hub-side access checks that duplicate or bypass the library's.
- Collections that hold records of many owners where each owner may see
  only their own rows. In v32 sharing happens only through roles on the
  whole collection.

## Decisions (made by the user, 2026-11-12)

### D1. Stable sessions on every channel

A session is stable across calls and is bound to one user once, on its first
call. Rebinding is refused.

- **MCP.** The session is the long session named by the `x-clh-session`
  header (`srv/session-id.ts`, `resolveSessionKey`). Today a call without a
  long session gets a per-call `traceId` session:
  - `srv/agent-mcp.ts:434-435`
  - `srv/agent-mcp-orchestration.ts:144-146`

  That fallback goes away. A call with no session gets an error that names
  the missing `x-clh-session` header.
- **`/v1` (OpenAI and Anthropic handlers).** A request with no session gets
  a freshly minted session, returned the way the session middleware does
  today. The minted session is bound to the caller like any other. The
  empty or ad-hoc session fallbacks go away:
  - `srv/openai-handler.ts:307`, `:598-599`
  - `srv/anthropic-handler.ts:141`, `:435`
  - `srv/agent-mcp.ts:217`, `:252`
- **WebUI.** Keeps its cookie session (`clh_session`). The cookie is bound
  to the user on first use. A cookie bound to another user is refused, not
  rebound.

The empty-string `sessionId` never reaches llm-agent.

### D2. No admin bypass

`MCP_Admin` sees the same collections as any user:
- their own;
- those bound to a role they hold;
- global collections.

The rules:
- The `|| admin` branch in `srv/lib/collection-access.ts:29` is removed.
- Writing to global collections stays restricted to `MCP_Admin`, as the
  library requires (`caller.isAdmin` plus a write decision).
- `session_set_models` stays admin-only, as today.

### D3. Ownership of history and hub stores

**Multi-user access goes through roles only.** A collection has one owner.
Several users can reach it only through roles bound to the collection. A
collection never holds rows of many owners where each owner sees only their
own rows.

**History is a per-session collection.**
- Each session's built-in history lives in its own collection.
- The collection's catalog owner is `{ scope: 'session', sessionId }`.
- Its records carry `ownerScope: 'session'` and the `sessionId`, stamped
  with `stampRagOwner`.
- The collection is created on the session's first turn and deleted with the
  session (session lifecycle, `srv/lib/session-lifecycle.ts`).
- The old `owner=[userId,sessionId]` tag and the shared `h_history` store go
  away.

**Hub-internal stores are hub system collections.** These are `h_dialogue`,
`h_runs`, `h_sessions` and `h_planner_memory`, which the agent never reads.
- They stay catalogued as `global`.
- Their rows carry no library identity keys: no `sessionId`, `userId` or
  `roleId`.
- The hub records the session and the user under its own keys:
  - `hubSessionId`
  - `authorUserId`
- The hub filters on these keys itself, as it does today.
- `h_trust` already carries no identity keys and stays as is.

**Lookups.** Lookups keyed by (user, session) stay keyed by both. The user
half comes from the session binding, never from the request alone.

## Constraints

**llm-agent contract** at `@mcp-abap-adt/llm-agent@32.0.0`:
- Trusted caller: `ragAccess = { decision, roles, bindings }`.
- Every builder calls `withRagAccess(ragAccess)`.
- `build()` returns a `Result`.
- `CallOptions.caller` and `CallOptions.sessionId` go on every call.
- Sessions are bound with `bindings.bind(sessionId, userId)` before use.
- `ragStores` entries are shaped `{ name, rag, owner }`.
- `history` and `tools` are reserved collection names in every scope.
- `validateRagMetadata` rules: at most one identity key per record.
- Direct writers stamp with `stampRagOwner`.
- Access stores come from `create{Pg,Hana,Qdrant}VectorRagAccessStores`,
  which return `{ roles, roleAdmin, bindings }`. The hub keeps `roleAdmin`
  for trusted admin tooling only and creates no roles in this migration.
- The decision is the hub's `IRagAccessDecision`. Read is allowed. Write to
  global is allowed for `MCP_Admin` only. Writes to `agents` and
  `task-results` collections keep the hub rules in
  `srv/lib/collection-write-scope.ts`.

**Data migration order**, before any traffic, on every start (each step is
idempotent):
1. The hub's own restamp:
   - move `h_history` rows into per-session history collections;
   - rewrite the internal stores' rows to `hubSessionId`/`authorUserId`.
2. `migrate{Hana,Pg,Qdrant}VectorRagAccess(provider)`.
3. Any `reported` finding stops the start and is logged for administrative
   resolution.

**HANA via HDI.** `tools/deploy-hdi-tables.sh` copies all six table artifacts
from `hana-vector-rag/ddl`:
- `RAG_DOCUMENTS.hdbtable`
- `RAG_COLLECTIONS.hdbtable`
- `rag_roles.hdbtable`
- `rag_role_assignments.hdbtable`
- `rag_collection_roles.hdbtable`
- `rag_session_bindings.hdbtable`

The runtime then uses the shared layout with `autoCreateSchema: false`. Today
the script copies only the first two.

**Qdrant (local).** Deleting the same collection from two processes at once
is not supported. The hub deletes collections from one process.

**Code rules.**
- Static typing everywhere: no `any`, `unknown`, `as unknown as` or
  `as never`.
- No timeouts.

**Deploy.**
- Target: eu10-005 dev org, space `llm-agent`; test on E19 only.
- Take a SQLite snapshot of usage and context before every deploy.
- Built-in agent profiles must reach the store on deploy.
- The first deploy on the POC runs the migration against the live HDI
  container. Take a HANA backup or export of the RAG tables before it.

## Scope of change

These numbers come from the code survey and are approximate.

**srv:**
- `srv/agent-manager.ts`:
  - three `new SmartAgentBuilder` sites (2947, 3158, 3866) get
    `withRagAccess`;
  - six `build()` sites (3187, 3345, 3616, 3681, 3723, 3925) handle the
    `Result`.
- About 13 agent and pipeline call sites pass `caller` and `sessionId`, and
  sessions are bound first. Sites:
  - `srv/agent-mcp.ts`
  - `srv/agent-mcp-orchestration.ts`
  - `srv/openai-handler.ts`
  - `srv/anthropic-handler.ts`
  - `srv/lib/dialogue-sessions.ts`
  - `srv/lib/executor-step.ts`
- `srv/lib/collection-retrieval.ts`: stop replacing `deps.ragStores` with a
  `Record<string, IRag>` (lines 40-46 and 186). Pass owner-bound
  `{ name, rag, owner }` entries instead.
- `srv/lib/collection-access.ts` and `srv/lib/collection-write-scope.ts`:
  - shrink to the write rules in the decision;
  - read visibility is left to the library;
  - the 8 `collectionAccessError` call sites and the hand-written session
    checks in `srv/agent-mcp-rag.ts` follow.
- History: replace `srv/lib/session-history-rag.ts` with a per-session
  history collection.
- Hub stores move to `hubSessionId`/`authorUserId`:
  - `srv/lib/dialogue-store.ts`
  - `srv/lib/run-record-store.ts`
  - `srv/lib/session-record-store.ts`
  - `srv/lib/planner-memory-scope.ts`
- Startup: the migration runs in `srv/server.ts` between `initProviders`
  (1035) and `startCollectionRestore` (1038). Request routes stay gated
  until it succeeds.

**Tests:** about 25 builder setups and about 100 process calls follow the
new signatures, using llm-agent `testRagAccess()`.

**Ops:**
- `tools/deploy-hdi-tables.sh`: six artifacts.
- A one-off data migration on the POC: snapshot, backup, deploy, then check
  the migration report in the logs.

## Review focus

The cases most likely to break for a real user:
1. Two MCP clients of the same user with different `x-clh-session` values do
   not see each other's session collections or history.
2. A WebUI cookie session reused by a second user is refused, never shared.
3. After migration, a user collection whose documents had no `userId`
   (catalog-owned) is still visible to its owner and to nobody else.
4. History recall in a long session returns the earlier turns of that
   session only, also after migration from `h_history`.
5. `MCP_Admin` cannot read another user's collection, but can still write to
   global collections.

## Left to the builder

- Plan order and task split.
- The naming scheme of per-session history collections, as long as it does
  not use the reserved name `history`.
- Message texts of refusals.
