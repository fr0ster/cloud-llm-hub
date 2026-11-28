# SmartAgent Configuration

How cloud-llm-hub configures the agent. `srv/agent-config.ts` assembles the
agent configuration primarily from `LLM_AGENT_*` environment variables. Tool
retrieval also reads CAP configuration files through `cds.env`. A request can
set the main model:
`/v1/chat/completions` passes `body.model` into
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

## Tool retrieval

| Config key | Environment variable | Default |
|------------|----------------------|---------|
| `toolRetrieval.strategy` | `LLM_AGENT_TOOL_RETRIEVAL` | `rag` |
| `toolRetrieval.model` | `LLM_AGENT_TOOL_RETRIEVAL_MODEL` | Unset |

Each environment variable overrides its corresponding CAP configuration key
independently. Set the keys under `toolRetrieval` in `.cdsrc.json`, or under
`cds.toolRetrieval` in `package.json`.

`rag` uses the existing tool search. `llm` sends the step and the
role-filtered candidate names, descriptions, and input schemas to the
configured model through the Hub's LLM provider. The model is required for
`llm`, and the Hub rejects missing models or invalid strategies at startup.
An invalid selection ends the step with `TOOL_RETRIEVAL_INVALID`.
Token usage is attributed to `tool-retriever` and tracked by model.

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
| `LLM_AGENT_PROVIDER` | `sap-ai-sdk` | `sap-ai-sdk`, `sap-aicore-foundation`, `openai`, `anthropic` or `deepseek` |
| `LLM_AGENT_MODEL` | `gpt-4o-mini` for existing providers. Required for `sap-aicore-foundation` | Model ID. For `sap-aicore-foundation`, use the name of a running deployment's model. |
| `LLM_AGENT_API_KEY` | — | Non-SAP providers only. Set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_BASE_URL` | — | Non-SAP providers only. Also used for the embedder |
| `LLM_AGENT_RESOURCE_GROUP` | `default` | SAP AI Core resource group |
| `LLM_AGENT_MCP_DESTINATION` | empty | Default BTP destination; empty means LLM-only mode |
| `LLM_AGENT_RAG_TYPE` | `in-memory` | Legacy switch: `in-memory` is keyword-only; any other value takes the vector path. Still read — it is the default the per-class variables below fall back to |
| `LLM_AGENT_CLIENT_HISTORY` | `off` | `off`: earlier turns exclusively from session history RAG; current client turn and its tool loop only. `on`: earlier turns exclusively from consumer messages; history RAG is never retrieved. Both modes record completed turns. Invalid values fail startup with `BuildValidationError`. |
| `LLM_AGENT_RAG_QUERY_K` | `5` in code, **`15` in `mta.yaml`** | Complete session history turns per retrieval and legacy budget for other stores; tool collections use the budgets below |
| `LLM_AGENT_TOOLS_K_READER` | `5` | Reader collection seed tools per query; positive integer |
| `LLM_AGENT_TOOLS_K_WRITER` | `2` | Writer collection seed tools per query; positive integer. Write roles expand found object clusters within their allowed tools |
| `LLM_AGENT_TOOLS_SELECTION` | `step-kind` | `per-collection`: reader top-k plus writer clusters; `step-kind`: RO reader top-k, RW writer clusters, UNKNOWN union. Invalid values refuse startup. |
| `LLM_AGENT_EMBEDDER` | `sap-ai-core` for SAP AI Core providers, otherwise `openai` | `sap-ai-core` \| `openai` \| `ollama`. Only accepted when at least one RAG class below is not `in-memory` |
| `LLM_AGENT_EMBEDDING_MODEL` | `text-embedding-3-small`. Required for `ollama` and for `sap-ai-core` with `sap-aicore-foundation`. | Embedding model ID |
| `LLM_AGENT_EMBEDDING_COMPATIBLE_RESOURCE_GROUPS` | empty | Comma-separated previous SAP AI Core resource groups that used the same embedding model. The migration updates matching catalog fingerprints without re-embedding their vectors. |
| `LLM_AGENT_EMBEDDING_DIMENSION` | ? | Optional positive integer for Qdrant task-result vectors. Otherwise resolved once per provider/embedder from existing hub collections with the same embedder (dimensions must agree), then from one constant-text embedding probe. Target collection 404 is expected for a new session. HANA/Postgres retain 1536. |
| `LLM_AGENT_EMBEDDER_URL` | `openai`: `LLM_AGENT_BASE_URL`; `ollama`: `http://localhost:11434` | Embedder base URL |
| `LLM_AGENT_EMBEDDER_API_KEY` | `openai`: `LLM_AGENT_API_KEY` | Embedder API key. Secret — set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_TOOLS_RAG_BACKEND` | derived from `LLM_AGENT_RAG_TYPE` (today's behaviour) | `in-memory` \| `vector` \| `qdrant` for the tool-intent RAG class (`hana-vector` and `pg-vector` are refused at startup: the tool corpus on HANA/Postgres is a later project). Tool search waits for one helper-model call (approximately 1 s) that classifies and translates every request of at least 3 characters, English included, with no language heuristic, caching up to 500 results; history and collections use the original query |
| `LLM_AGENT_SESSION_RAG_BACKEND` | same as tools | `in-memory` \| `vector` \| `qdrant` \| `hana-vector` \| `pg-vector` for the session-history RAG class. A persistent kind keeps the history across restarts (see [Persistent RAG collections](#persistent-rag-collections)) |
| `LLM_AGENT_RAG_BACKEND` | derived from `LLM_AGENT_RAG_TYPE` | `in-memory` \| `vector` \| `qdrant` \| `hana-vector` \| `pg-vector` for user and session collections. `qdrant`, `hana-vector` and `pg-vector` persist them (see [Persistent RAG collections](#persistent-rag-collections)) |
| `LLM_AGENT_QDRANT_URL` | — | Required when any RAG class above is `qdrant` |
| `LLM_AGENT_QDRANT_API_KEY` | — | Secret — set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_QDRANT_PREFIX` | `cloud-llm-hub` | Prefix for Qdrant collection names. Deployments sharing one Qdrant must each use a distinct prefix. With persistence on `qdrant` it also prefixes each collection's store (`<prefix>_c_<sha40>`) and per-session history stores (`<prefix>_h_hist_<hash>`); letters, digits, `_`, `-`, `.`, at most 200 characters, else the hub refuses to start |
| `LLM_AGENT_HANA_SERVICE` | the first `hana` binding | Name of the `hana` service binding in `VCAP_SERVICES` that `hana-vector` connects through. Credentials come from the binding, never from a variable |
| `LLM_AGENT_PG_URL` | — | Required when any RAG class is `pg-vector`. Address only (`postgres://host:port/db`) |
| `LLM_AGENT_PG_USER`, `LLM_AGENT_PG_PASSWORD` | — | `pg-vector` credentials. Secrets: set in `.env` (applied with `cf set-env`), never in `.mtaext`. A user without a password sends no credential at all: `LLM_AGENT_PG_USER` is then ignored, and `pg` falls back to `PGUSER` / `PGPASSWORD` / trust authentication. Set both or neither |
| `LLM_AGENT_PG_SCHEMA` | the library default | Schema holding the shared tables for `pg-vector` |
| `LLM_AGENT_DESTINATION_SOURCE` | `btp` | `btp` (Destination service) \| `env` (the Cloud SDK `destinations` variable — off-platform, where no Destination service is reachable) |
| `LLM_AGENT_CLASSIFIER_MODEL` | falls back to `LLM_AGENT_MODEL` | Optional cheaper model for classification |
| `LLM_AGENT_COORDINATOR_MODEL` | unset; falls back to the planner model | Optional independent coordinator model; leaves the plan author on the planner model |
| `LLM_AGENT_PLANNER_MODEL` | falls back to the main model (follows the WebUI selector) | Optional model for the plan author and, by default, the coordinator; when set, the WebUI LLM selector changes only the executors |
| `LLM_AGENT_PROFILES_COLLECTION` | `agents` | Exact global agents collection id; lowercase letters, digits, underscores and hyphens; no normalization or `__` |
| `LLM_AGENT_PLANNER_RECORD` | `coordinator` | Exact coordinator record name (`coordinator-<variant>` also accepted); planner authors use `planner-create` and `planner-revise` |
| `LLM_AGENT_PROFILE_TIMEOUT_MS` | None (no timer) | Explicit positive integer opt-in preparation deadline. The library wraps whole planner/worker preparation, not only profile reads. Hub reads and compatibility preparation use caller cancellation; observed library deadline failures warn. |
| `LLM_AGENT_PLANNER_KNOWLEDGE` | `planning` | Comma-separated persistent user collection names for planner guidance, at most 10 distinct names. Empty disables knowledge. Missing or unavailable collections are logged and skipped. Resolved for the session's user each time a dialogue opens, so newly created or replaced collections are picked up by new sessions. |
| `LLM_AGENT_THROTTLE_MAX_WAIT_MS` | unset = wait as needed | Optional total wait ceiling in milliseconds, applied only without a gatekeeper door. Default `WaitAsNeeded` honors every `Retry-After` interval. Unnamed intervals use 2 s exponential backoff with 20% jitter and a 60 s maximum delay per wait. The quota gate shares waits across callers, and retries continue without an attempt cap until the caller aborts or the provider returns a different response. An explicit non-negative whole number selects `WaitIfShortEnough`. Invalid values fail startup. |
| `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` | unset | How many sessions may run a pipeline at once, across `/v1/chat/completions`, `/v1/messages` and `execute_step`. Unset: no door on the chat channels, and `execute_step` keeps its cap of two. Size it against the container's memory |
| `LLM_GATEKEEPER_QUEUE_LENGTH` | the capacity | How many callers may wait to be admitted — for a slot, for their own session, or for a retention place. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`. The queue passing three quarters is logged as pressure |
| `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` | unbounded | How many sessions may hold history and session collections. An idle one is evicted — history, collections and their files — to make room: first sessions no caller ever presented (a client keeping no cookie gets one per request), then the least recently used; a session with a pipeline or a RAG operation running is never evicted. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` and may not be smaller. With `/v1/rag/*` in use, set it above the capacity by the number of concurrent uploads |
| `LLM_AGENT_TOOL_RESULT_MAX_CHARS` | `off` | Set a positive integer to limit characters per model-visible MCP tool result, including local dialogue RAG tools. `0` also disables it. Oversized serialized results return an error with the tool name, result size, limit and advice to narrow the request. Recording stores the error and rejection metadata. Content-free warnings use `tool-result-cap`. |
| `LLM_AGENT_MAX_TOOL_CALLS` | off (unlimited) | Positive integer per-run tool-call budget for workers, checkers, planner and agent MCP. Calls over an explicit budget receive error results. Empty, unset or `off` disables the limit, overriding the library default. |
| `LLM_AGENT_CONTEXT_CAPTURE_FILE` | `context.sqlite` | Container-local full-context SQLite path, relative to the app directory. |
| `LLM_AGENT_CONTEXT_CAPTURE_MAX_MB` | `512` | Stop writing at this file size in MiB and warn once; no automatic deletion. |
| `LLM_AGENT_CONTEXT_CAPTURE` | `off` | `off`, `full` (SQLite; see Full LLM context capture below), or legacy `stats`: one content-free `context-capture` info line per LLM call, after completion (including failures). Counts messages/characters by role, tool results and definitions; records the three largest tool results by name/size, component, model, known task ids and salted session hashes, and provider input/output tokens when supplied. Streaming calls log once when consumed or closed; no token estimates or message/tool content. |
| `LLM_AGENT_TEMPERATURE` | Provider/model default | Unset uses the provider/model default; set a number to override; `off` explicitly omits the parameter. Applies to all LLM calls (including classifier and workers). Invalid values fail startup. |
| `LLM_AGENT_MAX_TOKENS` | Provider/model default | Optional positive integer output token limit, including for tool query analysis. The legacy `SAP_CORE_AI_MAX_TOKENS` is used when this setting is empty or unset. Session model metadata reports `off` when the hub supplies no limit. |
| `LLM_AGENT_SAP_RELEVANCE_SCORE` | deprecated | Ignored, including invalid values; no automatic LLM critic |
| `LLM_AGENT_MODE` | `smart` | Agent loop behaviour |
| `LLM_AGENT_MAX_ITERATIONS` | off (unlimited) | Positive integer tool-loop iteration limit; empty, unset or `off` disables it. |
| `LLM_AGENT_HISTORY_RECENCY_WINDOW` | Unset | With client history on, maximum recent client messages at assembly. Ignored with client history off. Zero keeps everything. |
| `LLM_AGENT_MCP_ENDPOINT` | — | **Inert.** Read and logged, consumed by nothing |

