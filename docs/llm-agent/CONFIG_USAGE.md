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
| `LLM_AGENT_TOOLS_RAG_BACKEND` | derived from `LLM_AGENT_RAG_TYPE` (today's behaviour) | `in-memory` \| `vector` \| `qdrant` for the tool-intent RAG class (`hana-vector` and `pg-vector` are refused at startup: the tool corpus on HANA/Postgres is a later project). `qdrant` does **not** translate queries (`vector` does — one LLM call per non-ASCII query); it relies on a multilingual embedder such as `bge-m3` |
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
| `LLM_AGENT_THROTTLE_MAX_WAIT_MS` | `20000` | The longest LLM-side `429` interval we wait out **when no door is configured**. Anything longer is reported with the number attached. Not applied once `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` is set: behind a door an admitted session waits exactly the interval the server named. A value that is not a whole number of milliseconds is refused at startup |
| `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` | unset | How many sessions may run a pipeline at once, across `/v1/chat/completions`, `/v1/messages` and `execute_step`. Unset: no door on the chat channels, and `execute_step` keeps its cap of two. Size it against the container's memory |
| `LLM_GATEKEEPER_QUEUE_LENGTH` | the capacity | How many callers may wait to be admitted — for a slot, for their own session, or for a retention place. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`. The queue passing three quarters is logged as pressure |
| `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` | unbounded | How many sessions may hold history and session collections. An idle one is evicted — history, collections and their files — to make room: first sessions no caller ever presented (a client keeping no cookie gets one per request), then the least recently used; a session with a pipeline or a RAG operation running is never evicted. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` and may not be smaller. With `/v1/rag/*` in use, set it above the capacity by the number of concurrent uploads |
| `LLM_AGENT_TEMPERATURE`, `LLM_AGENT_MAX_TOKENS` | provider defaults | Sampling parameters |
| `LLM_AGENT_MODE`, `LLM_AGENT_MAX_ITERATIONS` | see `agent-config.ts` | Agent loop behaviour |
| `LLM_AGENT_HISTORY_RECENCY_WINDOW` | see `agent-config.ts` | How much history reaches the model |
| `LLM_AGENT_MCP_ENDPOINT` | — | **Inert.** Read and logged, consumed by nothing |

All `LLM_GATEKEEPER_*` values: unset means off. A value that is not plain digits for a positive integer (`0x10`, `1e3`, ` 5` and `5.0` are refused) — or a combination the notes above forbid — stops `cds serve` before it listens, naming the variable. The values in force are logged at startup and returned in `Health()`.

`LLM_AGENT_STEP_REVIEW_ENABLED=false` switches off the honesty controller's
reviewer (`srv/agent-manager.ts`).

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

With `LLM_AGENT_PLAIN_API` off, `/v1/chat/completions` and `/v1/messages` answer a request outside a long session with 400 `SESSION_REQUIRED`: open one with `POST /v1/session` (body `{ "destination"?: string }`, answer 201 `{ session, ttlSeconds, destination }`) and send the key in `x-clh-session`; close it with `DELETE /v1/session` (or `POST /v1/session/close`, for `sendBeacon`). A key that names no open session is refused with 404 `SESSION_NOT_FOUND`; a header and a `clh_session` cookie naming different sessions with 400 `SESSION_KEY_CONFLICT`; an open beyond the caps with 429 `SESSION_LIMIT`. With `LLM_AGENT_PLAIN_MCP` off, `/mcp/stream/http` answers 404 `PLAIN_MCP_DISABLED`. With a session store, a key presented after a restart, within its TTL, gets its hub session back (history window, collections, destination) with `x-clh-session-notice: revived` on the first response; its ABAP session is new.

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
