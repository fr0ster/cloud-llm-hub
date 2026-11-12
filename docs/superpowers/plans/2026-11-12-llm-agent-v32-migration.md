# Hub migration to llm-agent v32 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move cloud-llm-hub from llm-agent 30.x to 32.0.0 so that the library,
not the hub, isolates every collection by owner and session.

**Architecture:**
- A new hub access module supplies llm-agent `RagAccess` (backend role and
  binding stores, plus a hub decision) to every builder and a trusted
  `RagCaller` to every agent call.
- Sessions become stable and are bound to their user before use.
- History moves to per-session collections. Hub-internal stores stop
  carrying library identity keys.
- On startup the hub restamps its data, then runs the backend access
  migration, before any traffic.

**Tech Stack:** TypeScript, SAP CAP/Express, jest + ts-jest,
`@mcp-abap-adt/llm-agent*` 32.0.0, HANA (HDI) / PG / Qdrant backends.

**Spec:** `docs/superpowers/specs/2026-11-12-llm-agent-v32-migration-design.md`
(decisions D1–D3 are binding). Library contracts:
- llm-agent `docs/MIGRATION-v31.md`
- llm-agent `docs/MIGRATION-v32.md`

## Global Constraints

**Dependencies**
- Use published npm versions only: `@mcp-abap-adt/llm-agent`,
  `llm-agent-libs`, `llm-agent-server-libs`, `pg-vector-rag`,
  `hana-vector-rag` and `qdrant-rag` at `^32.0.0`.
- Every other `@mcp-abap-adt/*` LLM package goes to the version released
  with 32.0.0.
- No `file:` deps and no tarballs.

**Code rules**
- No `any`, `unknown`, `as unknown as` or `as never`, in new code or tests.
- No timeouts.
- The empty-string `sessionId` never reaches llm-agent.
- `MCP_Admin` never reads another owner's collection. Global writes need
  `MCP_Admin`.
- A record carries at most one of `sessionId` / `userId` / `roleId`.
- Hub-internal stores use `hubSessionId` and `authorUserId` instead.

**Commands**
- Typecheck: `npx tsc --noEmit -p tsconfig.test.json`.
- Unit tests: `npx jest --maxWorkers=2`.
- Lint: `npx biome check --config-path . srv tools test`.

**Workflow**
- At most 2 concurrent processes.
- Codex implements and never commits. Claude runs the tests and makes
  GPG-signed commits on the feature branch, never on `main`.

## Review Focus

The cases a real user is most likely to hit. Each one is pinned by a test in
the task named.

1. Two MCP clients of one user with different `x-clh-session` values see
   neither each other's session collections nor history. *(Task 3)*
2. A WebUI `clh_session` cookie presented by a second user is refused and
   never rebound. *(Task 3)*
3. After migration, a user collection whose documents have no `userId` is
   visible to its owner and to nobody else, `MCP_Admin` included.
   *(Task 4, Task 7)*
4. History recall in a long session returns only that session's earlier
   turns, also for turns migrated from `h_history`. *(Task 6)*
5. `MCP_Admin` cannot read another user's collection but can write to a
   global one. *(Task 4)*

---

### Task 1: Upgrade packages and wire RagAccess into every builder

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `srv/lib/rag-access.ts`
- Modify: `srv/agent-manager.ts`:
  - builders at `:2947`, `:3158`, `:3866`;
  - `build()` calls at `:3187`, `:3345`, `:3616`, `:3681`, `:3723`,
    `:3925`.
- Create: `test/unit/rag-access.test.ts`
- Create: `test/unit/helpers/test-rag-access.ts`
- Modify: every test that builds a `SmartAgentBuilder` (23 sites in 11
  files).