Prompt caching is on or off; it is on by default. `LLM_AGENT_PROMPT_CACHING=on|off` sets it for every hub LLM client (`true|false` are aliases). A role variable overrides the global value for that role; empty or unset values inherit, and invalid values fail startup with `BuildValidationError`. The hub only passes this switch to the provider. What the provider caches is the provider's own business.

| Environment variable | Default | Scope |
| --- | --- | --- |
| `LLM_AGENT_PROMPT_CACHING` | `on` | All LLM clients |
| `LLM_AGENT_COORDINATOR_PROMPT_CACHING` | Inherit global | Coordinator, including LLM-only chat |
| `LLM_AGENT_PLANNER_PROMPT_CACHING` | Inherit global | Plan author |
| `LLM_AGENT_EXECUTOR_PROMPT_CACHING` | Inherit global | Executors |
| `LLM_AGENT_CHECKER_PROMPT_CACHING` | Inherit global | Checkers |
| `LLM_AGENT_CLASSIFIER_PROMPT_CACHING` | Inherit global | Classifier and helper clients, including query analysis and translation |

Usage records keep cache reads (`cachedInputTokens`) and cache writes (`cacheCreationInputTokens`) per model. Context capture stores the cache reads in `cached_tokens`.

Set reasoning effort globally or per role. Empty or unset role values inherit the global value. If both are empty or unset, the model uses its default. The hub validates values against llm-agent's `REASONING_EFFORTS` at startup and passes the configured value to the provider. The provider and model determine which levels they support.

| Environment variable | Default | Scope |
| --- | --- | --- |
| `LLM_AGENT_REASONING_EFFORT` | Model default | All LLM clients |
| `LLM_AGENT_COORDINATOR_REASONING_EFFORT` | Inherit global | Coordinator, including LLM-only chat |
| `LLM_AGENT_PLANNER_REASONING_EFFORT` | Inherit global | Plan author |
| `LLM_AGENT_EXECUTOR_REASONING_EFFORT` | Inherit global | Executors |
| `LLM_AGENT_CHECKER_REASONING_EFFORT` | Inherit global | Checkers |
| `LLM_AGENT_CLASSIFIER_REASONING_EFFORT` | Inherit global | Classifier and helpers, including query analysis and translation |

Tool selection uses explicit read-only effects, independently of exposition permissions and retrieval backend. Defaults: `step-kind`, reader k=5, writer k=2. Only writer seeds expand object clusters; cluster members retain permission filtering. Without write rights both strategies return readers only. The analyzer returns strict `writes` in its existing call; missing or invalid responses mean UNKNOWN. `per-collection` ignores step kind; `step-kind` uses it and adds no independent reader seeds to RW.

