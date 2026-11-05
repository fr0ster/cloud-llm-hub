# Role-split RAG tools - design

Status: draft
Date: 2026-11-05

## Intent

Dialogue workers and the dialogue coordinator get different collection tools.

- **Workers** always work in the session. Their tools have no scope parameter
  and cannot name a user collection.
- **The coordinator** names collection and scope explicitly. It does that for
  whatever the user asks, including keeping worker results in a user
  collection.

Product owner, 2026-11-05: "воркери в принципі роблять в сесійному скоупі а
координатор може сам явно вказувати коллекціі і скоуп шоб на прохання юзера
шось робити"; separating scopes by name is "дуже незручно".

This narrows one decision of the 2026-10-31 unified-RAG-tools design
("tools must be the same for any connection"). Connections stay at parity:
agent MCP, OpenAI/Anthropic chat and WebUI keep one catalogue. Only the two
**roles inside a dialogue** differ.

## Why now

POC session 0f2bf074, hub 10.5.4, Phase 3 of the documentation process:

- A worker briefed with target `mte-u4` called
  `collection_create {name:"mte-u4", scope:"user"}` three times. Each call got
  `TOOL_FORBIDDEN: Workers create session collections only`
  (`srv/agent-mcp-rag.ts:388-395`). Only then did it use `scope:"session"`.
- It named the session collection `mte-u4`, the same name as the user
  collection. Names resolve with "session shadows user"
  (`srv/collection-ids.ts:111-116`), so the coordinator and the checker read
  `mte-u4` and saw the session copy.
- The coordinator never called `rag_persist`. It reported "saved and verified
  in mte-u4", but the artifacts never reached the user collection. Phase 4 in
  a new session will not find them.
- An earlier session (935df710) made 20 `rag_persist` calls, of which 16
  failed. The coordinator passed the user target as the source collection and
  had to guess the worker's session collection name.

## Goals

- **G1. Worker writes are session-only by construction.** Worker write tools
  have no `scope` and cannot target a user or global collection. Their writes
  always land in their own session. Reads keep today's semantics and access
  paths (session, user and global collections, `@skills`).
- **G2. Coordinator tools are explicit.** Every collection argument of a
  coordinator tool is `{ scope: 'session' | 'user' | 'global', collection: string }`.
  `global` is read-only and includes `@skills`. Nothing is resolved
  implicitly, and nothing shadows across scopes.
- **G3. Persisting is unambiguous.** `rag_persist` copies from a session
  collection to a user collection given as two explicit addresses. The same
  logical name in both scopes is legal.
- **G4. The coordinator knows where results are.** A task notice lists the
  session records the worker wrote, as `session/<collection>/<record>`.

## Non-goals

- Changing external-connection tool sets (agent MCP, chat, WebUI). Their
  catalogue, the "session shadows user" resolution for bare names and REST
  routes stay as they are. *(Author's call: keeps external clients stable;
  revisit separately.)*
- Learning or corrective skills.
- Global collection writes by the coordinator. Global stays admin/REST only.

## Anti-goals

- **Runtime refusal as the main guard.** A worker shown a capability it may
  not use. Guards stay as defence in depth, but the schema must not offer
  the forbidden option.
- **Silent scope substitution.** A coordinator read or write that lands in a
  different scope than the one it named.
- **Isolation regression.** A worker or coordinator reaching another session
  or another user.

## Design

### D1. Worker tool set (hub)

Workers have the dialogue role `worker`, the same as `context.dialogueRole`
today. Schemas and descriptions are dedicated to workers:

| Tool | Worker contract |
|---|---|
| `collection_create` | `{ name }`. Always session scope; no `scope` field. |
| `record_add` / `record_update` / `record_set_enabled` | `{ collection, record?, text, … }`. `collection` names a collection **of this session**; resolution is session-only. A missing session collection gives a scoped not-found; creation stays explicit through `collection_create`. |
| `rag_search` / `rag_read` / `collection_records` / `collections_list` | Unchanged read semantics and access paths (search honours session enablement; direct read/list use their existing access checks; discovery shows disabled collections with their state). Results label each collection `session/<name>`, `user/<name>` or `global/<name>`. |
| `rag_persist`, trust tools, `collection_delete`, `collection_set_enabled`, `record_delete` | Not offered (as today's guards already refuse them). |

- Descriptions say that worker results stay in the session and that the
  coordinator decides where they are kept.
- The existing runtime guards (`srv/agent-mcp-rag.ts:381-410`) stay as
  defence in depth.

### D2. Coordinator tool set (hub)

The coordinator keeps its read tools and gains explicit addressing:

```ts
type CollectionAddress = { scope: 'session' | 'user' | 'global'; collection: string };
// 'global' is accepted only by read tools; '@skills' is addressed as { scope: 'global', collection: '@skills' }.
```

| Tool | Coordinator contract |
|---|---|
| `rag_read`, `rag_search`, `collection_records` | the collection argument is a `CollectionAddress`; `rag_search` takes an optional list of them |
| `collections_list` | lists `{ scope, collection, records, enabled }` for this session and the user |
| `rag_persist` | `{ from: CollectionAddress & { scope: 'session' }, to: CollectionAddress & { scope: 'user' }, records?: string[] }` |
| `collection_create`, `record_*` (only if the coordinator writes itself) | `CollectionAddress` |

- An address that does not exist yields `COLLECTION_NOT_FOUND` naming the
  scope and the name. The error lists this session's collections when the
  scope is `session`, and the user's matching names when the scope is
  `user`. A user-scope address is never resolved to a session collection, or
  the other way round.
- Whether the coordinator writes records itself, or only persists and
  delegates writes, follows today's coordinator profile, which delegates.
  The tool set offers only what the profile needs: reads, `collections_list`
  and `rag_persist`. *(Author's call.)*

### D3. Task notice lists written records (library + hub)

- **Library.** A task notice and its stored result entry gain
  `written?: { collection: string; record: string }[]`. The host supplies it
  from the worker's successful write calls through a typed callback. The
  library does not interpret RAG tool names.
- **Hub.** The hub fills it from the recorder, using successful `record_add`
  / `record_update` calls in the worker's session. The notice renders it as
  `written: session/mte-u4/evidence-§1, …`.
- The coordinator profile says to persist from the notice's `written` list.

### D4. Profiles

- **`_worker-base` and worker profiles:** drop the "store in session
  collections" wording that the tool set now enforces. Keep one sentence:
  results stay in the session, and the coordinator keeps them.
- **`coordinator`:** replace the 10.5.4 sentence with
  `rag_persist({ from: {scope:'session',…}, to: {scope:'user',…} })` driven
  by the notice's `written` list. It never asks workers to write user
  collections.
- Profile changes reach deployments through the seed fix in the release
  (`fix/seed-builtin-profiles`); no manual agents update.

### D5. Contract versioning

- This is a breaking change to the dialogue tool contract. Bump
  `DIALOGUE_TOOL_CONTRACT_VERSION`. The migration in
  `srv/lib/dialogue-store.ts` (~line 71) returns early for version `1`
  without interruption; change it so any older version interrupts unfinished
  tasks and blocks unfinished steps for replanning.
- External connections are unchanged, so the agent-MCP contract version
  stays.

## Constraints

- Static typing: no `any`, `unknown` (except narrowed caught errors),
  `as unknown as` or `as never`. Use zod schemas per role.
- Session isolation: every session address is scoped to the caller's own
  session id, and every user address to the caller's user id.
- No timeouts. Only `LLM_AGENT_MODEL` may be required config.
- Same-tools-every-connection still holds across connections. The role split
  is internal to the dialogue.

## Verification

- **Unit tests.**
  - Worker schemas have no `scope` and no user addressing. A worker
    `record_add` to a name that exists only as a user collection creates or
    targets the session collection, never the user one.
  - Coordinator `rag_read {scope:'user', collection:'mte-u4'}` reads the user
    collection even when a session `mte-u4` exists, and the other way round.
  - `rag_persist` works with the same name in both scopes.
  - Not-found errors list the candidates.
  - A notice carries `written`.
  - Contract version bump interrupts old unfinished tasks.
- **Isolation tests.** Another session's or another user's address is
  refused.
- **Live run.** Phase 3 on POC with context capture `full`. Expect zero
  worker `TOOL_FORBIDDEN`, `rag_persist` from the notice on the first try,
  and the records present in the user collection after the session.

## Decisions from the builder check (author's calls, for review)

- Reads of global collections and `@skills` stay available to both roles;
  the coordinator addresses them as `global` (read-only).
- Workers do not gain `record_delete`; the worker write set is exactly
  today's allowed set (create, add, update, record enablement) narrowed to
  the session by schema.
- External MCP clients keep bare names (Non-goals); the coordinator
  delegates writes and only persists (D2).
- `written` is collected per task from successful write results before
  truncation, including generated record ids. Repeated add/update of one
  address is deduplicated, and a successful delete removes it. `written` is
  kept for failed/stopped tasks too; nothing is persisted automatically. The
  automatic `task-results/<task>` record stays a separate `resultRef`; the
  notice shows both.
- `written` flows through library types, result-store metadata and the hub's
  zod restore schemas.
- Explicit addresses use logical names, never physical ids. Errors list
  only caller-owned candidates.
- Existing `rag_persist` rules stay: creating the target, omitted `records`,
  idempotent re-copy.

## Left to the builder

- Where the role-specific catalogues live (`srv/lib/rag-tool-catalogue.ts`
  split or a role parameter).
- The exact `collections_list` output shape.
- How the recorder exposes successful worker writes to the dialogue host.
