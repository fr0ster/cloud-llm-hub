# SmartAgent Configuration

How cloud-llm-hub configures the agent. Everything here is read by
`srv/agent-config.ts`, which assembles a singleton config from `LLM_AGENT_*`
environment variables — there is no config file. The one thing a request can
change is the **model**: `/v1/chat/completions` passes `body.model` into
`getSmartAgent`, which hot-swaps it for every cached agent, not just the caller.
Provider and credentials are process-wide.

> **Rewritten against the code.** Earlier revisions documented a
> constructor-based agent with its own connect step and response shape. That API
> is gone: the agent is built by `SmartAgentBuilder` in `srv/agent-manager.ts`
> and reached through `getSmartAgent()`. See git history for the previous text.

## Where values come from

| Source | When |
|--------|------|
| `.env` in the repo root | Local development only — `srv/env-setup.ts` loads it when neither `VCAP_APPLICATION` nor `CF_INSTANCE_INDEX` is set |
| `.mtaext` parameters → `mta.yaml` → `cloud-llm-hub-srv.properties` | Deployed, for every variable `mta.yaml` declares |
| `cf set-env` | Deployed, for secrets `mta.yaml` deliberately does not declare — `LLM_AGENT_API_KEY` and `LLM_AGENT_BASE_URL` |

There is **no HTTP-header override** for provider credentials — headers naming
an LLM vendor or key are not read anywhere. SAP connection headers (`x-sap-*`)
are a different mechanism and do apply per request.

## Variables

### Logging

Logging applies to every deployment, including MCP-only. Configuration is
validated during environment bootstrap, before destinations initialise;
invalid levels or malformed comma-list entries fail startup.

| Variable | Default | Meaning / example |
|----------|---------|-------------------|
| `LLM_AGENT_LOG_LEVEL` | `info` | Default for hub CAP (`cds.log`) loggers: `error`, `warn`, `info`, or `debug`. For example, `warn` reduces routine hub output. |
| `LLM_AGENT_LOG_LEVELS` | empty | Comma-separated `name=level` overrides, for example `sap-cloud-sdk=error,smart-pipeline=warn,tool-rag=info`. Names other than `sap-cloud-sdk` are CAP logger ids. |

Set `LLM_AGENT_LOG_LEVELS: "sap-cloud-sdk=error"` in your `.mtaext` to silence
the SDK warning "You are connecting to an On-Premise system using basic
authentication..." while retaining SDK errors. The special name applies the
installed SDK's `setGlobalLogLevel` API to all SDK contexts (whose emitted
logger name is `sap-cloud-sdk-logger`); its level is independent of the CAP
default. Templates show this override. Restart/restage after changing logging
environment variables. For more detail in dialogue lifecycle logs, keep
`dialogue=info` when lowering the hub default, for example
`sap-cloud-sdk=error,dialogue=info`. Lifecycle logs contain task ids, workers,
goal sizes, states, durations and hashed session keys. They never contain goal text, task outputs or error text, since a goal may carry whatever the user typed.