The session history router embeds text-only vector queries independently, so coordinator history recall does not create or vectorize a tools store. Keyword history works without an embedder. Queries wait for pending writes from other calls; a query inside a write for the same session reads committed history without waiting on itself.

`per-collection` always returns reader top-k plus writer top-k expanded into their object clusters. `step-kind` returns reader top-k without clusters for RO, writer top-k with clusters for RW, and their union for UNKNOWN. Scores only order results within each effect collection; the selection does not depend on the store, embedder, retrieval method or score scale.

The installed Core 23.1 definitions declare read-only effects with the literal `[read-only]` metadata tag. The hub normalizes this explicit declaration into MCP `annotations.readOnlyHint` before exposing tools through `listTools` and building the corpus; native annotations take precedence. A definition without either declaration is a writer. Older bundles reuse their unchanged text/vectors while receiving current effect and exposition metadata from definitions.

Baseline oracle evaluation on 91 cases (29 RO, 62 RW), with reader k=2 / writer k=1 and bge-m3 precomputed document vectors:

| Retrieval | Strategy | RO hits | RW hits | Total | RO avg/max tools | RW avg/max tools |
| --- | --- | --- | --- | --- | --- | --- |
| vector / bge-m3 | per-collection | 29/29 | 58/62 | 87/91 | 10.34 / 22 | 8.74 / 22 |
| vector / bge-m3 | step-kind | 27/29 | 58/62 | 85/91 | 2.00 / 2 | 8.37 / 21 |
| keyword only | per-collection | 28/29 | 50/62 | 78/91 | 11.66 / 22 | 9.73 / 21 |
| keyword only | step-kind | 27/29 | 50/62 | 77/91 | 2.00 / 2 | 9.08 / 21 |

The default is `step-kind` with reader k=5 and writer k=2, chosen from the 91-case bge-m3 vector evaluation: RO 29/29 with 5 tools; RW 61/62 with an average of 11.89 tools (90/91 total). Writer k=1 gives only 58/62 RW hits. The table above records the earlier reader k=2 / writer k=1 baseline. These are oracle step-kind measurements: the harness uses expected tool effects, without an LLM classification call.

For that 2/1 baseline across all 91 cases, average/maximum tools are 9.25/22 versus 6.34/21 with bge-m3, and 10.34/22 versus 6.82/21 with keywords (`per-collection` versus `step-kind`). All 233 bge-m3 document vectors were reused; only queries were embedded. Object ownership coverage is 191 mapped / 45 unmapped out of 236 tools (previously 163 / 73); the local include mappings already existed and the table type key is normalized to `tableType`.

Run `npm run eval:tools -- --bundle srv/tool-embeddings.879dc890b222.json --store vector --embedder ollama` or `npm run eval:tools -- --store in-memory --embedder none` (`--keyword` alias). The harness defaults to `--k-reader 5 --k-writer 2`, matching the hub; pass `--k-reader 2 --k-writer 1` to reproduce the baseline. It uses hub factories and real selection code, prints both strategies and misses, and supports `--store in-memory|vector|qdrant`, `--url` for Qdrant, `--embedder none|ollama|openai|sap-ai-core`, `--model` and `--embedder-url`. `--bundle` defaults to the committed bundle and supplies vectors only on fingerprint match; otherwise the selected embedder vectorizes documents. It never rewrites bundles.

Precomputed vectors also require matching document text. Qdrant evaluations use a unique temporary collection prefix and delete their collections afterwards; `QDRANT_API_KEY` is optional. Removing the former cluster strategy setting is recommended: a leftover setting produces one startup warning and has no effect.

All `LLM_GATEKEEPER_*` values: unset means off. A value that is not plain digits for a positive integer (`0x10`, `1e3`, ` 5` and `5.0` are refused) — or a combination the notes above forbid — stops `cds serve` before it listens, naming the variable. The values in force are logged at startup and returned in `Health()`.

The coordinator chooses when to verify cited evidence. Verification findings reach the user through the coordinator answer.

`LLM_AGENT_SAP_RELEVANCE_SCORE` is deprecated and ignored.

## Tool-search health and recovery

A TOOL SEARCH failure returned by the configured tool-corpus backend or its embedder fails the step/request. Docs MCP query-embedding failures also fail the entire search, including when corpus hits or direct docs candidates are available. Vector tool stores and the local skills store use the primary vector store directly: an open embedder circuit breaker returns an error instead of switching to an in-memory keyword store. SAP tool stores (`VectorRag`/`QdrantRag`) and local skills set `fallbackOnQueryEmbeddingError: false`, so a failed caller query embedding propagates without a second embedding attempt inside the store. Docs MCP queries follow the same embedding policy below.

Tool-search query embeddings and recovery probes use `composeEmbedder(provider, { retry: false, throttle: { key, strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }) } })` behind the shared circuit breaker and retain the standard 24,000-character input cap. The tool-search quota key is stable across instances with the same provider/model/endpoint fingerprint and contains no credentials. HTTP 429 is a quota wait: llm-agent honors the provider's `Retry-After` (seconds or HTTP-date) as a minimum wait; the shared gate may add wake-up jitter. Without a valid interval, backoff starts at two seconds and doubles; explicit `Retry-After: 0` retries without fallback backoff. There is no attempt cap, total wait limit or timeout; only the caller's abort signal cancels the wait. A 429 does not fail the search, mark the hub unhealthy or count as a circuit-breaker failure. Every non-429 error, including HTTP 5xx and network failures, propagates on its first provider call and marks the hub unhealthy. Non-tool RAG queries and document embeddings use the same provider instance wrapped with `composeEmbedder(provider)`: up to three retries (four provider calls total) for HTTP 429/500/502/503, with exponential backoff starting at two seconds. OpenAI/Ollama embedders 31.0.0 no longer retry internally, so these retries belong to composition. Non-tool stores retain their default query-embedding fallback and successful empty searches.

Known limitation: the 429 quota wait covers the embedder only. Qdrant answers HTTP 429 when a collection's Strict Mode rate limits (`read_rate_limit`) are exceeded, and `@mcp-abap-adt/qdrant-rag` currently reports it as a `QUERY_ERROR` without status or `Retry-After`, so such a 429 marks the hub unhealthy like any other tool-search failure. A local Qdrant without Strict Mode never returns 429; Qdrant Cloud may enable Strict Mode for new collections. Waiting on Qdrant 429 needs status and `Retry-After` in `qdrant-rag` errors plus the same throttle there (planned in llm-agent).

SAP AI Core uses the hub's existing adapter and the same composition. That adapter still allows SDK retry middleware and does not forward the abort signal to SDK I/O. Composition handles surfaced 429 errors and cancels quota waits, but SAP may make hidden transport retries and an in-flight SDK request cannot be cancelled by the caller. Updating that adapter is a separate task; the first-transport-attempt and I/O cancellation guarantees above apply to OpenAI/Ollama.

The failure also makes the hub unhealthy across destinations, users, models and cached sessions. `GET /health` returns HTTP 503 with `status: "DOWN"` and `toolSearch.error`, alongside any collection-restore state. All API routes and MCP endpoints refuse requests with HTTP 503 and `tool_search_unavailable`, including collection management, sessions, plain MCP and routes registered later by CAP. Only GET/HEAD health endpoints bypass this guard; `/mcp/health` also reports the tool-search failure. The published health cause contains no provider response bodies or credentials. Caller cancellation does not mark the backend unhealthy. Docs MCP connection failures alone do not change this state.

Recovery is request-driven. The next non-health request runs a probe for every failed store; concurrent requests share the probe batch. Probes use constant text and fresh query embeddings, without retaining the original request, caller credentials, abort signal or a failed memoized vector. Production probes, including docs query probes, reach the real embedder even when its breaker is open, apply the same input cap and unlimited 429 waits, and record success only after an embedding succeeds. A probe's 429 leaves the existing unhealthy state in place without adding a breaker failure. Store probes then search the failed store. The hub admits requests again only after all failed stores pass. There is no recovery timer, timeout or arbitrary deadline; health endpoints only report the current state and never probe. A new failure during a probe remains unhealthy until a later successful probe.

