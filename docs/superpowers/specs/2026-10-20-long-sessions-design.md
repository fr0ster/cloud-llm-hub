# Long sessions — design

**Status:** draft for review
**Date:** 2026-10-20
**Repo:** cloud-llm-hub (branch `feat/long-sessions` off `feat/persistent-rag-collections`)

## 1. Intent

A hub session today is a cookie (`clh_session`) plus some state held in the process: chat history,
session RAG collections, the session's current destination, and gatekeeper retention. Each HTTP
request opens its own ABAP connection and closes it at the end (`srv/lib/request-connection.ts`,
`safeStop`). Two consequences make many planned features impossible:

- **Nothing on the ABAP side lives longer than one HTTP request.** The coming ABAP debugger in
  mcp-abap-adt (listener, breakpoints, stepping) and object locks need one stateful ADT context across
  many requests and many LLM turns.
- **A session does not survive the hub.** After `cf restart` the hub does not recognise the presented
  cookie and issues a new session (verified on HANA: `s-9280d6cb…` before, `s-b838084b…` after). The
  turns stored in HANA by the persistent-RAG work are then never reached. Clients that keep no cookies
  (API clients, LLM clients reaching the hub through our agent MCP) never keep a session at all.

The model is the one mcp-abap-adt already uses for MCP over HTTP: the service issues a long session key
when a connection starts, and every later request presents it and is served from the same pooled state,
whichever HTTP connection it arrives on.

## 2. Goals

1. **Session key.** The hub issues a long session key. The session is keyed, as today, by
   (userId from the token, session key), so a key presented by another user reaches nothing.
2. **Registry in memory.** The working registry of sessions lives in the process.
3. **One live ABAP connection per session.** A session holds one ABAP connection between requests:
   one stateful ADT context, its CSRF token and its app-server pin. Debugger state and locks belong to
   it. Requests of the session are served through it instead of a per-request connection.
4. **TTL from last activity.** Every request or tool call in the session extends it. A session idle
   past its TTL is closed.
5. **Correct close on the ABAP side.** Closing a session (explicitly, by TTL, at shutdown) ends
   the stateful context, stops the debugger listener, releases locks and sends the ICF logoff.
6. **Session record for crash cleanup.** When a persistent store is configured, every open session
   has a record, created at open and deleted at a correct close. The record holds the ABAP connection
   identifiers needed to close that ABAP session later: the cookie jar (`SAP_SESSIONID*`,
   `sap-contextid`, `sap-usercontext`), the app-server pin (`saplb`), client, destination; plus the
   hub-session data needed for revival (owner, created, last activity, TTL, current destination).
7. **Revival of the hub session after a crash; the ABAP session is only closed.** A client that
   presents its key before the TTL runs out gets its hub session back: same key, its chat history,
   its session collections, its destination. The hub first closes the old ABAP session with the
   stored identifiers and the credential of this request (once the library supports it, §6), then
   opens a new ABAP session with the
   same credential and destination and stores its identifiers. The client is told that debugger
   state and locks were lost. "Session not found" from SAP when closing the old one counts as closed.
8. **Cleanup of unclaimed sessions.** A record whose TTL runs out with no client back: the hub tries
   to close its ABAP session when a working credential of the same user on the same destination is
   available. If that never happens, the record is deleted and logged; SAP's own timeout takes the
   ABAP session.
9. **Closed means gone.** When a session ends for good (explicit close or TTL), its chat history
   (memory and persistent store) and its session collections are deleted. Nothing moves into a user's
   history. A user who wants to keep something asks the agent to put the session log or conclusions
   into a user collection (`rag_add` exists; no new work).
10. **Destination switch keeps the conversation.** Switching the session's destination closes the old
    ABAP session and opens a new one; chat history and session collections stay. This changes today's
    behaviour (`Destination reconnect, clearing session history`).