**Interfaces:**
- **Produces**, from `srv/lib/rag-access.ts`:
  - `interface HubRagAccess { readonly access: RagAccess; readonly roleAdmin: IRagRoleAdmin }`
  - `function createHubRagAccess(collections: IRagProvider | null, kind: RagBackendKind): HubRagAccess`
    - `hana-vector` uses `createHanaVectorRagAccessStores`.
    - `pg-vector` uses `createPgVectorRagAccessStores`.
    - `qdrant` uses `createQdrantVectorRagAccessStores`.
    - Any other kind uses `InMemoryRagRoleStore` (as both `roles` and
      `roleAdmin`) and `InMemorySessionBindingStore`, from
      `@mcp-abap-adt/llm-agent`.
  - `function hubAccessDecision(): IRagAccessDecision`
    - `canRead` returns `true`.
    - `canWrite(caller, ref)` returns
      `ref.owner.scope !== 'global' || caller.isAdmin`.
  - `function initHubRagAccess(value: HubRagAccess): void` and
    `function getHubRagAccess(): HubRagAccess`. The getter throws if the
    value is not initialised.
- **Produces**, from `test/unit/helpers/test-rag-access.ts`:
  - `function testAccess(callers: readonly RagCaller[]): RagAccess`
    wraps llm-agent `testRagAccess(callers)` from
    `@mcp-abap-adt/llm-agent/testing/rag-access-testing`.

- [ ] **Step 1: Upgrade the dependencies.**
  - Raise every `@mcp-abap-adt/*` range in `package.json` to the 32.0.0
    release set.
  - Run `npm install`.
  - Run `npm ls @mcp-abap-adt/llm-agent`. Expected: every entry is `32.0.0`
    and there is no `ERESOLVE`.
- [ ] **Step 2: Write the failing tests** in `test/unit/rag-access.test.ts`:
  - `hubAccessDecision allows reads`: `canRead` returns `true` for owner
    scope `user` and for `global`.
  - `global writes need MCP_Admin`: `canWrite` with `isAdmin: false` on a
    `global` owner returns `false`; with `isAdmin: true`, `true`.
  - `user and session writes are not admin-gated`: `canWrite` with
    `isAdmin: false` on `{scope:'user', userId:'u1'}` returns `true`.
  - `in-memory kind gets durable-shaped stores`:
    `createHubRagAccess(null, 'in-memory')`. Then
    `access.bindings.bind('s1','u1')` is ok, `bind('s1','u2')` is an error,
    and `getUserId('s1')` returns `'u1'`.
- [ ] **Step 3: Run the tests to verify they fail.**
  Run `npx jest test/unit/rag-access.test.ts`.
  Expected: FAIL, module not found.
- [ ] **Step 4: Implement `srv/lib/rag-access.ts`** as specified in
  Interfaces.
- [ ] **Step 5: Wire it in.**
  - In `startProviders` / `initProviders` (`srv/lib/providers.ts`), call
    `initHubRagAccess(createHubRagAccess(p.collections, persistentKind))`.
  - In `srv/agent-manager.ts`, add `.withRagAccess(getHubRagAccess().access)`
    to the three builders.
  - At the six `build()` sites, replace `await builder.build()` with
    `unwrapBuilderResult(await builder.build())` from
    `@mcp-abap-adt/llm-agent-libs`.
- [ ] **Step 6: Update the 23 test builder sites.** Each one calls
  `.withRagAccess(testAccess([caller]))` with the caller it later uses, and
  unwraps `build()`.
- [ ] **Step 7: Verify.**
  - Run `npx tsc --noEmit -p tsconfig.test.json`.
    Expected: clean, apart from errors at agent call sites that lack
    `caller`. Those are listed and fixed in Task 2.
  - Run `npx jest test/unit/rag-access.test.ts`. Expected: PASS.
- [ ] **Step 8: Commit.**
  `feat(rag): wire llm-agent 32 RagAccess into hub builders`

*Ruling:* the full jest suite turns green at the end of Task 2. Task 1 alone
cannot pass it, because v32 refuses agent calls without a caller.

### Task 2: Trusted caller and bound session on every agent call