| Variable | Default | Meaning |
|----------|---------|---------|
| `LLM_AGENT_PROVIDER` | `sap-ai-sdk` | `sap-ai-sdk`, `openai`, `anthropic` or `deepseek` |
| `LLM_AGENT_MODEL` | `gpt-4o-mini` | Model id; for SAP AI Core it must be deployed in AI Launchpad |
| `LLM_AGENT_API_KEY` | — | Non-SAP providers only. Set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_BASE_URL` | — | Non-SAP providers only. Also used for the embedder |
| `LLM_AGENT_RESOURCE_GROUP` | `default` | SAP AI Core resource group |
| `LLM_AGENT_MCP_DESTINATION` | empty | Default BTP destination; empty means LLM-only mode |
| `LLM_AGENT_RAG_TYPE` | `in-memory` | Legacy switch: `in-memory` is keyword-only; any other value takes the vector path. Still read — it is the default the per-class variables below fall back to |
| `LLM_AGENT_RAG_QUERY_K` | `5` in code, **`15` in `mta.yaml`** | Tools returned per query by the tool-intent RAG |
| `LLM_AGENT_EMBEDDER` | `sap-ai-core` if `LLM_AGENT_PROVIDER=sap-ai-sdk`, else `openai` | `sap-ai-core` \| `openai` \| `ollama`. Only accepted when at least one RAG class below is not `in-memory` |
| `LLM_AGENT_EMBEDDING_MODEL` | `text-embedding-3-small` (`ollama`: none — required) | Embedding model id |
| `LLM_AGENT_EMBEDDER_URL` | `openai`: `LLM_AGENT_BASE_URL`; `ollama`: `http://localhost:11434` | Embedder base URL |
| `LLM_AGENT_EMBEDDER_API_KEY` | `openai`: `LLM_AGENT_API_KEY` | Embedder API key. Secret — set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_TOOLS_RAG_BACKEND` | derived from `LLM_AGENT_RAG_TYPE` (today's behaviour) | `in-memory` \| `vector` \| `qdrant` for the tool-intent RAG class (`hana-vector` and `pg-vector` are refused at startup: the tool corpus on HANA/Postgres is a later project). Tool search waits for one helper-model call (approximately 1 s) that classifies and translates every request of at least 3 characters, English included, with no language heuristic, caching up to 500 results; history and collections use the original query |
| `LLM_AGENT_SESSION_RAG_BACKEND` | same as tools | `in-memory` \| `vector` \| `qdrant` \| `hana-vector` \| `pg-vector` for the session-history RAG class. A persistent kind keeps the history across restarts (see [Persistent RAG collections](#persistent-rag-collections)) |
| `LLM_AGENT_RAG_BACKEND` | derived from `LLM_AGENT_RAG_TYPE` | `in-memory` \| `vector` \| `qdrant` \| `hana-vector` \| `pg-vector` for user and session collections. `qdrant`, `hana-vector` and `pg-vector` persist them (see [Persistent RAG collections](#persistent-rag-collections)) |
| `LLM_AGENT_QDRANT_URL` | — | Required when any RAG class above is `qdrant` |
| `LLM_AGENT_QDRANT_API_KEY` | — | Secret — set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_QDRANT_PREFIX` | `cloud-llm-hub` | Prefix for Qdrant collection names. Deployments sharing one Qdrant must each use a distinct prefix. With persistence on `qdrant` it also prefixes each collection's store (`<prefix>_c_<sha40>`) and the history store (`<prefix>_h_history`); letters, digits, `_`, `-`, `.`, at most 200 characters, else the hub refuses to start |
| `LLM_AGENT_HANA_SERVICE` | the first `hana` binding | Name of the `hana` service binding in `VCAP_SERVICES` that `hana-vector` connects through. Credentials come from the binding, never from a variable |
| `LLM_AGENT_PG_URL` | — | Required when any RAG class is `pg-vector`. Address only (`postgres://host:port/db`) |
| `LLM_AGENT_PG_USER`, `LLM_AGENT_PG_PASSWORD` | — | `pg-vector` credentials. Secrets: set in `.env` (applied with `cf set-env`), never in `.mtaext`. A user without a password sends no credential at all: `LLM_AGENT_PG_USER` is then ignored, and `pg` falls back to `PGUSER` / `PGPASSWORD` / trust authentication. Set both or neither |
| `LLM_AGENT_PG_SCHEMA` | the library default | Schema holding the shared tables for `pg-vector` |
| `LLM_AGENT_DESTINATION_SOURCE` | `btp` | `btp` (Destination service) \| `env` (the Cloud SDK `destinations` variable — off-platform, where no Destination service is reachable) |
| `LLM_AGENT_CLASSIFIER_MODEL` | falls back to `LLM_AGENT_MODEL` | Optional cheaper model for classification |
| `LLM_AGENT_PLANNER_MODEL` | falls back to the main model (follows the WebUI selector) | Optional independent model for the dialogue planner; when set, the WebUI LLM selector changes only the executors |
| `LLM_AGENT_PLANNER_KNOWLEDGE` | `planning` | Comma-separated persistent user collection names for planner guidance, at most 10 distinct names. Empty disables knowledge. Missing or unavailable collections are logged and skipped. Resolved for the session's user each time a dialogue opens, so newly created or replaced collections are picked up by new sessions. |
| `LLM_AGENT_THROTTLE_MAX_WAIT_MS` | `20000` | The longest LLM-side `429` interval we wait out **when no door is configured**. Anything longer is reported with the number attached. Not applied once `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` is set: behind a door an admitted session waits exactly the interval the server named. A value that is not a whole number of milliseconds is refused at startup |
| `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` | unset | How many sessions may run a pipeline at once, across `/v1/chat/completions`, `/v1/messages` and `execute_step`. Unset: no door on the chat channels, and `execute_step` keeps its cap of two. Size it against the container's memory |
| `LLM_GATEKEEPER_QUEUE_LENGTH` | the capacity | How many callers may wait to be admitted — for a slot, for their own session, or for a retention place. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`. The queue passing three quarters is logged as pressure |
| `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` | unbounded | How many sessions may hold history and session collections. An idle one is evicted — history, collections and their files — to make room: first sessions no caller ever presented (a client keeping no cookie gets one per request), then the least recently used; a session with a pipeline or a RAG operation running is never evicted. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` and may not be smaller. With `/v1/rag/*` in use, set it above the capacity by the number of concurrent uploads |
| `LLM_AGENT_TOOL_RESULT_MAX_CHARS` | `60000` | Non-negative integer character cap per model-visible MCP tool result, including local dialogue RAG tools. `0` disables. Oversized serialized text is cut at the cap, followed by a paging notice; error status is preserved. Recording stores the capped result and truncation lengths. Content-free truncation logs use `tool-result-cap`. |
| `LLM_AGENT_MAX_TOOL_CALLS` | unset (library default: `30`) | Positive integer per-run tool-call budget for workers, checkers, planner and agent MCP. Calls over the budget receive error results. Empty or unset preserves the library default. |
| `LLM_AGENT_CONTEXT_CAPTURE` | `off` | `off` or `stats`: one content-free `context-capture` info line per LLM call, after completion (including failures). Counts messages/characters by role, tool results and definitions; records the three largest tool results by name/size, component, model, known task/session ids, and provider input/output tokens when supplied. Streaming calls log once when consumed or closed; no token estimates or message/tool content. |
| `LLM_AGENT_TEMPERATURE`, `LLM_AGENT_MAX_TOKENS` | provider defaults | Sampling parameters |
| `LLM_AGENT_SAP_RELEVANCE_SCORE` | `0.48` | Minimum top non-skill tool score for SAP relevance; validated in `0..1` |
| `LLM_AGENT_MODE`, `LLM_AGENT_MAX_ITERATIONS` | see `agent-config.ts` | Agent loop behaviour |
| `LLM_AGENT_HISTORY_RECENCY_WINDOW` | see `agent-config.ts` | How much history reaches the model |
| `LLM_AGENT_MCP_ENDPOINT` | — | **Inert.** Read and logged, consumed by nothing |