For Qdrant tool corpora, startup requires current catalog completion records. A zero point count produces only a warning; an empty tool collection returns no tools and does not fail startup or requests. A nonzero count must equal that role's corpus size; short or oversized nonempty collections raise `ToolCorpusMissingError` with build-step guidance. Rebuild with `npx tsx tools/generate-tool-embeddings.ts` using the target configuration, then restart. Ordinary non-tool Qdrant collections are not subject to this corpus-size check.

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

**Backend first.** Add, update, delete, `record_update`, `record_delete`, rename, description and enabled writes go to the database first; memory changes only after it succeeded. A failure is an explicit error and leaves memory untouched, so no response reports a change a restart would undo.

| Status | Cause |
|--------|-------|
| 409 | Duplicate name, an orphan store under that name, a collection being deleted, or a collection restored as `incompatible` |
| 503 | Collections not restored yet: the restore failed, or is still running after the 30 s a request waits for it ("restore still in progress"); or a collection restored as `unavailable` |
| 502 | Any backend failure on an operation, an unreachable backend included |
| 400 | `backend` in the request differs from the configured persistent kind |

**Restore at startup.** Collections are read back from the catalog before the registry serves persistent operations. Only records the hub wrote (`writtenBy: cloud-llm-hub`) are opened; others are left alone. If the whole restore fails, `GET /health` answers 503 and a background retry runs after 30 s, doubling up to 5 min, each attempt logged. `/health` answers 200 `{"status":"UP"}` once restored, and also whenever persistence is off. One collection failing to open or scan is restored as `unavailable` (the others work). A collection written with a different embedder is restored as `incompatible`: it can be listed, read and exported, while search and writes name both embedder fingerprints in the error. A chat turn that names an incompatible or unavailable collection is refused (409 / 503) before anything streams.

**Migrating to a new embedder.** On Cloud Foundry, the MTA before-start hook runs the embedding migration before the new hub starts. The task updates embedded persistent collections, session history, and planner memory. A task failure fails the deployment. For a local migration, stop the hub and run `npm run migrate:embeddings` with the new embedding configuration and the same persistent stores. The hub reports `EMBEDDER_MIGRATION_REQUIRED` at startup when an embedded hub store has a missing or stale fingerprint. Run the migration before restarting. Vector dimension changes are unsupported and cause the migration to fail with `EMBEDDER_DIMENSION_MISMATCH`.

**Changing SAP AI Core resource groups.** When keeping the same embedding model, set `LLM_AGENT_EMBEDDING_COMPATIBLE_RESOURCE_GROUPS` to the comma-separated list of previous groups that still have indexed vectors. The migration updates matching catalog fingerprints without re-embedding compatible vectors. After the migration succeeds, the migrated collections no longer require those previous groups to open. The list also applies to Qdrant tool-corpus records and dimension lookup.

While the restore has failed (or is still running past the wait), presets stay usable: `GET /rag/collections` and `POST /rag/presets/ensure` answer 200 with the presets only and `collectionsUnavailable` naming the cause, and a chat whose `rag_collections` are all presets goes on; a chat naming any other collection gets 503. Removing a session in that time (logout, clear chat, eviction) is recorded, and the restore then deletes that session's collections instead of bringing them back.

**Documents.** The metadata keys `id`, `namespace`, `collectionId`, `docId`, `createdAt` and `_createdAtMs` belong to the hub; the hub's values win over the same keys supplied by a client.

**Session collections** persist too and expire after the session TTL (`LLM_AGENT_SESSION_TTL_MS`, default 1 h, counted from their last use). `RAG_SESSION_TTL_MS` still overrides it for collections only; it is deprecated. The hourly sweep removes expired ones from memory and from the catalog; the collections of an open long session are left to the session, which deletes them when it closes.

**Session history** lives in per-session `h_hist_<hash>` collections (`<prefix>_h_hist_<hash>` on Qdrant). Stable bindings restrict access to the session owner, without an administrator bypass. Closing or forgetting a session deletes its collection; shutdown preserves stored history for revival. Full turns remain for the session lifetime. Long turns use ordered chunks with a shared stable turn ID and a 6,000-byte UTF-8 embedding input bound.

`LLM_AGENT_CLIENT_HISTORY=off` (default) keeps only the latest client user message and its following assistant/tool loop at API ingress. Earlier turns enter prompts exclusively through session history RAG (`LLM_AGENT_RAG_QUERY_K`, default 5 complete turns). `on` forwards consumer messages and disables history retrieval for every builder, including adaptive controllers, dialogue planners/authors, LLM-only and agent MCP executors. An explicit empty read barrier prevents the library from creating an alternate history store. Both modes exclude cross-turn `Previous run` context and separate planner-memory retrieval; run records and dialogue transcripts remain stored for bookkeeping. Dialogue projects only the active turn and its corrections, with explicit consumer history prepended on `on`. Current in-flight work remains available. `LLM_AGENT_HISTORY_RECENCY_WINDOW` applies only on `on`; `0` keeps all messages.

For client-executed tools in either history mode, keep the current user message and the original tool call IDs when sending results. A revivable long session tracks every issued call ID, so a continuation can contain only the latest round. The session record holds pending IDs and the completed history record keeps them for replay. Without a long session, echo the assistant tool calls from the first round, in their original order, with at least one corresponding result. The ID of the first call in that round anchors subsequent continuations. A request containing only tool results uses its first result's call ID, so replaying it with the same first ID is stable. Dropping the anchor round can change the turn ID. Plain API retries deduplicate records when the hub honours the same session cookie. Requests with a newly minted cookie still derive the same turn ID from the same anchor and write to a separate session history collection. Identical standalone user messages each receive a fresh turn ID.

**Writes are owed in both modes, including `on`.** Completed turns enter a per-session FIFO before the response ends. The next request waits for all earlier queued turns, without a deadline, before any model call. A caller abort cancels its wait and leaves the write queued. The existing `composeEmbedder` / `WaitAsTold` composition handles embedding 429s, and the same throttle mechanism handles store and catalog 429s. A URL-scoped async transport adapter observes Qdrant 429 responses before the installed provider discards their HTTP headers. `Retry-After` waits repeat without a cap. Other failures make hub readiness report DOWN. The router replays retained turns in the background, waiting two seconds after each failed attempt until the queue drains or the hub shuts down. Readiness recovers automatically once every retained write succeeds. Repair bypasses the failed-open cooldown and the shared embedder breaker. Stable IDs make partial-write replay idempotent. Session vector writes require successful embedding.

Dialogue owns exactly one full-turn write, including background task completion, streaming and disconnected delivery; protocol handlers do not also record it. Empty/placeholder replies and failed/incomplete runs are excluded. The queue survives client disconnects and backend outages in the running process. Graceful shutdown waits for request teardown and drains accepted history writes, including `Retry-After` waits and backend repair. The write queue is in memory, with no durable outbox. After a process crash, aborted shutdown or forced termination, the session either starts anew or continues from the last turn that was stored successfully, according to the configured session store and history backend's persistence. Pending writes are not replayed after restart. Legacy `h_history` migration still verifies session bindings. Request trace IDs never replace stable session IDs.

Client ingress filtering runs before classification, automatic summarization and coordinator dispatch. It is never reapplied to internal agents: user-role actions/check messages and delegation prompts do not start client turns. A future library option could be `clientHistory: 'current-turn' | 'all'`, applied at the SmartAgent input boundary before any pipeline or pass-through processing. `current-turn` would preserve all messages from the last user onward, exclude earlier client turns, and bypass message-count recency and summarization for that turn. An assembler-only option would be too late to prevent earlier client history reaching helpers or coordinators. Adaptive coordination would also need `contextSource: 'assembled' | 'raw-history'` to consume the assembled context intact.