**Files:**
- Create: `srv/lib/rag-caller.ts`
- Modify the call sites:
  - `srv/agent-mcp.ts` (`opts` at `:506-529`)
  - `srv/agent-mcp-orchestration.ts` (`:166`, `:206`)
  - `srv/openai-handler.ts` (`opts` at `:1096-1112`)
  - `srv/anthropic-handler.ts` (`agentOpts` at `:663-675`)
  - `srv/lib/dialogue-sessions.ts` (`:1047`, `:612`, `:647`)
  - `srv/lib/executor-step.ts` (`:65`, `:95`)
- Modify the wrappers that spread `args[1]`, so they keep `caller` intact:
  - `srv/agent-manager.ts:3738-3760`
  - `srv/lib/llm-only-guard.ts`
- Test: `test/unit/rag-caller.test.ts`.
- Modify: about 100 test process calls in 22 files.

**Interfaces:**
- **Consumes:** `getHubRagAccess()` from Task 1.
- **Produces**, from `srv/lib/rag-caller.ts`:
  - `async function bindCaller(sessionId: string, userId: string, isAdmin: boolean): Promise<Result<RagCaller, RagAccessDeniedError>>`
    - Refuses an empty `sessionId`, an empty `userId` and `'anonymous'`.
    - Calls `getHubRagAccess().access.bindings.bind(sessionId, userId)`.
    - Maps `SessionBindingConflictError` and store errors to
      `RagAccessDeniedError`.
    - On success returns `{ sessionId, userId, isAdmin }`.
  - `function callOptionsFor(caller: RagCaller): { caller: RagCaller; sessionId: string }`
- Every agent call site spreads `callOptionsFor(caller)` into its
  `CallOptions`. `caller` is built once per request after the session is
  resolved, using the existing helpers:
  - `userId` from `getUserId()` / `describeCaller` / `authenticatedCaller`;
  - `isAdmin` from `cds.context?.user?.is('MCP_Admin')`.

- [ ] **Step 1: Write the failing tests** in `test/unit/rag-caller.test.ts`:
  - `binds once and returns the caller`
  - `refuses rebinding to another user`: `bindCaller('s1','u2',false)`
    after `('s1','u1')` returns an error.
  - `refuses empty session and anonymous user`: `''` returns an error;
    `'anonymous'` returns an error.
  - `a refused caller never reaches the agent`: a test agent whose
    `process` records calls is not called when `bindCaller` fails.
- [ ] **Step 2: Run the tests to verify they fail.**
  Run `npx jest test/unit/rag-caller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `srv/lib/rag-caller.ts`** and thread
  `callOptionsFor` through every call site listed under Files.
  - A refusal answers HTTP 403 on `/v1`.
  - A refusal answers an MCP tool error on MCP.
  - Do not build a caller from a session string alone.
- [ ] **Step 4: Update the test process calls.** Each one passes
  `{ caller, sessionId: caller.sessionId }` matching the caller given to
  `testAccess`.
- [ ] **Step 5: Verify.**
  - Run `npx tsc --noEmit -p tsconfig.test.json`. Expected: clean.
  - Run `npx jest --maxWorkers=2`. Expected: all pass.
- [ ] **Step 6: Commit.**
  `feat(rag): pass a bound trusted caller on every agent call`

### Task 3: Stable sessions on every channel (D1)

**Files:**
- `srv/agent-mcp.ts`:
  - remove the `traceId` session fallback at `:434-435`;
  - remove `?? ''` at `:217` and `:252`.
- `srv/agent-mcp-orchestration.ts:144-146`
- `srv/openai-handler.ts`: `:307` and `:598-599`
- `srv/anthropic-handler.ts`: `:141` and `:435`
- `srv/lib/session-middleware.ts`: the cookie path (`:178-204`)
- Tests:
  - `test/unit/session-binding-channels.test.ts`
  - `test/unit/helpers/channel-harness.ts`

**Interfaces:**
- **Consumes:** `bindCaller` from Task 2.
- **Produces:**
  - MCP `execute_step`, `plan_create` and `plan_revise` with no long session
    return the tool error `SESSION_REQUIRED`. Its message names the
    `x-clh-session` header.
  - `/v1` with no session mints one through the existing session
    middleware, then binds it.
  - A cookie session bound to another user is refused with 403, never
    re-minted silently for that user.

- [ ] **Step 1: Write the failing tests** in
  `test/unit/session-binding-channels.test.ts`, using the channel harness:
  - `MCP call without x-clh-session is refused naming the header`
  - `two MCP sessions of one user do not share session collections or history`
    (Review Focus 1). User `u1` writes a session collection record and a
    history turn under `ls-a`. A call under `ls-b` finds neither.
  - `a /v1 request without session gets a minted, bound session`. The
    response carries the session. `bindings.getUserId(minted)` returns the
    caller.
  - `a clh_session cookie of u1 presented by u2 is refused` (Review
    Focus 2). Expected 403; the binding stays `u1`.
  - `no channel passes an empty sessionId to the agent`. A spy agent
    asserts that `options.sessionId` is non-empty on every channel.
- [ ] **Step 2: Run the tests to verify they fail.**
  Run `npx jest test/unit/session-binding-channels.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three behaviours under Produces. Remove
  every fallback listed under Files.