All `LLM_GATEKEEPER_*` values: unset means off. A value that is not plain digits for a positive integer (`0x10`, `1e3`, ` 5` and `5.0` are refused) — or a combination the notes above forbid — stops `cds serve` before it listens, naming the variable. The values in force are logged at startup and returned in `Health()`.

`LLM_AGENT_STEP_REVIEW_ENABLED=false` switches off the honesty controller's
reviewer (`srv/agent-manager.ts`).

`LLM_AGENT_SAP_RELEVANCE_SCORE` (default `0.48`, range `0..1`) is the minimum top non-skill tool retrieval score that marks a request as SAP-related for step review. SAP identifiers also qualify. The LLM critic runs only for SAP requests without tool calls or anomalous executor completion token counts (outside mean +/- two standard deviations over the last 50 steps per model, after 20 steps). The deterministic check always runs unless `LLM_AGENT_STEP_REVIEW_ENABLED=false`.

## Long sessions

A hub session holds an ABAP connection between requests under a server-issued key. These variables bound it. Unset means the default; a value that is not plain digits for a positive integer, a per-user cap above the total, or an unknown store stops `cds serve` before it listens, naming the variable. The values in force are logged at startup (`Long-session configuration`).

| Variable | Default | Meaning |
|----------|---------|---------|
| `LLM_AGENT_SESSION_TTL_MS` | `3600000` (1 h) | Idle time before a session expires |
| `LLM_AGENT_MAX_SESSIONS` | `50` | Sessions held at once, all users |
| `LLM_AGENT_MAX_SESSIONS_PER_USER` | `5` | Sessions one user may hold; not above the total |
| `LLM_AGENT_SESSION_QUEUE` | `2` | Callers that may wait for a session slot |
| `LLM_AGENT_SESSION_STORE` | follows `LLM_AGENT_SESSION_RAG_BACKEND` | `none`, `sqlite`, `hana-vector` or `pg-vector`. With a `hana-vector` or `pg-vector` session backend that kind, otherwise `none` |
| `LLM_AGENT_SESSION_STORE_PATH` | `.data/sessions.db` | File of the `sqlite` store |
| `LLM_AGENT_PLAIN_API` | off | `true` allows plain (session-less) calls on the HTTP API; any other value is off |
| `LLM_AGENT_PLAIN_MCP` | off | `true` allows plain calls on MCP; any other value is off |

One TTL covers the whole session: the long session, its chat history and its session collections.