Remaining production `getSessionHistory` calls are both in `srv/openai-handler.ts`: delivery deduplication (`includes(lastUser)`) and streaming completion diagnostics (`storedMessages`). Its compatibility re-export is retained. The session store also supports message replacement for run bookkeeping, TTL cleanup and session revival (`srv/lib/session-lifecycle.ts`); none of these feeds its window to the model.


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
| `LLM_AGENT_DIALOGUE_EXECUTOR_POOL` | unset | Optional opt-in hub-wide concurrent dialogue task cap (positive integer). Unset means sessions never share an executor pool. |
| `LLM_AGENT_DIALOGUE_MAX_CORRECTIONS` | `2` | Maximum end-of-turn corrective turns (nonnegative integer); `0` disables corrections. |
| `LLM_AGENT_DIALOGUE_TASK_OUTPUT_CHARS` | unset (unlimited) | Optional maximum retained characters per task output. Set a positive safe integer to enable it. |
| `LLM_AGENT_DIALOGUE_MAX_TASKS` | `50` | Task board capacity per dialogue session (positive integer). |
| `LLM_AGENT_DIALOGUE_WAIT_TICK_MS` | `30000` (library default) | Non-negative safe integer; 0 disables live wait ticks. Unset or blank uses the library default; invalid values reject startup. |
| `LLM_AGENT_DIALOGUE_LONG_TASK_MS` | `300000` (library default) | Non-negative safe integer; 0 disables long-running task wakes. Unset or blank uses the library default; invalid values reject startup. |
| `LLM_AGENT_PLAN_MAX_STEPS` | Unlimited | Optional positive integer step limit. |
| `LLM_AGENT_PLAN_MAX_REVISIONS` | Unlimited | Optional positive integer revision limit. |
| `LLM_AGENT_PLAN_MAX_DURATION_MS` | Unlimited | Optional positive integer duration limit in milliseconds, checked between steps. |

Opt in with `LLM_AGENT_CHAT_COORDINATOR=dialogue`. Only long-session requests use the dialogue planner; requests without a long session fall back to adaptive and return `x-clh-coordinator: adaptive`. The dialogue coordinator uses the `coordinator` record and orchestration tools, with background executor/checker workers. A stateless `ProfilePlanAuthor` uses `planner-create` / `planner-revise` and exactly `rag_search`, `rag_read`, `collection_records`, `collections_list` under profile ceilings; it has no SAP or write tools. `LLM_AGENT_PLANNER_MODEL` (fallback `LLM_AGENT_MODEL`) drives the author and, by default, the coordinator; optional `LLM_AGENT_COORDINATOR_MODEL` changes only the coordinator. Planning retrieval and session memory go to the author as notes. Each session has a connection factory refreshed by dialogue chat requests and a bounded connection pool; credentials remain in memory. Executor, pool and task limits default to 3 / 6 / 50 when unset or blank and otherwise require positive safe integers written as decimal digits; malformed values reject startup.

Streaming dialogue responses send pending messages before the new reply, then follow the outbox after releasing session and pipeline admission when a plan exists. Follow ends on a settled plan that is done, waiting for the user, or idle (no active turn, queued inputs, running tasks or ready steps), after sending its pending messages. An ordinary reply without a plan has no follow. Disconnect or a new request in the same session also ends follow. There is no duration cutoff. A superseded response ends with `A new message arrived; the work continues in its response.`

Delivery is at least once, keyed by message ID, even when an SSE subscriber is present. A later chat request without `x-clh-ack` confirms the contiguous pending prefix carried by successfully completed responses. Sending `x-clh-ack: none` or `x-clh-ack: <id>` permanently switches that session to explicit acknowledgement mode; `none` confirms nothing, and an ID confirms through that message only where ended deliveries carried the prefix. Unknown IDs confirm nothing. Failed or disconnected responses confirm nothing. Non-streaming responses concatenate pending messages and the reply with blank lines and expose the last included ID in `x-clh-last-message`; they do not follow. With a persistent session store, unconfirmed messages and acknowledgement mode survive restart, but delivery records do not, so messages may be delivered again. Clients should deduplicate by ID.

Both streaming protocols frame complete messages with SSE comments `: message-id <id>` before the first delta and `: message-end <id>` after the last. One `: turn-end` marks the end of the request's planner turn before follow; it is not the response terminal. Messages use blank-line separators without a planner prefix. Limit and supersede notes are outside message framing. For dialogue streaming requests (a long session with a resolved destination), the stream opens at once and keep-alives start then, including queue waits before agent initialization/admission, and repeat every 10 seconds; other streaming requests keep today's timing. Refusals before stream opening retain HTTP status responses; later errors use the protocol's stream error form without a success terminal.

`GET /v1/session/events` is a read-only view of retained complete messages (confirmed and pending), plans and tasks; it never confirms delivery. Its deprecated `POST /v1/session/events/ack` route returns 204 after ownership/mode checks and changes nothing. The channel's 15-second heartbeat keeps the session alive. The WebUI renders each ID once across chat and SSE, replaces partial segments with complete versions, sends `x-clh-ack: none` initially (also after reload) and then the last complete ID per session, and sends no SSE acknowledgements. It unlocks input at `: turn-end`, allowing corrections during follow; response notes render as separate system lines.