- [ ] **Step 4: Verify.** Run `npx jest --maxWorkers=2` and typecheck.
  Expected: all pass.
- [ ] **Step 5: Commit.** `feat(session): stable bound sessions on every channel`

### Task 4: Owner-bound collection retrieval, no admin bypass (D2)

**Files:**
- `srv/lib/collection-retrieval.ts`: `:38-47` and `:160-190`
- `srv/lib/collection-access.ts`
- `srv/lib/collection-write-scope.ts`
- `srv/lib/rag-access.ts`, which absorbs the write rules into
  `hubAccessDecision`
- `srv/agent-mcp-rag.ts`:
  - `collectionAccessError` at `:936`;
  - the hand-written session checks at `:378`, `:493`, `:580`, `:628`,
    `:934`, `:1005`, `:1057`.
- `srv/rag-handler.ts`: `:394`, `:640`
- `srv/lib/rag-write-operations.ts`: `:83`, `:91`, `:173`, `:193`
- `srv/lib/agent-profile-source.ts:113`
- Test: `test/unit/collection-isolation-v32.test.ts`

**Interfaces:**
- **Consumes:**
  - `catalogOwner(meta)` (`srv/lib/collection-persistence.ts:81-94`), which
    maps hub `CollectionMeta` to `RagCollectionOwner`;
  - `getHubRagAccess()`.
- **Produces:**
  - `collectionRetrieval` builds `SmartAgentRagStores` entries
    `{ name: collectionId, rag, owner: catalogOwner(meta) }` and passes them
    as owner-bound stores. `deps.ragStores` is no longer mutated with bare
    `IRag`.
  - `collectionAccessError(meta, userId, mode)` keeps only the write and
    `agents`/`task-results` rules. The `admin` parameter is removed, and so
    is the `|| admin` read bypass.
  - Read visibility comes from the library, through `checkAccess` from the
    owner-bound stores.
  - The decision's `canWrite` also refuses tool-origin writes to `agents`
    and to `task-results` from anything but the session task store. This
    moves the rules out of `assertCollectionWrite`; the observable
    behaviour is unchanged.

- [ ] **Step 1: Write the failing tests** in
  `test/unit/collection-isolation-v32.test.ts`:
  - `MCP_Admin cannot read another user's collection` (Review Focus 5,
    read half). Admin caller `a1` querying a `{scope:'user', userId:'u1'}`
    collection gets no records, and the MCP `rag_query` reports it as not
    found.
  - `MCP_Admin can write a global collection; a user cannot` (Review
    Focus 5, write half).
  - `a user collection without record userId is visible to its owner only`
    (Review Focus 3, live path). Records written through the registry
    without `userId`: owner `u1` gets them, `u2` gets none, admin gets none.
  - `retrieval passes owner-bound entries`. The spy pipeline receives
    `{name, rag, owner}` with the catalog owner.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** as under Produces. Remove the `admin`
  argument at every call site listed under Files.
- [ ] **Step 4: Verify.** Run the full jest suite and typecheck. Expected:
  pass.