With `LLM_AGENT_PLAIN_API` off, `/v1/chat/completions` and `/v1/messages` answer a request outside a long session with 400 `SESSION_REQUIRED`: open one with `POST /v1/session` (body `{ "destination"?: string }`, answer 201 `{ session, ttlSeconds, destination }`) and send the key in `x-clh-session`; close it with `DELETE /v1/session` (or `POST /v1/session/close`, for a client that cannot send `DELETE`, such as `sendBeacon`). The key also comes back in the `clh_session` cookie; when both are present, `x-clh-session` wins and the cookie is ignored. An unknown key in the header is refused with 404 `SESSION_NOT_FOUND`; an unknown key in the cookie is ignored. An open beyond the caps is refused with 429 `SESSION_LIMIT`, a request behind a full session queue with 429 `SESSION_BUSY`. Every request of a session opened with SAP credentials must carry the same SAP login (and client); another login is refused with 403 `SESSION_CREDENTIAL_MISMATCH`, none with 401 `SAP_CREDENTIALS_REQUIRED`. A changed JWT of the same user opens a new ABAP session, announced with `x-clh-session-notice: abap_session_renewed` (debugger state and locks are lost). With `LLM_AGENT_PLAIN_MCP` off, `/mcp/stream/http` answers 404 `PLAIN_MCP_DISABLED`. With a session store, a key presented after a restart, within its TTL, gets its hub session back (history window, collections, destination) with `x-clh-session-notice: revived` on the first response; its ABAP session is new, and the old one is left to SAP's own timeout until `@mcp-abap-adt/connection` can close a session from its identifiers. A revival asked for before the store is ready is refused at once with 503 `SESSION_STORE_UNAVAILABLE` and `Retry-After: 5`. A key whose session was closed or expired is never revived.

`LLM_AGENT_SESSION_TTL_MS`, `LLM_AGENT_SESSION_STORE`, `LLM_AGENT_PLAIN_API` and `LLM_AGENT_PLAIN_MCP` are `mta.yaml` parameters (empty reads as unset); the caps, the queue and the path are environment-only, like `LLM_GATEKEEPER_*`.

## Persistent RAG collections

With `LLM_AGENT_RAG_BACKEND` set to `hana-vector`, `pg-vector` or `qdrant`, user and session RAG collections live in that database through the `@mcp-abap-adt/llm-agent` providers (shared table layout on HANA and Postgres). `LLM_AGENT_SESSION_RAG_BACKEND` does the same for the session history. With neither set to a persistent kind, nothing described here applies and the hub behaves as before.

