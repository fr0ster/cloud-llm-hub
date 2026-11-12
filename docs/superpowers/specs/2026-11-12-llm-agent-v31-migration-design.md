# Hub migration to llm-agent v31 (RAG collection isolation)

Status: draft for review, 2026-11-12.

## Why

The current release must deliver assistants with long-term memory and
learning. Those need per-user and per-session collections that are isolated
by the library, not by hub checks. llm-agent v31 enforces that isolation for
every scope (session, user, role, global) uniformly. The hub is on
llm-agent 30.x and does its own access checks, so it has to move to v31.

## Goals

- The hub runs on published npm packages:
  - `@mcp-abap-adt/llm-agent` ^31.0.2;
  - `llm-agent-libs` and `llm-agent-server-libs` ^31.0.1;
  - `llm-agent-rag` ^30.10.2;
  - `hana-vector-rag`, `pg-vector-rag` and `qdrant-rag` ^31.0.1.
- Every RAG call carries a caller and a session. Every collection the agent
  sees is owner-bound by the library (`docs/MIGRATION-v31.md` in llm-agent).
- Existing data on the POC (HANA via HDI) and local stores (PG, Qdrant) is
  migrated in place. Afterwards, every user and session still sees exactly
  their own documents.
- The same tool set is offered on every channel (MCP, `/v1`, WebUI), as
  today.

## Non-goals

- New memory or learning features. This migration only makes them possible.
- Changing which collections exist, or what agent profiles contain.
- Per-user config layer, "prepare"/"keep" requests, tool-search changes.

## Anti-goals

- A client attached to another user's session or collection through any
  implicit fallback: a cookie, an empty header, or an admin flag.
- `file:` dependencies or `npm pack` tarballs of llm-agent in the hub.
- Hub-side access checks that duplicate or bypass the library's.

## Decisions (made by the user, 2026-11-12)

### D1. Stable sessions on every channel

A session is stable across calls and is bound to one user once, on its first
call. Rebinding is refused. This is how v31 works.

- **MCP**: the session is the long session named by the `x-clh-session`
  header (`srv/session-id.ts`, `resolveSessionKey`). Today a call without a
  long session gets a per-call `traceId` session (`srv/agent-mcp.ts:434-435`).
  That fallback goes away.
- **`/v1` (OpenAI and Anthropic handlers)**: a request with no session
  (`sessionIdOf(req) ?? ''` in `srv/openai-handler.ts:307` and
  `srv/anthropic-handler.ts:141`) must not reach the agent with an empty
  `sessionId`.
- **WebUI**: keeps its cookie session (`clh_session`). The cookie is bound
  to the user on first use. A cookie bound to another user is refused, not
  re-bound.

*Builder's call, to confirm in review:* what a call with no session gets.
- MCP: an error naming the missing `x-clh-session` header, not a silent
  per-call session.
- `/v1`: a freshly minted session, returned in the response header as the
  session middleware does today. The minted session is bound to the caller
  like any other.

Either way, the empty-string `sessionId` never reaches llm-agent.

### D2. No admin bypass

`MCP_Admin` sees the same collections as any user: their own, the roles they
are assigned, and global collections.
- The `|| admin` branch in `srv/lib/collection-access.ts:29` is removed.
- Writing to global collections stays restricted to `MCP_Admin`. This is a
  write-permission rule, not read visibility.
- `session_set_models` stays admin-only, as today.

### D3. History and session records are session-owned

Today, records written by these files carry both `userId` and `sessionId`:
- `srv/lib/session-history-rag.ts`
- `srv/lib/dialogue-store.ts`
- `srv/lib/run-record-store.ts`
- `srv/lib/session-record-store.ts`

v31 writers refuse records that carry more than one identity key.

The rules:
- These records are owned by the session: `ownerScope: 'session'` plus
  `sessionId`, stamped with `stampRagOwner`.
- The user stays recorded as information under a non-identity key, for
  accounting and the resource ledger.
- *Builder's call:* name that key `authorUserId`.
- Lookups that key by (user, session) become session lookups. The
  session-to-user binding replaces the user half.
- Built-in history is an implicit per-session collection and is never
  global. History recall must filter on the session owner. The old
  `owner=[userId,sessionId]` tag is not used for that.

## Constraints

- llm-agent contract: `docs/MIGRATION-v31.md` in llm-agent at
  `@mcp-abap-adt/llm-agent@31.0.2`. The parts the hub must follow:
  - `callerResolver` and `ragAccess {decision, roles, bindings}`;
  - `build()` returns a `Result`;
  - `CallOptions.caller` and `sessionId` on every call;
  - `ragStores` entries shaped `{name, rag, owner}`;
  - `history` and `tools` are reserved collection names in every scope;
  - `validateRagMetadata` rules.
- Data migration uses the library: `migrate{Hana,Pg,Qdrant}VectorRagAccess`.
  Since 31.0.1 of the backends they stamp records from the collection's
  catalog owner (llm-agent #446).
- HANA via HDI:
  - `tools/deploy-hdi-tables.sh` must also copy the access tables shipped by
    `hana-vector-rag` 31.0.1 (llm-agent #447):
    - `rag_roles.hdbtable`
    - `rag_role_assignments.hdbtable`
    - `rag_session_bindings.hdbtable`
  - It must also copy the updated `RAG_COLLECTIONS.hdbtable`, which carries
    `ROLE_ID`.
  - Today it copies only `RAG_DOCUMENTS` and `RAG_COLLECTIONS`.
- Static typing everywhere: no `any`, `unknown`, `as unknown as` or
  `as never`. No timeouts.
- Deploy target: eu10-005 dev org, space `llm-agent`, tested on E19 only.
  Take a SQLite snapshot of usage and context before every deploy.
  Built-in agent profiles must reach the store on deploy.

## Scope of change

These numbers come from the code survey and are approximate.

**srv:**
- the user identity comes from `cds.context.user.id`, admin from
  `is('MCP_Admin')`;
- `srv/lib/collection-access.ts` and `srv/lib/collection-write-scope.ts`:
  shrink to write-permission rules only, with visibility left to the
  library;
- `srv/lib/collection-retrieval.ts`: stop replacing `deps.ragStores` with a
  `Record<string, IRag>` (lines 40-46 and 186). Use owner-bound entries
  instead;
- `srv/agent-manager.ts`: six `builder.build()` calls (3187, 3345, 3616,
  3681, 3723, 3925) handle the `Result`. Three builders get
  `callerResolver` and `ragAccess`;
- about 13 call sites must pass `caller` and `sessionId`;
- about 17 RAG writers must stamp the owner.

**Tests:** about 25 builder setups and about 100 process calls follow the
new signatures.

**Ops:**
- `tools/deploy-hdi-tables.sh`: add the access tables;
- a one-off data migration: snapshot, run the migration, then check its
  report.

## Review focus

The cases most likely to break for a real user:
1. Two MCP clients of the same user with different `x-clh-session` values
   do not see each other's session collections or history.
2. A WebUI cookie session reused by a second user is refused, never shared.
3. After migration, a user collection whose documents had no `userId`
   (catalog-owned) is still visible to its owner and to nobody else.
4. History recall in a long session returns the earlier turns of that
   session only.
5. `MCP_Admin` cannot read another user's collection, but can still write
   to global collections.

## Left to the builder

- Plan order and task split.
- Where the session binding store lives: the backend's
  `rag_session_bindings` or the hub's own binding store, as long as it is
  durable on the POC.
- Message texts of refusals.