- [ ] **Step 5: Commit.**
  `feat(rag): owner-bound retrieval, drop admin read bypass`

### Task 5: Hub-internal stores without library identity keys (D3)

**Files:**
- `srv/lib/dialogue-store.ts`: `:686-691`, `:710-720`
- `srv/lib/run-record-store.ts`: `:274-300`
- `srv/lib/session-record-store.ts`: `:382-416`
- `srv/lib/planner-memory-scope.ts`: `:28-34`, `:46`, `:87-93`, `:134`
- Create: `srv/lib/hub-store-restamp.ts`
- Tests:
  - `test/unit/hub-store-keys.test.ts`
  - `test/unit/hub-store-restamp.test.ts`

**Interfaces:**
- **Produces:**
  - These stores write
    `{ hubSessionId: <session>, authorUserId: <user>, ...existing }` with no
    `sessionId` or `userId`. Scans filter on `{ hubSessionId, authorUserId }`.
    Ids, `dialogueId(userId, sessionId)` and `runRecordId(userId, sessionId)`,
    stay unchanged.
  - Planner memory stores the combined owner under `hubSessionId` instead
    of `sessionId`.
  - `async function restampHubStores(provider: IRagProvider): Promise<Result<{ rewritten: number }, RagError>>`
    - Rewrites rows of `h_dialogue`, `h_runs`, `h_sessions` and
      `h_planner_memory`: `sessionId` becomes `hubSessionId`, and `userId`
      becomes `authorUserId`.
    - Uses the stores' raw writers with the same id and vector.
    - Idempotent: rows that are already restamped are skipped.

- [ ] **Step 1: Write the failing tests.**
  - `hub stores write no library identity keys`. Saved rows have no
    `sessionId` or `userId`, and `validateRagMetadata(row.metadata)` does
    not throw.
  - `load still isolates by user and session`. `load(u2, s1)` does not
    return the row of `(u1, s1)`.
  - `restamp rewrites legacy rows once`. Legacy rows get the new keys and
    are counted. A second run reports `rewritten: 0`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the full jest suite and typecheck. Expected:
  pass.
- [ ] **Step 5: Commit.**
  `feat(stores): hub stores keyed by hubSessionId/authorUserId`

### Task 6: Per-session history collections (D3)

**Files:**
- Create: `srv/lib/session-history-collection.ts`
- Remove from use: `srv/lib/session-history-rag.ts`. Delete it once nothing
  imports it.
- Modify:
  - `srv/agent-manager.ts` history wiring (`:1515-1611`, `setHistoryRag` at
    `:3026-3030`);
  - `srv/lib/session-turns.ts`;
  - `srv/lib/session-lifecycle.ts`: `:359`, `:437`;
  - `srv/session-store.ts`: `:92`, `:169`;
  - the `recordTurn` call sites in `srv/openai-handler.ts`.
- Tests:
  - `test/unit/session-history-collection.test.ts`
  - `test/unit/history-migration.test.ts`

**Interfaces:**
- **Consumes:**
  - the registry and persistence used for session collections, which
    create the catalog owner `{scope:'session', sessionId}`;
  - `stampRagOwner`.
- **Produces:**
  - `function historyCollectionName(sessionId: string): string` returns
    `h_hist_` followed by the first 32 hex characters of the `sha256` of
    `sessionId`. It never returns `history`.
  - `class SessionHistoryRouter implements IRag, IRagEditor`, the single
    store handed to `builder.setHistoryRag`.
    - It routes every read and write to the history collection of the
      request's session, read from the trusted caller the library passes.
    - It creates the collection on the first write.
    - With no session in the call it returns an empty result and writes
      nothing.
  - `async function forgetSessionHistory(sessionId: string): Promise<void>`
    deletes the session's history collection. It is called by the session
    lifecycle where `forgetOwner` was.
  - `async function migrateSharedHistory(provider: IRagProvider): Promise<Result<{ moved: number }, RagError>>`
    - Moves `h_history` rows, grouped by their `sessionId`, into the
      per-session collections. Records are stamped `ownerScope:'session'`
      and `sessionId`, keep `createdAt` and add `authorUserId`.
    - Then deletes `h_history`.
    - Idempotent: with no `h_history` it reports `moved: 0`.