Design: [persistent RAG collections spec](../superpowers/specs/2026-10-19-persistent-rag-collections-design.md). Deployment of the HANA container: [DEPLOY_GUIDE.md](../deployment/DEPLOY_GUIDE.md#persistent-rag-on-hana).

**Vector dimension.** On HANA and Postgres the hub configures 1536: the shipped HDI tables declare `REAL_VECTOR(1536)`, which matches `text-embedding-3-small`. The library checks the tables lazily, on each store's first operation, not at hub startup, and the hub does not stop over it: tables of another dimension make every collection restore as `unavailable` and writes are refused with `SHARED_LAYOUT_NOT_DEPLOYED`. An embedder of another width passes that check (the tables are 1536 wide) and every write and search then fails with `INVALID_VECTOR` (502 on writes). There is no fallback to memory in either case; another embedder needs regenerated DDL. The startup log line `Persistent collections` shows the configured dimension (`1536`, or `from the embedder` on Qdrant).

**One backend.** When `LLM_AGENT_RAG_BACKEND` is a persistent kind, every new user or session collection uses it. A request `backend` naming anything else is refused with 400, and `GET /rag/backends` lists only that backend. Presets (`preset: true`) stay in process memory, together with their enabled flag. A write to a preset (documents, enabled, rename, delete) while the restore is not ready waits for it, because a restored collection under the same id replaces the preset: the write lands on what the restore leaves under that id, or is refused with 503.

**Backend first.** Add, update, delete, `rag_correct`, `rag_deprecate`, rename, description and enabled writes go to the database first; memory changes only after it succeeded. A failure is an explicit error and leaves memory untouched, so no response reports a change a restart would undo.

| Status | Cause |
|--------|-------|
| 409 | Duplicate name, an orphan store under that name, a collection being deleted, or a collection restored as `incompatible` |
| 503 | Collections not restored yet: the restore failed, or is still running after the 30 s a request waits for it ("restore still in progress"); or a collection restored as `unavailable` |
| 502 | Any backend failure on an operation, an unreachable backend included |
| 400 | `backend` in the request differs from the configured persistent kind |

**Restore at startup.** Collections are read back from the catalog before the registry serves persistent operations. Only records the hub wrote (`writtenBy: cloud-llm-hub`) are opened; others are left alone. If the whole restore fails, `GET /health` answers 503 and a background retry runs after 30 s, doubling up to 5 min, each attempt logged. `/health` answers 200 `{"status":"UP"}` once restored, and also whenever persistence is off. One collection failing to open or scan is restored as `unavailable` (the others work). A collection written with a different embedder is restored as `incompatible`: it can be listed, read and exported, while search and writes name both embedder fingerprints in the error. A chat turn that names an incompatible or unavailable collection is refused (409 / 503) before anything streams.

While the restore has failed (or is still running past the wait), presets stay usable: `GET /rag/collections` and `POST /rag/presets/ensure` answer 200 with the presets only and `collectionsUnavailable` naming the cause, and a chat whose `rag_collections` are all presets goes on; a chat naming any other collection gets 503. Removing a session in that time (logout, clear chat, eviction) is recorded, and the restore then deletes that session's collections instead of bringing them back.

**Documents.** The metadata keys `id`, `namespace`, `collectionId`, `docId`, `createdAt` and `_createdAtMs` belong to the hub; the hub's values win over the same keys supplied by a client.

**Session collections** persist too and expire after the session TTL (`LLM_AGENT_SESSION_TTL_MS`, default 1 h, counted from their last use). `RAG_SESSION_TTL_MS` still overrides it for collections only; it is deprecated. The hourly sweep removes expired ones from memory and from the catalog; the collections of an open long session are left to the session, which deletes them when it closes.

**Session history** with a persistent `LLM_AGENT_SESSION_RAG_BACKEND` is stored in the store `h_history` (`<prefix>_h_history` on Qdrant), created on first use. Recall is scoped to the asking conversation by `userId` and `sessionId`. Forgetting a session deletes its turns by `userId` and `sessionId`; each owner is capped at 200 turns (the oldest are deleted). After a failed open the hub waits 30 s before trying again and logs one warning per window.

**Not logged:** stores or rows with no catalog record (orphans) are not reported at startup, because the library has no listing for them and the hub does not issue SQL itself. A creation under an orphan's name is refused with 409. An upstream request is in [BACKLOG.md](../rfcs/BACKLOG.md).

## Scenario A — SAP AI Core

```yaml
parameters:
  LLM_AGENT_MODEL: "anthropic--claude-4.5-sonnet"
  LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"

resources:
  - name: cloud-llm-hub-ai-core
    active: true
```

Credentials arrive through the service binding in `VCAP_SERVICES`; no key is set
by hand.

## Scenario B — external provider

```yaml
parameters:
  LLM_AGENT_PROVIDER: "openai"
  LLM_AGENT_MODEL: "gpt-4o"
  LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"
```

then, after deploying:

```bash
cf set-env cloud-llm-hub-srv LLM_AGENT_API_KEY  "<your-api-key>"
cf set-env cloud-llm-hub-srv LLM_AGENT_BASE_URL "https://api.openai.com/v1"
cf restart cloud-llm-hub-srv
```

`mta.yaml` declares neither of those two, so a value placed in `.mtaext` is
dropped silently.

Native Anthropic and DeepSeek work the same way, with one caveat: the embedder
is built against the **same** base URL as chat, and neither serves an
OpenAI-compatible `/embeddings`. Set `LLM_AGENT_RAG_TYPE: "in-memory"` for those,
which makes tool selection keyword-only.

## See also

- `srv/agent-config.ts` — the single place these variables are read
- [ARCHITECTURE.md §12](../architecture/ARCHITECTURE.md) — per-variable semantics
- [Installation Plan](../deployment/INSTALLATION_PLAN.md) — which of these a deployment actually needs

Tool retrieval measurement defaults to untranslated queries. Set `TOOL_RAG_MEASURE_TRANSLATE=1`
when running `npx tsx tools/measure-tool-rag.ts` to measure production tool-query translation.

### Chat coordinator

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_AGENT_CHAT_COORDINATOR` | `adaptive` | Chat coordinator: `adaptive` plans per request; `fixed` restores the previous one-step DAG; `dialogue` selects the long-session dialogue planner. Unset or empty selects `adaptive`; other values reject startup. |
| `LLM_AGENT_DIALOGUE_EXECUTORS` | `3` | Maximum concurrent background tasks (executor and checker) and pooled ABAP connections per dialogue session (positive integer). |
| `LLM_AGENT_DIALOGUE_EXECUTOR_POOL` | `6` | Hub-wide concurrent dialogue background tasks, including checker tasks (positive integer). |
| `LLM_AGENT_DIALOGUE_MAX_CORRECTIONS` | `2` | Maximum end-of-turn corrective turns (nonnegative integer); `0` disables corrections. |
| `LLM_AGENT_DIALOGUE_TASK_OUTPUT_CHARS` | `60000` (library default) | Maximum retained characters per task output; positive safe integer. Unset or blank uses the library default; invalid values reject startup. |
| `LLM_AGENT_DIALOGUE_MAX_TASKS` | `50` | Maximum task records per dialogue session (positive integer); persistence validates against this configured limit. |
| `LLM_AGENT_DIALOGUE_FOLLOW_MAX_MS` | `1800000` | Maximum streaming follow duration in milliseconds (30 minutes); positive safe integer. Unset or blank uses the default; malformed values reject startup. |
| `LLM_AGENT_DIALOGUE_WAIT_TICK_MS` | `30000` (library default) | Non-negative safe integer; 0 disables live wait ticks. Unset or blank uses the library default; invalid values reject startup. |
| `LLM_AGENT_DIALOGUE_LONG_TASK_MS` | `300000` (library default) | Non-negative safe integer; 0 disables long-running task wakes. Unset or blank uses the library default; invalid values reject startup. |
| `LLM_AGENT_PLAN_MAX_STEPS` | library: `20` | Optional positive integer step limit. |
| `LLM_AGENT_PLAN_MAX_REVISIONS` | library: `3` | Optional positive integer revision limit. |
| `LLM_AGENT_PLAN_MAX_DURATION_MS` | library: `300000` | Optional positive integer duration limit in milliseconds. |

Opt in with `LLM_AGENT_CHAT_COORDINATOR=dialogue`. Only long-session requests use the dialogue planner; requests without a long session fall back to adaptive and return `x-clh-coordinator: adaptive`. The hard-mode planner uses the shared main LLM (`LLM_AGENT_MODEL`), control tools and background executor/checker subagents; it has no retrieval or skills sources of its own. Each session has a connection factory refreshed by dialogue chat requests and a bounded connection pool; credentials remain in memory. Executor, pool and task limits default to 3 / 6 / 50 when unset or blank and otherwise require positive safe integers written as decimal digits; malformed values reject startup.

Streaming dialogue responses send pending messages before the new reply, then follow the outbox after releasing session and pipeline admission when a plan exists. Follow ends on a settled plan that is done, waiting for the user, or idle (no active turn, queued inputs, running tasks or ready steps), after sending its pending messages. An ordinary reply without a plan has no follow. Disconnect, a new request in the same session, or `LLM_AGENT_DIALOGUE_FOLLOW_MAX_MS` also ends follow; the limit counts from follow start and does not cancel background work. The limit note is `still running: <done> of <total> steps done`, or `still running` without steps. A superseded response ends with `A new message arrived; the work continues in its response.`

Delivery is at least once, keyed by message ID, even when an SSE subscriber is present. A later chat request without `x-clh-ack` confirms the contiguous pending prefix carried by successfully completed responses. Sending `x-clh-ack: none` or `x-clh-ack: <id>` permanently switches that session to explicit acknowledgement mode; `none` confirms nothing, and an ID confirms through that message only where ended deliveries carried the prefix. Unknown IDs confirm nothing. Failed or disconnected responses confirm nothing. Non-streaming responses concatenate pending messages and the reply with blank lines and expose the last included ID in `x-clh-last-message`; they do not follow. With a persistent session store, unconfirmed messages and acknowledgement mode survive restart, but delivery records do not, so messages may be delivered again. Clients should deduplicate by ID.

Both streaming protocols frame complete messages with SSE comments `: message-id <id>` before the first delta and `: message-end <id>` after the last. One `: turn-end` marks the end of the request's planner turn before follow; it is not the response terminal. Messages use blank-line separators without a planner prefix. Limit and supersede notes are outside message framing. For dialogue streaming requests (a long session with a resolved destination), the stream opens at once and keep-alives start then, including queue waits before agent initialization/admission, and repeat every 10 seconds; other streaming requests keep today's timing. Refusals before stream opening retain HTTP status responses; later errors use the protocol's stream error form without a success terminal.

`GET /v1/session/events` is a read-only view of retained complete messages (confirmed and pending), plans and tasks; it never confirms delivery. Its deprecated `POST /v1/session/events/ack` route returns 204 after ownership/mode checks and changes nothing. The channel's 15-second heartbeat keeps the session alive. The WebUI renders each ID once across chat and SSE, replaces partial segments with complete versions, sends `x-clh-ack: none` initially (also after reload) and then the last complete ID per session, and sends no SSE acknowledgements. It unlocks input at `: turn-end`, allowing corrections during follow; response notes render as separate system lines.

Running dialogue work holds the session against inactivity expiry; releasing the hold touches it. Close/TTL ends tasks and deletes state; shutdown preserves the last saved state on HANA/PostgreSQL for lazy revival, with queued/running tasks marked interrupted and no restored credentials until the next dialogue chat request. Adaptive remains the default, and the agent MCP `execute_step` path is unchanged. See [Dialogue planner architecture](../architecture/ARCHITECTURE.md#dialogue-planner-two-pipelines-and-background-tasks) for context, persistence limits and event semantics.

Unset or blank budget fields remain undefined so the library applies its defaults. Values must otherwise be positive safe integers written as decimal digits; malformed values reject startup. Budgets apply to adaptive execution; elapsed time is checked between steps, not as a timeout on planning or an in-flight worker call. These settings apply to the chat path; `execute_step` retains its existing behavior. Run records keep only the latest run per authenticated user and session, with each step output limited to 4000 characters. With a HANA or PG session store they use the dedicated `h_runs` hub store; otherwise they stay in memory, bounded by `LLM_AGENT_MAX_SESSIONS`. Run-record load/save requires a matching trusted request session and authenticated user; requests without either keep no run record. Both Anthropic paths forward the trusted session. Closing, forgetting or expiring a session deletes its owner-scoped run record, including plain-session history expiry. Records also expire after `LLM_AGENT_SESSION_TTL_MS` from their save time; memory saves sweep expired records. Persistent h_runs records are swept at startup and every minute by the session cleanup timer, including records left by previous processes. Sweeps run in the background with failure logging and leave malformed rows intact with a warning.

Planning and revision route every check targeting a worker other than self to the checker; work steps keep their assigned worker. Checker workers are verification-only: request-local enforcement filters out write tools and rejects attempted writes before the MCP adapter, even for developers. Effect checks are independent of exposition-based role permissions. MCP read-only/destructive annotations take precedence, then read/check name prefixes and the installed RunUnitTest/RunATC family are allowed. The installed RuntimeGetDumpById, RuntimeGetProfilerTraceData, RuntimeGetGatewayErrorLog, RuntimeListFeeds, RuntimeListProfilerTraceFiles and RuntimeListSystemMessages evidence readers are also allowed; runtime execution remains blocked. Executor steps retain their normal permissions. No new setting is required.

### Tool gate

| Variable | Default | Meaning |
|----------|---------|---------|
| `LLM_AGENT_TOOL_GATE` | `classifier` | A confident negative closes the gate in smart mode; `off`, hard mode and `execute_step` always keep tools and skills. |
| `LLM_AGENT_TOOL_GATE_TIMEOUT_MS` | `4000` | Positive integer deadline in milliseconds for factory creation plus chat; invalid values warn and use 4000. Timeout keeps tools. |

`LLM_AGENT_TOOL_GATE` defaults to `classifier`; `off` always offers tools and skills: the same single call still classifies and translates, but its decision is ignored. The first tool search of a request of at least 3 characters waits for this call, English included; English is returned verbatim and all other languages, including transliteration, are translated without a language heuristic. Shorter requests skip the call and keep tools. One call per request; later re-selection searches in the same request reuse its decision and search untranslated. Concurrent first searches share the pending decision in request scope, independent of session identity. Hard mode (`LLM_AGENT_MODE=hard`) always keeps tools and skills. `LLM_AGENT_TOOL_GATE_TIMEOUT_MS` bounds factory creation plus chat (default 4000 ms, positive integer; invalid values warn and use the default). Timeout or external abort keeps tools and the original text, is not cached, and clears pending analysis so the next request retries; underlying chat is aborted where supported. With `classifier`, a confident decision that the ABAP system is unnecessary removes tools and skills. Any doubt or error keeps them, and `execute_step` always bypasses the gate. Other values are rejected.

Unexpired run records count as retention state even without chat history, preserving plain Anthropic sessions across release. The synchronous owner/session index uses the record save timestamp and session TTL; reads do not extend it. Provider save/load populates the index, while deletion and expiry remove entries.

### Usage analytics

Recording is off by default. Set `LLM_AGENT_USAGE=on` to store resource statistics with session and request context. Records contain numbers, labels and flags, excluding messages, documents, SAP data, tool arguments and results, credentials and tokens. User IDs are hashed by default. The transport is always `direct`.

The default sink follows `LLM_AGENT_SESSION_STORE`: `hana-vector` selects `hana`, `pg-vector` selects `pg`, and `sqlite` or `none` selects `sqlite`. `LLM_AGENT_USAGE_SINKS` overrides this choice and can select several sinks. An explicit sink without its configured backend fails startup.

| Setting | Default | Meaning |
|---|---|---|
| `LLM_AGENT_USAGE` | `off` | `on` enables recording |
| `LLM_AGENT_USAGE_SINKS` | from the session store (above) | comma list of `hana`, `pg`, `sqlite`, `jsonl`, `memory` |
| `LLM_AGENT_USAGE_MEASURE` | `all` | comma list of `llm`, `embedding`, `tool`, `task`, `session`, `request`, `storage`, `process` |
| `LLM_AGENT_USAGE_SQLITE_PATH` | `usage.sqlite` in the app's working directory | SQLite file |
| `LLM_AGENT_USAGE_JSONL_PATH` / `LLM_AGENT_USAGE_JSONL_ROTATE_BYTES` | (unset) / `104857600` | JSONL file and rotation |
| `LLM_AGENT_USAGE_MEMORY_LIMIT` | `100000` | records kept by the `memory` sink |
| `LLM_AGENT_USAGE_PROCESS_INTERVAL_MS` | `30000` | process snapshot interval |
| `LLM_AGENT_USAGE_STORAGE_INTERVAL_MS` | `600000` | storage snapshot interval |
| `LLM_AGENT_USAGE_RETENTION_DAYS` | `90` | retention |
| `LLM_AGENT_USAGE_USER_ID` | `hash` | `hash` or `plain` |

SQLite on the container disk is lost on every restart, restage, redeploy or instance move. Disk quota and retention bound the file. If `node:sqlite` is unavailable, the hub logs the failure, reports it in status and falls back to bounded memory.

Before using HANA, deploy the usage table and indexes into the shared HDI container with `bash tools/deploy-hdi-tables.sh <hdi-service-name>`; `--dry-run` previews the operation. The script also deploys the vector-store tables. Automatic schema creation is disabled. When the usage table is missing, recording uses a bounded memory buffer that never evicts: full buffers reject new batches, and the recorder accounts for losses in stored `x.usage.lost` records. Every five minutes the hub checks again, copies buffered records idempotently to HANA, and switches only after the complete copy succeeds. Failed copies keep the buffer for a later retry.

Retention runs at startup and daily on configured database sinks that support deletion. Memory is bounded by its record limit; JSONL is bounded by rotation.

`GET /v1/usage/status` requires `MCP_Admin`, independently of tool roles and session resolution. It reports configured sinks, fallback state, buffered/delivered/unconfirmed/lost counts, the last error code and SQLite file size. Recording off returns 404.

An administrator with `MCP_Admin` can open `https://<approuter-host>/v1/usage/sqlite` in a browser after signing in to download a consistent SQLite copy. The existing authenticated `/v1/*` approuter route forwards the download. This option exists only for SQLite because the instance disk is ephemeral; there is no general REST export. Recording off, no active SQLite sink, or memory fallback returns 404.

Each CF instance has its own file. Download from each instance before restarting, using the backend application route and `X-CF-APP-INSTANCE` with its app GUID (from `cf app <app-name> --guid`) and instance index:

```sh
curl --fail --show-error \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-CF-APP-INSTANCE: $APP_GUID:0" \
  -OJ "https://<backend-app-host>/v1/usage/sqlite"
```

Use a token carrying `MCP_Admin`; repeat for each index. Browser downloads through the approuter select an instance through normal routing; use the targeted backend request above to retrieve every instance. Files are named `usage-<instance>-<UTC yyyyMMddTHHmmssZ>.sqlite` and can be opened locally with SQLite tools.

### Session collection search toggle

`PATCH /v1/rag/collections/:id/enabled` with `{ "enabled": false }` and the current session header (`x-clh-session`, or the session cookie) changes only that user's session. `GET /v1/rag/collections` returns `enabled` (effective session state) and `defaultEnabled`. Use `{ "enabled": false, "scope": "default" }` to edit the default with the existing owner/admin permissions. Without a session, PATCH and GET retain default behavior.

Session overrides take precedence over collection defaults. They are deleted with session state. Long sessions persist overrides in their session record (SQLite/HANA/PG as configured) and restore them with the destination and history after restart; plain sessions keep overrides in memory, like their destination state.

Dialogue chat does not run request-level collection retrieval or inject retrieved context into planner calls. Workers use RAG tools and the planner uses `[planning knowledge]`, both respecting session toggles and record policy. The upload endpoint returns `documentIds`; clients send the current message?s chunk IDs as `attachment_document_ids` alongside `rag_collections: ["uploads"]`. Selecting the collection alone does not attach earlier files. Explicit `uploads` attachments are read directly without embeddings or semantic search and passed only to the current planner turn, bounded to 16,000 characters and 100 records with a preview notice; workers can read the remaining records. Other coordinators retain request retrieval. Request retrieval uses enabled collections; `rag_collections` and `X-Rag-Collections` only narrow that set, including an explicit empty list. A request explicitly selecting its session `uploads` collection can use attached files for that request. Planner knowledge checks enablement on every search, so the next turn observes a toggle. Tool selection and built-in skills use separate tool/skill stores rather than these user collections. Executor history remains session memory. Explicit RAG tools are unchanged: `rag_list` can read a disabled collection when the caller has read access; add/correct/deprecate retain their existing permissions.

### Request time

Each agent receives the request time in its context. The hub captures HTTP/MCP arrival time once and reuses it across agent calls and retries. Dialogue planner and workers use the dialogue request's persisted openedAt timestamp; planner content wrappers preserve the single session-provided line.

Set `LLM_AGENT_TIME_ZONE` to an IANA time zone such as `Asia/Tbilisi`. Unset or blank uses the library default `UTC`. Invalid values reject startup. This deployment setting applies to all SmartAgent configurations and dialogue sessions; clients cannot override it.
