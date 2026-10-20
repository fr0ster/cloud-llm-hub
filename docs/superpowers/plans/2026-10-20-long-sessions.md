# Long Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hub session with a server-issued key that holds one ABAP connection between requests, lives until it is closed or idle past its TTL, and is revived from a session record after a hub restart.

**Architecture:** A new in-memory `LongSessionRegistry` owns sessions (key, owner, TTL, per-session queue, held ABAP connection). A pluggable `SessionRecordStore` (none / SQLite / the HANA or PG RAG provider) keeps one record per open session for revival. The session key *is* the hub `sessionId`, so history, session collections and the destination keep their existing keys. Channels: agent MCP (`session_open`/`session_close`, `session` argument), the extended OpenAI-compatible protocol (`POST`/`DELETE /v1/session`, header `x-clh-session`); plain OpenAI/Anthropic/MCP use is off by default.

**Tech Stack:** TypeScript, CAP/Express, Jest (ts-jest), `@mcp-abap-adt/*` 30.3.1, `node:sqlite` (Node ≥ 22.13), PGlite for PG tests.

**Spec:** `docs/superpowers/specs/2026-10-20-long-sessions-design.md`

## Global Constraints

- Branch `feat/long-sessions`; commits GPG-signed, never `--no-gpg-sign`.
- Session key format: `ls-<uuid v4>`; it is used as the hub `sessionId` everywhere.
- Header `x-clh-session`; cookie `clh_session` carries the same value; both present and different → 400 `SESSION_KEY_CONFLICT`.
- Session keyed by (userId from the token, key); another user's key resolves to nothing (404 `SESSION_NOT_FOUND`).
- TTL from last activity, one setting `LLM_AGENT_SESSION_TTL_MS`, default `3600000` (60 min).
- Caps: `LLM_AGENT_MAX_SESSIONS` default `50`, `LLM_AGENT_MAX_SESSIONS_PER_USER` default `5`; beyond → 429 `SESSION_LIMIT`.
- Per-session queue: one running request, at most `LLM_AGENT_SESSION_QUEUE` waiting (default `2`); beyond → 429 `SESSION_BUSY`.
- Plain mode: `LLM_AGENT_PLAIN_API=true` lets `/v1/chat/completions` and `/v1/messages` run without a key (today's behaviour); default off → 400 `SESSION_REQUIRED`. `LLM_AGENT_PLAIN_MCP=true` enables `/mcp/stream/http`; default off → 404 `PLAIN_MCP_DISABLED`.
- Record store: `LLM_AGENT_SESSION_STORE` = `none` | `sqlite` | `hana-vector` | `pg-vector`; empty = the session RAG backend when it is `hana-vector`/`pg-vector`, else `none`. `LLM_AGENT_SESSION_STORE_PATH` for SQLite, default `.data/sessions.db`.
- Credentials are never stored. The record holds owner, key, createdAt, lastActivity, ttlMs, destination — nothing secret in this delivery (ABAP identifiers wait for the library, spec §6).
- Credential binding (spec §6, owner): every SAP-reaching request of a session carries credentials matching the binding (basic: SAP login + client; JWT: the token's user id). Missing → 401 `SAP_CREDENTIALS_REQUIRED`; other login → 403 `SESSION_CREDENTIAL_MISMATCH`; same user, new JWT → reconnect, response notice `abap_session_renewed`.
- Closed means gone: close (explicit, TTL) deletes history (memory + recall store), session collections, destination, record, and closes the ABAP connection. Shutdown releases ABAP connections only and keeps records (revival after `cf restart`).
- Destination switch keeps history and session collections; only the ABAP connection is replaced.
- Windows: run npm scripts with `npm_config_script_shell="C:/Program Files/Git/bin/bash.exe"`; single test: `npx jest <path>`; type-check `npx tsc --noEmit`.

## Review Focus

1. A request carrying a key whose session was closed a moment ago, while a request of that session is still running: the running one finishes, the new one gets 404 `SESSION_NOT_FOUND`, nothing is revived from a record already deleted. (Task 5 test `closed key is not revived`.)
2. Hub restart with a record whose TTL already passed: no revival, record deleted, 404. (Task 5 test `expired record is dropped, not revived`.)
3. Two parallel `execute_step` calls with one `session`: the second waits for the first, never shares the connection concurrently. (Task 6 test `execute_step calls of one session run one after another`.)
4. A held connection must never pass through `safeStop` in any finally/error branch of the four channels; a test per channel asserts the held connection is not closed after the request. (Task 4.)
5. Record store write volume: activity updates the record at most once per minute per session. (Task 3 test `touch writes the record at most once a minute`.)

---

### Task 1: Session configuration

**Files:**
- Create: `srv/lib/session-config.ts`
- Modify: `mta.yaml` (parameters + srv properties), all six `docs/deployment/templates/*.mtaext.template`, `test/unit/mta-config-params.test.ts` (`NEW` list), `docs/llm-agent/CONFIG_USAGE.md` (new "Long sessions" section), `srv/agent-config.ts` (startup log line only)
- Test: `test/unit/session-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SessionStoreKind = 'none' | 'sqlite' | 'hana-vector' | 'pg-vector';
  export interface SessionConfig {
    ttlMs: number; maxSessions: number; maxPerUser: number; queueLength: number;
    store: SessionStoreKind; storePath: string; plainApi: boolean; plainMcp: boolean;
  }
  export function loadSessionConfig(env?: NodeJS.ProcessEnv, sessionBackend?: string): SessionConfig;
  export function sessionConfig(): SessionConfig;      // cached, reads getAgentConfig().rag.backends.session
  export function clearSessionConfig(): void;          // test seam
  ```
- mta.yaml carries `LLM_AGENT_SESSION_TTL_MS`, `LLM_AGENT_SESSION_STORE`, `LLM_AGENT_PLAIN_API`, `LLM_AGENT_PLAIN_MCP` (default `""`); the caps, queue and path stay env-only like `LLM_GATEKEEPER_*`.

- [ ] **Step 1: Write the failing tests** in `test/unit/session-config.test.ts`:
  - `defaults`: `loadSessionConfig({}, 'vector')` → `{ ttlMs: 3600000, maxSessions: 50, maxPerUser: 5, queueLength: 2, store: 'none', storePath: '.data/sessions.db', plainApi: false, plainMcp: false }`.
  - `store follows a persistent session backend`: `loadSessionConfig({}, 'hana-vector').store === 'hana-vector'`, same for `pg-vector`; `'qdrant'` → `'none'`.
  - `explicit store wins`: `{ LLM_AGENT_SESSION_STORE: 'sqlite' }` with `'hana-vector'` → `'sqlite'`.
  - `malformed numbers throw`: `LLM_AGENT_SESSION_TTL_MS: '10m'` throws `/LLM_AGENT_SESSION_TTL_MS/`; `LLM_AGENT_MAX_SESSIONS_PER_USER: '0'` throws.
  - `per-user cap above total throws`: `MAX_SESSIONS=2, MAX_SESSIONS_PER_USER=3` throws.
  - `unknown store throws`: `LLM_AGENT_SESSION_STORE: 'qdrant'` throws `/LLM_AGENT_SESSION_STORE/`.
  - `plain switches`: `'true'` → true; any other value → false.
- [ ] **Step 2:** `npx jest test/unit/session-config.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement with the same strict digit parsing as `readPositiveInt` in `srv/lib/gatekeeper-config.ts:23`. Call `sessionConfig()` in `bootstrap` right after `gatekeeperConfig()` (`srv/server.ts:350`) so a bad value stops startup, and add `describe`-style values to the startup log in `srv/agent-config.ts:570`.
- [ ] **Step 4:** Add the four mta parameters, the template lines (commented, like the RAG block), the `NEW` entries; `npx jest test/unit/session-config.test.ts test/unit/mta-config-params.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(session): long-session configuration`.

### Task 2: LongSessionRegistry

**Files:**
- Create: `srv/lib/long-session.ts`
- Test: `test/unit/long-session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CloseReason = 'explicit' | 'ttl' | 'shutdown';
  export interface CredentialBinding { kind: 'basic' | 'jwt' | 'none'; sapLogin?: string; sapClient?: string; jwtUser?: string; jwt?: string }
  export interface LongSession {
    readonly userId: string; readonly key: string; readonly createdAt: number;
    lastActivity: number; destination?: string; revived: boolean;
    connection?: IAbapConnection; dumpScope?: DumpScope; binding?: CredentialBinding;
  }
  export type OpenRefusal = { refused: 'SESSION_LIMIT' };
  export type RunRefusal = { refused: 'SESSION_BUSY' | 'SESSION_CLOSED' };
  export interface LongSessionHooks {
    onClose(s: LongSession, reason: CloseReason): Promise<void>;   // ABAP close, state delete, record delete
    onTouch?(s: LongSession): void;                                  // record write (throttled by the store)
  }
  export class LongSessionRegistry {
    constructor(cfg: Pick<SessionConfig, 'ttlMs' | 'maxSessions' | 'maxPerUser' | 'queueLength'>, hooks: LongSessionHooks, now?: () => number);
    open(userId: string, init: { destination?: string; key?: string; createdAt?: number; revived?: boolean }): LongSession | OpenRefusal;
    get(userId: string, key: string): LongSession | undefined;        // no touch; undefined when closing/closed
    has(userId: string, key: string): boolean;
    run<T>(s: LongSession, fn: () => Promise<T>): Promise<T | RunRefusal>; // FIFO per session; touches before and after
    close(userId: string, key: string, reason: CloseReason): Promise<void>; // waits for the running fn; idempotent
    sweep(): Promise<number>;                                          // closes sessions idle > ttlMs, reason 'ttl'
    closeAll(reason: CloseReason): Promise<void>;
    size(userId?: string): number;
  }
  export function longSessions(): LongSessionRegistry;               // process singleton, built from sessionConfig()
  export function setLongSessionsForTest(r: LongSessionRegistry | undefined): void;
  export function newSessionKey(): string;                           // `ls-${randomUUID()}`
  ```
  `open` with `key` is the revival path (Task 5); without it a new key is minted.

- [ ] **Step 1: Write the failing tests** (fake clock `let t = 0; const now = () => t`; hooks record calls):
  - `open mints ls- keys and enforces caps`: with `maxSessions: 2, maxPerUser: 1`, second open by the same user → `{ refused: 'SESSION_LIMIT' }`; another user → ok; third user → refused.
  - `get is scoped by user`: `get('bob', aliceKey)` → undefined.
  - `run serialises one session`: two `run` calls with deferred fns; the second fn starts only after the first resolves (record order `['a-start','a-end','b-start']`).
  - `run refuses beyond the queue`: `queueLength: 1`, one running + one waiting, third `run` → `{ refused: 'SESSION_BUSY' }` without calling fn.
  - `sweep closes idle sessions only`: ttl 1000; touch at t=500 via run; t=1400 → sweep closes none; t=1600 → closes it with reason `'ttl'`, `onClose` called once.
  - `close waits for the running request and is idempotent`: close during a run resolves after the run; second close does not call `onClose` again; `get` returns undefined from the moment close starts; a `run` queued behind gets `{ refused: 'SESSION_CLOSED' }`.
  - `closeAll('shutdown')` calls `onClose` for every session with `'shutdown'`.
  - `a throwing onClose still removes the session`.
- [ ] **Step 2:** `npx jest test/unit/long-session.test.ts` → FAIL.
- [ ] **Step 3:** Implement. The queue is a per-session promise chain with a waiting counter; `onTouch` is called on `open` and at the start of every `run`.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(session): in-memory long-session registry`.

### Task 3: Session record store

**Files:**
- Create: `srv/lib/session-record-store.ts`
- Modify: `srv/lib/collection-persistence.ts` (restore at :689 and `expiredSessions` at :649 skip the record store, like `isHistoryRecord` at :884)
- Test: `test/unit/session-record-store.test.ts`, `test/unit/session-record-store.pg.test.ts` (PGlite via `test/unit/helpers/pglite.ts`)

**Interfaces:**
- Produces:
  ```ts
  export interface SessionRecord { userId: string; key: string; createdAt: number; lastActivity: number; ttlMs: number; destination?: string }
  export interface SessionRecordStore {
    put(r: SessionRecord): Promise<void>;
    touch(r: SessionRecord): Promise<void>;          // writes only if lastActivity moved ≥ 60000 ms since the last write of that key
    get(userId: string, key: string): Promise<SessionRecord | undefined>;
    delete(userId: string, key: string): Promise<void>;
    list(): Promise<SessionRecord[]>;
  }
  export class SqliteSessionRecordStore implements SessionRecordStore { constructor(path: string) }
  export class ProviderSessionRecordStore implements SessionRecordStore { constructor(provider: IRagProvider, opts: { storePrefix?: string; dimension: number; log?: { warn(m: string, d?: unknown): void } }) }
  export const SESSION_RECORD_STORE_NAME = 'h_sessions';
  export function isSessionRecordStore(rec: RagCollectionRecord, storePrefix?: string): boolean;
  export function createSessionRecordStore(cfg: SessionConfig, rag: RagConfig): SessionRecordStore | undefined; // undefined for 'none'
  ```
- SQLite: `node:sqlite` `DatabaseSync`, loaded with a dynamic import so Node without it fails only when `sqlite` is selected (error names `LLM_AGENT_SESSION_STORE=sqlite` and the Node version). Table `sessions(user_id TEXT, key TEXT, record TEXT, PRIMARY KEY(user_id, key))`; the directory of `path` is created.
- Provider: one cataloged store `h_sessions` created/adopted the way `ensureHistoryStore` (`collection-persistence.ts:905`) creates `h_history`; record id `session:<key>`; JSON in the document text; metadata `{ userId, sessionId: key }`; written with `upsertPrecomputedRaw` and a zero vector of `dimension` (1536) — no embedder call; `get`/`list` via `scan` (filter `{ userId, sessionId }` for get); `delete` via `deleteByIdRaw`. The provider's constructor needs an embedder: `createSessionRecordStore` passes a stub `IRetrievalEmbedder` whose methods throw `session records are never embedded`.

- [ ] **Step 1: Write the failing tests** — one shared contract run against SQLite (temp file) and PGlite:
  - `put then get round-trips`; `get for another user → undefined`.
  - `delete removes it; list returns the rest`.
  - `touch writes the record at most once a minute`: spy on the underlying write; touches at +10 s and +50 s write nothing, +61 s writes once.
  - `restore ignores the record store`: with a provider holding `h_sessions`, `CollectionRegistry` restore reports `foreign: 0` and does not list it (use the setup of `test/unit/collection-restore-startup.test.ts`).
  - `createSessionRecordStore` returns undefined for `'none'`, a `SqliteSessionRecordStore` for `'sqlite'`.
- [ ] **Step 2:** run both files → FAIL.
- [ ] **Step 3:** Implement; skip predicate added next to `isHistoryRecord`.
- [ ] **Step 4:** → PASS (`npx jest test/unit/session-record-store.test.ts test/unit/session-record-store.pg.test.ts test/unit/collection-restore-startup.test.ts`).
- [ ] **Step 5:** Commit `feat(session): session record store (SQLite, HANA/PG provider)`.

### Task 4: Session-held ABAP connection

**Files:**
- Create: `srv/lib/session-connection.ts`
- Modify: `srv/lib/request-connection.ts` (export the credential reading it already does as `readRequestCredential`), `srv/openai-handler.ts`, `srv/anthropic-handler.ts` (every `safeStop(requestConnection)` → `releaseRequestConnection`)
- Test: `test/unit/session-connection.test.ts`; update `test/unit/openai-channel.test.ts`, `test/unit/anthropic-channel.test.ts`

**Interfaces:**
- Consumes: `LongSession` (Task 2), `establishRequestConnection(req, res, destination?)` and `safeStop` (`srv/lib/request-connection.ts:79,:246`).
- Produces:
  ```ts
  export function readRequestCredential(req: Request): CredentialBinding;   // request-connection.ts
  export type SessionConnectionResult =
    | { connection: IAbapConnection; dumpScope?: DumpScope; handled: false; notice?: 'abap_session_renewed' }
    | { handled: true };                                                 // 401/403 already written
  export function acquireSessionConnection(s: LongSession, req: Request, res: Response, destination: string): Promise<SessionConnectionResult>;
  export function releaseRequestConnection(connection: IAbapConnection | undefined, s?: LongSession): Promise<void>; // no-op when s holds it, else safeStop
  export function dropSessionConnection(s: LongSession): Promise<void>;   // safeStop the held one, clear connection/binding
  ```
- Rules: no held connection → `establishRequestConnection`, store connection, dumpScope and `readRequestCredential(req)` as the binding. Held → compare: kind `basic` needs the same `sapLogin` and `sapClient`; `jwt` needs the same `jwtUser`; a different `jwt` with the same user → `dropSessionConnection` then establish again, `notice: 'abap_session_renewed'`; no credential → 401 `SAP_CREDENTIALS_REQUIRED` (same JSON shape as `request-connection.ts` writes today); different login/user → 403 `SESSION_CREDENTIAL_MISMATCH`. `destination !== s.destination` → `dropSessionConnection` first (destination switch).
- Chat handlers: when `req.longSession` (set by Task 5's middleware) exists, the handler body runs inside `longSessions().run(s, …)` (refusal → 429 `SESSION_BUSY` / 404 `SESSION_NOT_FOUND` JSON), uses `acquireSessionConnection`, and in every finally/error branch calls `releaseRequestConnection(conn, s)`. The notice goes out as response header `x-clh-session-notice`.
- Destination switch block (`openai-handler.ts:666-713`): no `clearSession`, no `deleteSessionCollections`, no reset of `normalizedMessages`; it keeps `setSessionDestination`. This applies with and without a long session (spec goal 10).

- [ ] **Step 1: Write the failing tests**:
  - session-connection: `first acquire establishes and binds`; `second acquire with the same login reuses the connection (establish called once)`; `another SAP login → 403 SESSION_CREDENTIAL_MISMATCH, connection kept`; `no credential → 401 SAP_CREDENTIALS_REQUIRED`; `same JWT user, new token → reconnect with notice abap_session_renewed, old one safeStopped`; `destination change drops the held connection and establishes a new one`; `releaseRequestConnection does not stop a held connection`, `stops an unheld one`.
  - openai-channel / anthropic-channel: `a long-session request leaves its connection open after the response` (safeStop mock not called with it, for success, model error and admission refusal); `destination switch keeps server history and session collections` (replaces the test that asserted clearing).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx jest test/unit/session-connection.test.ts test/unit/openai-channel.test.ts test/unit/anthropic-channel.test.ts test/unit/openai-admitted-state.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(session): ABAP connection held by the session`.

### Task 5: Session middleware, HTTP open/close, revival, plain-mode switch

**Files:**
- Modify: `srv/session-id.ts` (header support; update the no-header policy comment), `srv/lib/session-middleware.ts`, `srv/lib/gatekeeper.ts` (`sessionIsLive` also true for `longSessions().has`), `srv/lib/session-retention.ts` (optional `isPinned(u,s)` in `RetentionStores`; pinned entries are never eviction candidates), `srv/lib/session-history-rag.ts` (`listTurns`), `srv/server.ts` (routes, CORS `:618-629` adds `x-clh-session`, shutdown hook `:822`, sweep timer), `srv/rag-handler.ts` (`:280` message mentions the header)
- Create: `srv/lib/session-lifecycle.ts` (the registry hooks and revival)
- Test: `test/unit/session-middleware.test.ts`, `test/unit/session-lifecycle.test.ts`, `test/unit/session-history-rag.test.ts`, `test/unit/session-retention.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```ts
  // session-id.ts
  export const SESSION_HEADER = 'x-clh-session';
  export function resolveSessionKey(req): { key?: string; conflict: boolean };   // header vs cookie
  // session-history-rag.ts
  listTurns(owner: string): Promise<{ id: string; userText: string; assistantText: string; createdAt: string }[]>; // oldest first; [] without a scanner
  // session-lifecycle.ts
  export function lifecycleHooks(records?: SessionRecordStore): LongSessionHooks;
  export function openSession(userId: string, destination?: string): Promise<LongSession | OpenRefusal>;   // registry.open + records.put
  export function resolveSession(userId: string, key: string): Promise<LongSession | undefined>;           // live, or revived from a record
  export function startSessionSweep(intervalMs?: number): () => void;                                     // default 60000; also deletes expired records
  ```
- `onClose(s, reason)`: `dropSessionConnection(s)`; if reason ≠ `'shutdown'`: `await deleteSession(s.userId, s.key)` (retention close → `deleteSessionState` → history incl. `forgetOwner`, destination, session collections) and `records.delete`. `'shutdown'` keeps state and the record.
- Revival (`resolveSession` miss): `records.get` → none, or `lastActivity + ttlMs < now` (then `records.delete`) → undefined. Else `registry.open(userId, { key, createdAt, destination, revived: true })`, `setSessionDestination`, rebuild the window: `listTurns(turnOwner(userId, key))` → last `SESSION_MAX_MESSAGES / 2` turns → `appendToSession(key, userId, user, assistant)` pairs; response header `x-clh-session-notice: revived`.
- Middleware on `/v1`: conflict → 400 `SESSION_KEY_CONFLICT`; key → `resolveSession`; found → `req.sessionId = key`, `req.sessionMinted = false`, `req.longSession = s`; not found → 404 `SESSION_NOT_FOUND` (body says to open a new session). No key → today's minting, kept for plain mode and for the session routes.
- Routes: `POST /v1/session` body `{ destination?: string }` → 201 `{ session, ttlSeconds, destination }`, sets the `clh_session` cookie to the key (so `sendBeacon` can close it); 429 `SESSION_LIMIT`. `DELETE /v1/session` and `POST /v1/session/close` (beacon form): a long session → `registry.close(…, 'explicit')`, 204; otherwise today's `deleteSession`.
- Plain mode: `/v1/chat/completions` and `/v1/messages` without `req.longSession` and with `sessionConfig().plainApi === false` → 400 `SESSION_REQUIRED` (message names `POST /v1/session` and the agent MCP). `/mcp/stream/http` with `plainMcp === false` → 404 `PLAIN_MCP_DISABLED`.
- Startup: build the registry with `lifecycleHooks(createSessionRecordStore(...))`, `startSessionSweep()`; `cds.on('shutdown')` → `longSessions().closeAll('shutdown')` before `shutdownGatekeeper()`.
- `SESSION_TTL_MS` unification: `session-store.ts:20` and `rag-collections.ts:66` read `sessionConfig().ttlMs`; `RAG_SESSION_TTL_MS` stays as an override for collections only, documented as deprecated.

- [ ] **Step 1: Write the failing tests**:
  - middleware: `header and cookie disagree → 400 SESSION_KEY_CONFLICT`; `known key → req.sessionId is the key, sessionMinted false`; `key of another user → 404 SESSION_NOT_FOUND`; `no key → minted as before`.
  - lifecycle (fake records, fake clock): `open writes a record`; `explicit close deletes history, collections, destination and the record` (spies on `deleteSession`, `records.delete`); `ttl close does the same`; `shutdown keeps the record and the history`; `revival restores destination and the history window` (records + `listTurns` stub with 3 turns → `getSessionHistory` has 6 messages, notice `revived`); `expired record is dropped, not revived`; `closed key is not revived` (close, then `resolveSession` → undefined although a stale record existed before close).
  - history: `listTurns returns an owner's turns oldest first and parses User/Assistant text` (persistent store from `test/unit/session-history-persistent.test.ts` setup).
  - retention: `a pinned entry is never evicted`.
  - routes: `POST /v1/session → 201 with ls- key and cookie`; `SESSION_LIMIT → 429`; `chat without key in default mode → 400 SESSION_REQUIRED`; `plain mode on → today's behaviour`; `/mcp/stream/http default → 404 PLAIN_MCP_DISABLED`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx jest` (full suite) → PASS; update tests that assumed plain mode by setting `LLM_AGENT_PLAIN_API=true` in their setup rather than changing their assertions.
- [ ] **Step 5:** Commit `feat(session): open, close, revive; plain mode off by default`.

### Task 6: Agent MCP sessions

**Files:**
- Modify: `srv/agent-mcp.ts`, `srv/server.ts` (`/mcp/agent/stream/http` route unchanged except error mapping)
- Test: `test/unit/execute-step-channel.test.ts`, create `test/unit/agent-mcp-session-tools.test.ts`

**Interfaces:**
- Consumes: `openSession`, `resolveSession`, `longSessions().run/close`, `acquireSessionConnection`, `releaseRequestConnection`.
- Produces tools:
  - `session_open` `{ destination?: string }` → text JSON `{ session, ttlSeconds, destination }`; on limit an MCP error result naming `SESSION_LIMIT`.
  - `session_close` `{ session: string }` → `{ closed: true }`; unknown → error result `SESSION_NOT_FOUND`.
  - `execute_step` `{ session?: string; destination?: string; task: string }`. With `session`: resolve (live or revived) for the caller's userId; `destination` given and ≠ session's → error result naming both; run inside `longSessions().run`; connection via `acquireSessionConnection` (replaces `buildConnectionForDestination` on this path); `runWithSessionId(session, …)`; messages = `getSessionHistory(session, userId)` + the task; after the answer `appendToSession` and the recall write (move `recordTurnForRecall` from `openai-handler.ts:146` to `srv/lib/session-turns.ts` as `recordTurn(sessionId, userId, lastUser, answer)` and use it in both). traceId stays a separate `agent-step-<uuid>`. Without `session`: today's behaviour.
- `EXECUTE_STEP_DESCRIPTION` rewritten: with `session` the step continues the session's conversation and ABAP connection (debugger, locks); call `session_open` first for multi-step work, pass the key in every call, `session_close` when done; without `session` each call is independent as before.

- [ ] **Step 1: Write the failing tests**: `session_open returns an ls- key`; `session_close closes it (second close → SESSION_NOT_FOUND)`; `execute_step with session reuses one connection across two calls`; `execute_step calls of one session run one after another`; `execute_step with another destination than the session's → error naming both`; `execute_step with a session sees the previous step's turn in its messages`; `execute_step without session keeps the throwaway session`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx jest test/unit/agent-mcp-session-tools.test.ts test/unit/execute-step-channel.test.ts test/unit/openai-channel.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(agent-mcp): session_open, session_close, execute_step sessions`.

### Task 7: WebUI on the extended protocol

**Files:**
- Modify: `app/chat/webapp/index.html` (login gate `submitLoginGate` :430, `sendMessage` :1513-1545, `clearChat` :1352, LOGOUT :305, `ragFetch` :1878), `app/chat/webapp/util/StreamClient.js`, `app/chat/webapp/controller/Chat.controller.js:114`
- Test: `test/unit/webui-session.test.ts` (static checks on the HTML/JS, the pattern of existing UI tests if any; otherwise string assertions on the files)

**Behaviour:**
- After a successful connect: `POST /v1/session` with the destination; keep `session` in `localStorage['clh.session']`.
- Every `/v1/chat/completions`, `/v1/rag/*` and `/v1/session` call sends `x-clh-session`.
- `404 SESSION_NOT_FOUND` → open a new session once, show "Сесію перезапущено", retry the message once.
- Reconnect (the `SAP_CREDENTIALS_REQUIRED` re-open of the login gate) and CLR: `DELETE /v1/session`, then open a new one.
- LOGOUT: `DELETE /v1/session` before clearing storage.
- `pagehide`: `navigator.sendBeacon('/v1/session/close')` (cookie carries the key).
- Notice header `x-clh-session-notice`: `revived` → "Сесію відновлено після перезапуску сервісу"; `abap_session_renewed` → "З'єднання з SAP оновлено: стан відладки та локи втрачено".
- UI5 variant (`StreamClient.js`): opens a session on the first chat and sends the header; `Chat.controller.js` clear → DELETE with the header.

- [ ] **Step 1:** Write the failing test asserting: `index.html` contains `x-clh-session`, `sendBeacon('/v1/session/close'`, `method: 'POST'` to `/v1/session`, and handles `SESSION_NOT_FOUND`; `StreamClient.js` sends `x-clh-session`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; open the UI locally with `npm run dev:local` if it runs, otherwise note it as verified on the deployment (Task 8).
- [ ] **Step 5:** Commit `feat(webui): long sessions over the extended protocol`.

### Task 8: Docs, deploy and verify (controller only, user go-ahead required)

**Files:**
- Modify: `docs/llm-agent/CONFIG_USAGE.md`, `docs/architecture/API_REFERENCE.md` (session routes, header, error codes), `docs/rfcs/BACKLOG.md` (drop the user-level history item; add "ABAP close after a crash — waits for `@mcp-abap-adt/connection` close-from-identifiers"), `CHANGELOG.md` (breaking: plain API and plain MCP off by default)
- Create: `docs/superpowers/verification/2026-10-20-long-sessions-hana.md`

- [ ] **Step 1:** Docs as listed; `npm run docs:check`.
- [ ] **Step 2:** Merge into the test subaccount's deployment branch, deploy with `tools/deploy.sh` (its `.mtaext` unchanged; store follows `hana-vector`).
- [ ] **Step 3:** Verify on the test subaccount with an on-premise ABAP system (technical SAP user, credentials in headers): agent MCP `session_open` → two `execute_step` calls share history; `cf restart`; the same key → revived, history recalled; `session_close` → key gives 404; WebUI: connect, chat, restart, notice "revived"; plain `/v1/chat/completions` without key → 400 `SESSION_REQUIRED`.
- [ ] **Step 4:** Record results; commit `docs: long sessions`.