- [ ] **Step 1: Confirm the library hook.** Read how llm-agent-libs 32
  calls the history store, and which `CallOptions` / `ragFilter` / `caller`
  carries the session. If no trusted session reaches the history store,
  stop and report NEEDS_CONTEXT.
- [ ] **Step 2: Write the failing tests.**
  - `history recall returns only the session's own turns` (Review Focus 4).
    Turns under `s1` and `s2` of the same user: a recall in `s1` returns
    only `s1`.
  - `no session, no history`
  - `forgetSessionHistory removes the collection`
  - `migrated h_history turns are recalled in their session` (Review
    Focus 4, migration half). Seed legacy rows
    `{owner, userId, sessionId}`, run `migrateSharedHistory`, then recall
    in `s1`. The rerun reports `moved: 0`.
- [ ] **Step 3: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 4: Implement**, and replace the shared-history wiring.
- [ ] **Step 5: Verify.** Run the full jest suite and typecheck. Expected:
  pass.
- [ ] **Step 6: Commit.** `feat(history): per-session history collections`

### Task 7: Startup migration, request gating, HDI artifacts

**Files:**
- Create: `srv/lib/rag-migration.ts`
- Modify:
  - `srv/server.ts`: `:1032-1071`, between `initProviders` and
    `startCollectionRestore`;
  - the 503 readiness guard that `server.ts:968-970` refers to;
  - `tools/deploy-hdi-tables.sh:25`.
- Tests:
  - `test/unit/rag-migration.test.ts`
  - `test/unit/deploy-hdi-tables.test.ts`, or extend the existing dry-run
    test if there is one.

**Interfaces:**
- **Consumes:**
  - `restampHubStores` (Task 5);
  - `migrateSharedHistory` (Task 6);
  - `migrate{Hana,Pg,Qdrant}VectorRagAccess` from the backends.
- **Produces:**
  `async function migrateRagData(collections: IRagProvider | null, kind: RagBackendKind, log: (line: string) => void): Promise<Result<void, RagError>>`
  - Runs, in order: `restampHubStores`, then `migrateSharedHistory`, then
    the backend migration for `kind`.
  - Every `reported` finding is logged with `storeName` and `reason`.
  - Any finding makes the result an error. No backend (in-memory) means
    `ok`.

  `server.ts` awaits it. On error it exits like a provider failure
  (`process.exit(1)`). Until it succeeds, chat, MCP and RAG routes answer
  503.

- [ ] **Step 1: Write the failing tests.**
  - `runs restamp, history move, backend migration in that order`
  - `a reported finding fails the start and is logged`
  - `user collection documents without userId keep their owner after
    migration` (Review Focus 3, data half). PG via PGlite, if the repo
    already has a PG test path; otherwise use a fake provider that applies
    `migrateRagMetadata`.
  - `requests before migration get 503`
  - `deploy-hdi-tables dry run lists all six artifacts`: run
    `tools/deploy-hdi-tables.sh --dry-run` and check that the output names
    `RAG_DOCUMENTS`, `RAG_COLLECTIONS`, `rag_roles`,
    `rag_role_assignments`, `rag_collection_roles` and
    `rag_session_bindings`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The `FILES=(...)` line in
  `deploy-hdi-tables.sh` lists the six `.hdbtable` names from
  `hana-vector-rag/ddl`. Merge the shipped `.hdiconfig` entry with the
  usage one.
- [ ] **Step 4: Verify.**
  - Run the full jest suite, typecheck and lint.
  - Run `npm run build`.
  - Expected: all pass.
- [ ] **Step 5: Commit.**
  `feat(startup): migrate RAG data before traffic; HDI ships access tables`

---

**After the plan, outside this plan:**
- release the hub;
- deploy to POC (snapshot, HANA export, deploy-hdi-tables, deploy, check
  the migration log, E19 checks of the Review Focus cases).

Each step needs its own "так".