11. **Channels.** Full functionality needs a session, and the OpenAI protocol carries none (every
    `/v1/chat/completions` request stands alone; only the token's userId is always there). So:
    - **Agent MCP (`/mcp/agent/stream/http`) is the default external channel.** Tools `session_open`
      (returns the key) and `session_close(session)`; tools that need a session take `session` as an
      argument; the tool descriptions tell the LLM to keep the key for the whole task, pass it in every
      call, and close the session when the task is done.
    - **Extended OpenAI-compatible protocol (WebUI, and any client that can set a header).** The client
      opens a session with an extension call (the HTTP form of `session_open`), gets the key, and sends
      it in `x-clh-session` with every `/v1/chat/completions` (and `/v1/messages`) request. It closes the
      session itself with the HTTP form of `session_close`: on reconnect (close the old one, open a new
      one) and when the chat is closed. Closing a browser tab is best-effort (`sendBeacon`); the TTL is
      the backstop. The WebUI keeps the key in localStorage, not a cookie.
    - **Plain mode is off by default.** By default `/v1/chat/completions` and `/v1/messages` accept only
      requests carrying the key of an open session; a request without one is refused with a message on
      how to connect (agent MCP or the extended protocol). A configuration switch turns plain mode on:
      requests without a key then work as today, per request, with no long session. The plain MCP
      (`/mcp/stream/http`) is off by default under its own switch.

## 3. Non-goals

- Continuing an ABAP session after a crash. The debugger listener is a long-poll in the process, lock
  release functions are in memory, and on the connectivity-proxy path the session is tied to the lost
  socket; none of it can be resumed.
- Several hub instances sharing sessions (one instance is assumed; see §6).
- Long sessions for plain OpenAI/Anthropic clients that cannot send the session header, and for the
  plain MCP (both off by default; §2.11).
- User-level history, automatic or optional. The BACKLOG item for it is dropped.
- Persisting credentials. SAP passwords and user JWTs are never stored.

## 4. Anti-goals

- A failed attach that silently becomes a new ABAP session presented as the old one.
- ABAP sessions left open on SAP by the hub's own crashes when a cleanup path existed.
- Session records hanging in the store with no TTL bound.
- A key that lets one user reach another user's session.

## 5. Constraints

- **CF file system is ephemeral.** After `cf restart` or a crash the container is new; a SQLite file
  there is gone. The record store is pluggable like the RAG backends: none (in-memory only, no crash
  cleanup), SQLite (local runs, Docker with a volume), HANA or PG (CF, the same bindings the RAG
  backends use).
- **Secrets in the record.** The ABAP cookies act as bearer tokens; the CSRF token and lock handles are
  secrets too. They are stored only for an open session and deleted with its record.
- **Credentials arrive per request** (`x-sap-login`/`x-sap-password`, or the user JWT for principal
  propagation). Every ABAP close after a crash waits for a request that carries one.
- **Library requirement (`@mcp-abap-adt/connection`).** Today there is no API to export a session's
  identifiers or to close a session from them: `GetSession` returns `session_state: null`, and on a
  rejected cookie the library logs in again silently (a new session). The hub needs from the library:
  (a) the identifiers of a live connection's session; (b) an operation that closes a session from given
  identifiers and a credential (stateless release, debugger listener stop, ICF logoff) without any
  re-login, reporting "already gone" honestly. The hub work for crash cleanup waits for this; goals
  1–5 and 9–11 do not.
- **Connectivity proxy path** (CF + Cloud Connector, no `SAP_SESSIONID`): the session lives on one
  pinned socket. Crash cleanup there is not possible; SAP's timeout applies.

## 6. Decided after the builder check

**Decided by the owner:**

- **Credentials on every request of a session.** Each request carries credentials, and they must match
  the ones the session's ABAP connection was opened with (same SAP login; same user behind the JWT).
  No credentials, or another SAP login: the request is refused. An expired JWT: the hub reconnects with
  the new one and says plainly that debugger state and locks were lost.
- **Delivery order.** The first delivery does not wait for the library requirement in §5: it ships
  long sessions, the record store and hub-session revival (history, session collections, destination),
  and after a crash the old ABAP session is left to SAP's timeout. Closing it from the stored
  identifiers is added when `@mcp-abap-adt/connection` provides the close operation.

**Decided by the author (open to change):**

- Header name `x-clh-session` (extended protocol), carrying the same value as the `clh_session` cookie.
- One TTL for the whole session, default 60 minutes of inactivity, configurable. It replaces the two
  separate TTLs today (chat session 30 minutes, session collections 24 hours).
- One hub instance. Several instances would need sticky routing or a shared registry; out of scope.
- A key presented after its session was closed (explicitly or by TTL) is refused with 404
  `SESSION_NOT_FOUND`, never revived; the client opens a new session (`session_open`).
- **A long session opens explicitly.** The agent-MCP tool `session_open`, or its HTTP form in the
  extended protocol, returns a key; only such a session holds an ABAP connection and a record. A request
  with no key stays per-request, as today (`safeStop` at the end), so no client can leak one stateful SAP
  session per request.
- **Requests of one session are serialised.** One stateful ADT context cannot serve two runs at once
  (locks, debugger). A second request queues behind the running one, using the existing per-session
  pipeline lease; the bounded wait and the refusal when the queue is full follow today's door rules.
- **Long sessions are pinned and never evicted** by the retention cap. They are bounded by their
  own caps (total and per user) and inactivity TTL; a new `session_open` beyond the cap is refused.
- **Revived history comes from the recall store.** The persistent session history (turns keyed by
  (userId, sessionId), with `createdAt`) is scanned for the owner and the in-memory window is rebuilt
  from its latest turns. Session collections are already durable and restored at startup; revival only
  makes the session known again.
- **Agent-MCP steps share the session.** `execute_step` calls with the same `session` share the ABAP
  connection and the chat history (no throwaway `agent-step-<uuid>` session). A call whose
  `destination` differs from the session's is refused with an error naming both; a switch is explicit
  (a separate call), never a side effect of one step.
- **The session header wins over the cookie.** When `x-clh-session` is present, the shared
  `clh_session` cookie is ignored. The user half of the key still comes from the token.

## 7. Left to the builder

- How the existing pieces (`sessionMiddleware`, `SessionRetention`, `session-store.ts`, the session
  collection lease, `request-connection.ts`) fold into one session object.
- Encryption of the stored cookies (key source), if any beyond the store's own protection.
- The record schema per backend, and whether it shares the RAG tables' layout or has its own.
- Exact tool schemas for `session_open` / `session_close` and which agent-MCP tools take `session`.
- WebUI changes in detail.
- Order of delivery, as long as crash cleanup waits for the library requirement in §5.