Running dialogue work holds the session against inactivity expiry; releasing the hold touches it. Close/TTL ends tasks and deletes state; shutdown preserves the last saved state on HANA/PostgreSQL for lazy revival, with queued/running tasks marked interrupted and no restored credentials until the next dialogue chat request. Adaptive remains the default. Agent MCP can open the same headless dialogue on a long session; `execute_step` accepts an optional worker profile. See [Dialogue coordinator architecture](../architecture/ARCHITECTURE.md#dialogue-coordinator-stateless-plan-author-and-background-tasks) for context, persistence and event semantics.

Unset or blank budget fields remain undefined so the library applies its defaults. Values must otherwise be positive safe integers written as decimal digits; malformed values reject startup. Budgets apply to adaptive execution; elapsed time is checked between steps, not as a timeout on planning or an in-flight worker call. These settings apply to the chat path; `execute_step` retains its existing behavior. Run records keep only the latest run per authenticated user and session, with each step output limited to 4000 characters. With a HANA or PG session store they use the dedicated `h_runs` hub store; otherwise they stay in memory, bounded by `LLM_AGENT_MAX_SESSIONS`. Run-record load/save requires a matching trusted request session and authenticated user; requests without either keep no run record. Both Anthropic paths forward the trusted session. Closing, forgetting or expiring a session deletes its owner-scoped run record, including plain-session history expiry. Records also expire after `LLM_AGENT_SESSION_TTL_MS` from their save time; memory saves sweep expired records. Persistent h_runs records are swept at startup and every minute by the session cleanup timer, including records left by previous processes. Sweeps run in the background with failure logging and leave malformed rows intact with a warning.

Checker context includes a redacted `[tools used by task ?]` block for the checked task. Successful calls provide evidence of execution; claimed system changes without matching successful calls fail unless independently verified. Unavailable or omitted evidence does not prove that no tools ran. Traces persist with dialogue tasks; older tasks without traces remain valid. Startup applies changed built-in checker profiles to the global `agents` collection automatically.

Adaptive planning and revision preserve the coordinator’s chosen check worker. A verdict profile receives only the journal calls and authorized records cited in its brief and submits findings through `submit_verdict`. See the [verification brief and verdict](../architecture/API_REFERENCE.md#verification-brief-and-verdict).

### Tool gate

| Variable | Default | Meaning |
|----------|---------|---------|
| `LLM_AGENT_TOOL_GATE` | `classifier` | A confident negative closes the gate in smart mode; `off`, hard mode and `execute_step` always keep tools and skills. |
| `LLM_AGENT_TOOL_GATE_TIMEOUT_MS` | Ignored (legacy parser default `4000`) | Classification/translation waits until completion or caller cancellation. |

Each tool search uses its own query analysis for translation, write classification and the SAP tool gate. Queries of at least three characters go through the analyzer, including English. English is returned verbatim and other languages, including transliterated text, are translated. Shorter queries keep tools and use the original text. The analyzer can reuse valid results or share pending work for matching queries, history context and session quota scope. Cancellation returns the original text and keeps tools for that caller. When the last caller leaves, the shared chat is aborted.

`LLM_AGENT_TOOL_GATE` defaults to `classifier`. A confident decision that the SAP system is unnecessary removes tools and skills for that search. Doubt or errors keep them. Setting the gate to `off`, using hard mode or calling `execute_step` bypasses the filtering decision and still uses the translation.

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

Dialogue chat does not run request-level collection retrieval; planning retrieval is supplied separately to author calls. Workers use RAG tools and the plan author receives `[planning knowledge]`, respecting session toggles and record policy. Cross-turn planner-memory retrieval is disabled; session history follows `LLM_AGENT_CLIENT_HISTORY`. The upload endpoint returns `documentIds`; clients send the current message?s chunk IDs as `attachment_document_ids` alongside `rag_collections: ["uploads"]`. Selecting the collection alone does not attach earlier files. Explicit `uploads` attachments are read directly without embeddings or semantic search and passed only to the current planner turn, bounded to 16,000 characters and 100 records with a preview notice; workers can read the remaining records. Other coordinators retain request retrieval. Request retrieval runs only on collections named in `rag_collections` or `X-Rag-Collections`, narrowed to enabled collections. A request without a collection selection (or with an explicit empty list) gets no request-level retrieval; the model can still use the RAG tools. A request explicitly selecting its session `uploads` collection can use attached files for that request. Planner knowledge checks enablement on every search, so the next turn observes a toggle. Tool selection and built-in skills use separate tool/skill stores rather than these user collections. Executor history remains session memory. Explicit RAG tools share the canonical catalogue on every channel. Disabled content is listed with attributes and reason, without text.

### Request time

Each agent receives the request time in its context. The hub captures HTTP/MCP arrival time once and reuses it across agent calls and retries. Dialogue planner and workers use the dialogue request's persisted openedAt timestamp; planner content wrappers preserve the single session-provided line.

Set `LLM_AGENT_TIME_ZONE` to an IANA time zone such as `Asia/Tbilisi`. Unset or blank uses the library default `UTC`. Invalid values reject startup. This deployment setting applies to all SmartAgent configurations and dialogue sessions; clients cannot override it.

Agent profile seeds ship in `srv/agent-profiles/*.md`. Startup validates the entire
seed set before writing missing or changed built-in records through the normal
store upsert. Text is compared exactly and validated metadata as canonical JSON;
identical records are not rewritten. Custom records, including a non-seed
`LLM_AGENT_PLANNER_RECORD`, are untouched. Agents collections are configuration and are
excluded from knowledge search. Sessions can select an agents collection through the REST or agent MCP session APIs.
The required prompt records include `coordinator` (`kind: coordinator`),
`planner-create` and `planner-revise` (`kind: planner-author`), alongside the worker
records. `LLM_AGENT_PLANNER_RECORD` retains its environment-variable name but now
selects the coordinator record (default `coordinator`); the two author record names
are fixed. The former `planner` record is no longer required. Release updates to built-in records apply automatically on startup, including
replacing local edits or disabled flags when they differ from the seeds. User
copies of agents collections remain independent and require explicit updates.

The main model remains the only required model; coordinator, planner and classifier
overrides are optional.

### Unified RAG knowledge tools

Connect an authenticated external client to `/mcp/agent/stream/http` and call
`session_open` to obtain a live session key. Pass it as `session` to each tool,
or send `x-clh-session` or the `clh_session` cookie (in that precedence order).
Transport session IDs are not application session keys. User collections also
require this session for admission and accounting; their data outlives closure.

1. Call `collection_create({ name: "notes", scope: "user", session })`, or use
   `scope: "session"` for temporary knowledge. Keep the returned physical
   `collection` ID. Repeating create returns `created: false`.
2. Call `record_add({ collection, text: "A useful fact", title: "Note", session })`.
   Keep the returned UUID in `record`.
3. Read with `rag_read({ collection, id: record, session })`; replace the full
   text with `record_update({ collection, record, text: "Revised fact", session })`.
   Omitted title/source retain their authoritative stored values.
4. Call `record_delete({ collection, record, session })` or
   `collection_delete({ collection, session })` when the knowledge is no longer needed.

Inputs are strict objects limited to 10 MiB of UTF-8 JSON, including session and
attributes. Text is stored verbatim in one document. Optional source is attribution
only, with no URL fetch. There is no upload or chunking through these tools.
Success and error responses include matching text and `structuredContent.result`;
errors also include `{ code, message, status }` and set `isError: true`.

Agents collections are excluded from all seven mutations, including both enablement tools. Foreign owners and parallel
sessions stay hidden even for admins; existing global mutations follow REST
resolution and require `MCP_Admin` where reachable. All thirteen canonical RAG tools are host-executed on every channel, including workers, subject to profile ceilings. The plan author is restricted to the four read tools. No new environment settings are required.

Create the target explicitly with `collection_create({ name: "result", scope: "user" })`, then call `record_add({ collection: "result", record: "tech-spec", text: "..." })`. Use user scope for durable results and session scope only for scratch. `record` is the optional stable physical ID; omission generates a UUID. Add is create-only: `RECORD_EXISTS` (409) requires reading the existing record and using `record_update({ collection, record, text })`. Read back with paged `collection_records` and `rag_read` using actual IDs; verify count and scope. Retire reversibly with `record_set_enabled({ collection, id, enabled: false })`; use `record_delete({ collection, record })` only for explicit permanent removal. Updates preserve ID and metadata but add no correction reason, audit history or supersede chain. Disabling does not free an ID. A live owned long session is required for every RAG call.

Plain OpenAI and Anthropic chat clients must open a live caller-owned long session with `POST /v1/session` and bind its returned key with the top-level string body field `session`, `x-clh-session`, or the `clh_session` cookie, in that precedence order. The body field is validated and removed before forwarding upstream; invalid types return 400 and unknown, closed or foreign keys return `SESSION_NOT_FOUND`, as with the header. All thirteen RAG tools stay listed but return `SESSION_REQUIRED` without that session. WebUI sends `x-clh-tool-results: summary` on chat requests to receive compact `: tool-result` SSE comments (identifiers, counts and error codes, plus the first 200 characters of `rag_search.query` and `rag_read.offset` / `limit` arguments; without returned texts or error messages). The header value is case-insensitive; absent or other values emit no tool-result comments, including dialogue follow-up streams. WebUI executes RAG on the server and renders server tool results; browsers must not dispatch them again. Removed tool names in client tool definitions, forced choices or calls return 400 with migration guidance; REST tool dispatch returns 404. Cross-instance `RECORD_EXISTS` protection is not atomic: providers offer upsert without conditional insert; serialization applies within one process.

## Source trust configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_AGENT_TRUST_DEFAULTS` | `correction=4.9,system=4.8,client=4.4,target=4.3,docs=4.2,user-mcp=4.1,session=4,user=3.5,global=3` | Partial comma-separated class defaults; explicit profile/source/record values take precedence. |

Trust is ordered by LEVEL first (system > MCP > informational), then GROUP within a level (session > user > global). Overrides beat the base; explicit profile, source and record overrides retain precedence over defaults.

| Level / Group | session | user | global |
| --- | --- | --- | --- |
| system (prompt, base skills, corrections) | 5.0 (reserved) | 4.9 (`correction`) | 4.8 (`system`) |
| MCP (tool results) | 4.5 (reserved) | 4.4 (`client`) | 4.3 (`target`, built-in ABAP/SAP MCP); 4.2 (`docs`, docs MCP) |
| informational (collection records) | 4.0 (`session`) | 3.5 (`user`) | 3.0 (`global`) |

Session system (5.0) and session MCP (4.5) have no producers yet. Deploy-configured ABAP and docs MCP belong to the global group. `client` describes results of tools supplied by the client in its own request, in the user group. It is accepted in deployment defaults and profile maps for completeness. The OpenAI and Anthropic request paths register validated client tool definitions in request scope. Replayed results receive `[source: client:<tool-name>; trust 4.4]` wherever the existing model-facing tool-message formatter applies trust tags; profile and deployment overrides apply. Unknown tools and hub orchestration results remain untagged. Registered ABAP and docs MCP ownership takes precedence over client names.

`LLM_AGENT_TRUST_DEFAULTS` is a comma-separated class map, for example `correction=4.9,system=4.8,client=4.4,target=4.3,docs=4.2,user-mcp=4.1,session=4,user=3.5,global=3`. These are also the built-in defaults; omitted classes retain them. Unknown classes, nonnumeric values, values outside 0 to 5, or more than one decimal fail startup.

Profile front matter accepts an optional `trust` map:

```yaml
trust:
  user: 4
  docs: 3.5
```

Each role uses its own profile map over deployment defaults. Effective informational trust resolves record override, then collection/source override, then profile class default, then deployment/built-in default. Unknown classes or invalid values reject a profile.

Skill front matter accepts `kind: base` or `kind: informational` (default) and a stable `id`. Keep the id unchanged across renames: trust overrides and editing address ids, never display names. When omitted, hub directory names supply ids; external directory sources use source-qualified directory ids. Equal display names are valid. Base skills load directly into every role's system content after its profile prompt and before corrections, without semantic search, and carry `system` trust tags (4.8 by default). Informational skills load through semantic retrieval and carry trust. Existing shipped skills remain informational.

An **assistant** is the future memory-and-learning entity; an **agent** performs a role described by a **profile**, within a **pipeline**.


## SAP AI Core foundation-models

Use `sap-aicore-foundation` for SAP AI Core where chat models run as individual
`foundation-models` deployments. Set the resource group and the exact name of
the deployed chat model:

```dotenv
LLM_AGENT_PROVIDER=sap-aicore-foundation
LLM_AGENT_RESOURCE_GROUP=<resource-group>
LLM_AGENT_MODEL=<deployed-chat-model>
LLM_AGENT_MODELS=catalog
```

The Hub uses the SAP AI Core service binding in `VCAP_SERVICES` first, then
`AICORE_SERVICE_KEY`, then `AICORE_AUTH_URL`, `AICORE_CLIENT_ID`,
`AICORE_CLIENT_SECRET` and `AICORE_BASE_URL`. Supply credentials through the
binding or environment.

Role, classifier, helper and LLM tool-retrieval models use deployments in
the same resource group. For `anthropic--*` models the Hub supplies Bedrock's
required `max_tokens` from the model's documented output maximum in
`srv/lib/model-capabilities.ts`. A configured model with no entry fails
configuration validation.

For vector RAG, deploy an Azure OpenAI embedding model in the same group under
`foundation-models` and add these settings:

```dotenv
LLM_AGENT_RAG_TYPE=vector
LLM_AGENT_EMBEDDER=sap-ai-core
LLM_AGENT_EMBEDDING_MODEL=text-embedding-3-small
```

The SAP AI Core embedder selects the `foundation-models` REST path automatically
with this LLM provider. For keyword-only RAG, omit the embedder settings.

## Model selection

`LLM_AGENT_MODELS` is a comma-separated allowlist for request and agent model choices.

Use `catalog` or `catalog,extra-model` with `LLM_AGENT_PROVIDER=sap-ai-sdk`,
`sap-aicore-foundation` or `anthropic` to load models available to the configured
provider credential. `sap-ai-sdk` includes current models eligible for orchestration
chat. `sap-aicore-foundation` lists chat model names from running `foundation-models`
deployments in `LLM_AGENT_RESOURCE_GROUP`.
Anthropic uses the provider's model list with the same API key and base URL as chat;
entries with capabilities are limited to text generation, while entries without
capability metadata are included by id. Other providers reject this token at startup.
Explicit names and main/planner defaults remain allowed.
The catalog loads once after the server is served. Requests that resolve or validate
models wait for loading to finish. If loading fails, only the explicit allowlist applies.
Failures log the cause once; any later model request retries, including chat and MCP
requests. Concurrent loads are shared, with no periodic refresh.
Configured role models skip startup membership validation in catalog mode; after loading,
missing models are logged as errors. Runtime validation rejects disallowed role models
without falling back.

`LLM_AGENT_MODEL` and `LLM_AGENT_PLANNER_MODEL` are always allowed; with the list unset,
only those configured names are allowed. Only `LLM_AGENT_MODEL` needs a model name.

The WebUI LLM selector and OpenAI/Anthropic request `model` select the coordinator
per session, updated by the next allowed request model. The selection is persisted
for revival; requests without an allowed model keep the session model. An allowed request
model overrides `LLM_AGENT_COORDINATOR_MODEL` / `LLM_AGENT_PLANNER_MODEL`. For direct
chat and LLM-only requests, the selection applies only to that request. Destination
agents are shared per destination; their worker defaults remain unchanged.
An unknown id is ignored, logged, and returned in `x-clh-model-ignored`; deploy
defaults apply. Requests never change `/v1/models` `_active_model` (the deploy main model).

Only `kind: profile` records accept optional front matter `model`. Agent model
precedence is explicit tool override, profile model, then `LLM_AGENT_MODEL`.
Writing a disallowed profile model returns HTTP 400; loading a stored disallowed
model ignores that field with a warning and keeps the profile usable. Plan authors
continue to use `LLM_AGENT_PLANNER_MODEL`; classifier and embedder settings
are independent of request model selection.

`rag_read` defaults to 32,000 characters per page, subject to `LLM_AGENT_TOOL_RESULT_MAX_CHARS`. Identical pages inside one agent loop return an `alreadyRead` pointer while their original full-text round remains in the window. Pointers do not extend that lifetime; expired pages or any change to the full record return text again.

### External docs MCP per agent role

Configure `LLM_AGENT_PLANNER_MCP`, `LLM_AGENT_EXECUTOR_MCP`,
`LLM_AGENT_CHECKER_MCP`, and `LLM_AGENT_ANALYST_MCP` as comma-separated BTP
Destination names. Unset lists offer no external docs tools to that role.
Profile names `executor`, `checker`, and `analyst` select their respective lists;
planner and plan author use the planner list. These destinations declare docs
servers: all their tools count as read-only knowledge tools. Write-capable
external MCP servers are outside this configuration's scope. Profile allow/deny
rules, read-only policies, and parent ceilings still apply.

For a public endpoint, create a destination in the BTP cockpit under
Connectivity ? Destinations: Name `ABAP_DOCS`, Type `HTTP`, URL
`https://mcp-abap.marianzeis.de/mcp`, Proxy Type `Internet`, Authentication
`NoAuthentication`. Bind the hub to the Destination service as for SAP systems,
then set `LLM_AGENT_EXECUTOR_MCP=ABAP_DOCS` (and any other desired role lists).
The URL must be the Streamable HTTP MCP endpoint. Check deployment egress to
that host. Authenticated endpoints use credentials and tokens managed by the
destination; do not put endpoint credentials in environment variables.
OnPremise docs endpoints and user-dependent authentication are not supported.

Optional `LLM_AGENT_MCP_TRUST=ABAP_DOCS=4,OTHER_DOCS=3.5` overrides trust by
destination. Values are validated by `normalizeTrust`; malformed entries fail
configuration loading. Otherwise the active profile's `trust.docs` wins, then
`LLM_AGENT_TRUST_DEFAULTS`'s `docs` value, then the built-in default 4.2.
Results receive `[source: docs:<original-tool-name>; trust n]` through ToolTrust.
Connections are lazy; failed discovery logs a warning and omits that destination's
tools. A later agent preparation retries after a 30-second cooldown.


Timeout policy (2026-11-02): work waits until caller cancellation or an external limit.
`LLM_AGENT_TOOL_GATE_TIMEOUT_MS` and
`LLM_AGENT_DESTINATION_INIT_WAIT_MS` are legacy parsed settings that no longer
bound work. `LLM_AGENT_DIALOGUE_FOLLOW_MAX_MS` has been removed. Remove it from
deployment environment overrides. Streaming dialogue delivery has no duration
deadline.
`SAP_TIMEOUT_CSRF` is retired; SAP HTTP requests use no hub deadline.
External docs discovery runs in the background, never blocks profiles, and has a
logged ten-minute safety net. Its MCP client no longer overrides tool-call timeouts.
See [the timeout audit](../superpowers/verification/2026-11-02-timeout-audit.md).

Each dialogue session lazily owns its LLM clients, including coordinator, workers and classifier. A session-specific provider quotaScope isolates Retry-After waits from all other sessions. Calls within one session share the provider/model quota gate. Closing or evicting a session drops its clients; usage and context capture remain enabled. Providers currently expose no transport disposal API. llm-agent releases quota leases after calls and prunes idle, open gates (with a bounded registry); penalized or leased gates remain until safe to reclaim.

Dialogue sessions lazily own provider clients and quota scopes: a 429 pauses only that session, while its calls share their provider/model gate. Usage and context capture remain enabled. Closing or evicting a session drops client references. Providers expose no close/dispose API. llm-agent releases gate leases after calls and reclaims open idle gates with a bounded registry; penalized and leased entries remain until safe to reclaim.

### External documentation MCP selection

`LLM_AGENT_MCP_SELECTION` accepts comma-separated `DEST=direct|rag|auto` entries. Empty means `auto` for every destination. Direct mode always includes connected tools permitted for the worker role and profile policy. RAG mode embeds tool names and descriptions into a separate runtime memory index and selects relevant tools alongside corpus results. Refresh replaces only that destination's index entries.

`LLM_AGENT_MCP_DIRECT_MAX` is a positive integer (default `12`); invalid values warn and use the default. Auto uses direct mode at or below this tool count and RAG above it. RAG requires the hub embedder. For example, set `LLM_AGENT_EXECUTOR_MCP=DOCS_MCP` and `LLM_AGENT_MCP_SELECTION=DOCS_MCP=auto`. Role destination lists still control access.

`LLM_AGENT_CONTEXT_CANARY` defaults to empty (off). With `LLM_AGENT_CONTEXT_CAPTURE=stats`, a regex source logs distinct input matches by role, including tool definitions. Invalid regexes warn and disable scanning. Canaries must be test markers such as `SESSION-TAG: ALPHA-7Q2`, never secrets: matches are logged. Capture includes per-message, combined-system and tool-definition fingerprints (12 hex SHA-256 characters with a per-process random salt). Content uses NFC and normalized line endings. Session hashes include user and session identity without logging either. Hashes are stable within a process only. Compare non-shared message fingerprints and canaries across session hashes to investigate leaks; shared prompts and tools normally match.


### Full LLM context capture

Set `LLM_AGENT_CONTEXT_CAPTURE=full` to store one row per chat or streaming LLM call in the container's SQLite `context_calls` table. The default is `off`; the existing `stats` mode remains available. Embeddings are excluded. Requests include complete messages, tool calls/results, tool definitions and model options; responses include complete content and tool calls (stream deltas are assembled). Rows also contain ISO timestamps, ids, salted session hashes (null outside sessions), component, model, trace id when available, reported input/output/cached tokens (null when unavailable), duration, success and error name without stack or error message.

`LLM_AGENT_CONTEXT_CAPTURE_FILE` defaults to `context.sqlite` relative to the app directory, using the same convention as `usage.sqlite`. `LLM_AGENT_CONTEXT_CAPTURE_MAX_MB` defaults to `512` MiB. Once the file reaches this cap, capture stops writing and warns once; the final row can take the file beyond the cap. No data is deleted automatically. The admin must download and delete or rotate the file; it grows until the cap and container-local data can disappear on restart. Disable capture and restart before rotating an open file.

Download using the same `cf ssh` / SQLite `VACUUM INTO` workflow as usage: create a consistent snapshot with `VACUUM INTO '/tmp/context-snapshot.sqlite'` from the app's `context.sqlite`, then copy the snapshot out through SSH. There is no REST export endpoint. Downloads must happen before restart.

Credential-like password/passwd, authorization, bearer, client_secret/clientsecret, x-sap-* header and sap-password values are replaced with `?redacted?` in request and response strings before storage, including tool arguments and definitions. Other context is retained in full; restrict access to the file accordingly. All filesystem and SQLite work runs in a worker thread. The main thread queues at most 64 serialized rows, including one in flight; overflow drops new rows, increments the drop count exposed by `contextStoreStatus()`, and warns once per overflow burst. Worker failure warns once and disables capture for the process without restarting. Capture never changes the LLM result, and queued rows can be lost if the process exits before they are drained.

Dialogue workers store results only in their current session collections. The coordinator uses `rag_persist({ collection, records?, name })` to copy records verbatim into its user collection, creating it if missing. Omitted records selects enabled records; record ids are upserted and provenance is added. Other coordinator RAG tools remain read-only. Plain chat, user MCP calls and REST retain their existing write behavior.

### Deploy defaults for session roles and limits

All variables below are optional. Session settings override the deploy settings per role. The checker uses the session checker model, then the coordinator's `delegate_task` model, then the verdict profile model, then `LLM_AGENT_MODEL`. Every selected model must be in the allowlist. The legacy `LLM_AGENT_CHECKER_MODEL` value is still parsed for configuration compatibility.

| Variable | Default / behavior |
|---|---|
| `LLM_AGENT_EXECUTOR_MODEL` | Coordinator chooses the executor model when unset |
| `LLM_AGENT_<ROLE>_MAX_ITERATIONS` | Falls back to `LLM_AGENT_MAX_ITERATIONS`, then off (unlimited) |
| `LLM_AGENT_<ROLE>_MAX_TOOL_CALLS` | Falls back to `LLM_AGENT_MAX_TOOL_CALLS`, then off (unlimited; overrides the library default) |
| `LLM_AGENT_TOOL_RESULT_MAX_CHARS` | Off by default. A positive integer enables the limit. `0` also disables it. |

`<ROLE>` is `COORDINATOR`, `EXECUTOR`, or `CHECKER`. Every limit listed here,
including `LLM_AGENT_MAX_ITERATIONS` and `LLM_AGENT_MAX_TOOL_CALLS`, accepts
`off` to remove the hub limit. Otherwise values must be positive safe integers
written as decimal digits (with the legacy zero exception for tool results).
Blank values count as unset. Invalid limits fail startup naming the variable.
Effective worker model and limit values supplied by configuration report
`source: 'config'`; session settings report `source: 'user'`.

LLM-only sessions support read-only RAG tools to search and read collections. Collection writes and SAP actions are refused.
