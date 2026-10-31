# Unified RAG tools - design

Status: implemented
Date: 2026-10-31

## Decision

Tools must be the same for any connection. Adopt the eleven agent-MCP tools:
`rag_search`, `rag_read`, `collections_list`, `collection_records`,
`collection_set_enabled`, `record_set_enabled`, `collection_create`,
`collection_delete`, `record_add`, `record_update`, `record_delete`.

Remove `rag_list`, `rag_add`, `rag_correct`, `rag_deprecate`; no runtime aliases.
This supersedes the internal-LLM exclusion in the 2026-10-30 agent-MCP RAG write
design and the old RAG names in the agent-profiles and planner-prompt designs.
The five content/collection write contracts from that design remain authoritative.
Implementation is complete across stages 1?3.

Parity means one catalogue, schemas, descriptions, effects and execution semantics
for `/mcp/agent/stream/http`, OpenAI-compatible chat, WebUI, dialogue planner and
workers, and classic/fixed/other coordinators. With equal caller and profile
context, their RAG tool lists are identical. Profile policies and read-only
ceilings can narrow the catalogue everywhere; transport is never a grant.

## Current paths and disposition

| Current use | Implementation decision |
| --- | --- |
| `srv/rag-tool-dispatcher.ts`: four schemas, name list, schema builder, handlers | Delete; replace imports with the shared agent-MCP catalogue/executor. |
| `srv/lib/dialogue-rag-tools.ts`: worker client, local dispatch and synthetic tool-RAG candidates | Generalize to a channel-independent local RAG adapter. Inject all eligible canonical tools; dispatch by exact catalogue membership, not `rag_` prefixes. |
| `srv/agent-manager.ts`: exposition filtering, embedded tool lists, candidate filters, profile catalogue/grants, dialogue-only wrapping | Remove external-write bans; reserve canonical names for local execution. Install the same adapter for every coordinator and profile worker, inside recording/result-cap wrappers. Deduplicate imported tools and candidates by exact name. |
| `buildPlannerAgent` currently supplies only `PlannerToolsClient` | Compose that client with the shared RAG adapter; retain planner control tools. Apply the planner's effective profile ceiling to RAG calls too. |
| `srv/lib/external-rag-write-names.ts`, `tool-authorization.ts`, `agent-profile-tools.ts` | Delete the external-only policy/set. Keep profile, parent and verdict ceilings; classify canonical tools from trusted catalogue effects. |
| `srv/openai-handler.ts`: request `body.tools`, external results, session ALS | Add canonical tools as host-executed tools; remove stale dispatcher comments and keep identity/session binding through streaming, retries and non-streaming. |
| `srv/rag-handler.ts`: `GET /v1/rag/tools`, `POST /v1/rag/tool/:name` | Retain as thin catalogue/executor adapters for canonical names. GET returns all eligible OpenAI-format definitions; POST rejects removed names with 404. Delete old dispatcher/result format. |
| REST collection/document CRUD and toggle routes | Retain; continue sharing operations, authorization and registry persistence with the executor. No removal of ordinary REST CRUD/upload APIs. |
| `srv/agent-profiles/executor.md`, `planner.md` | Replace storage/readback instructions as below; inspect every other profile for obsolete names/policies. |
| `srv/presets/rap-context/phase-procedure.md`, `rap-skills/managing-rag-artifacts.md` | Replace save/update/retire instructions and stable-ID assumptions; inspect all preset content, including tool names implied by descriptions. |
| Tests importing the dispatcher or asserting the external-only ban | Replace with canonical contract/parity tests; retain persistent failure, toggle and agents-denial coverage. |

The two WebUI copies (`app/chat/webapp/index.html` and
`app/router/chat/webapp/index.html`) lazy-load `/v1/rag/tools`, append the old
three write schemas to `body.tools`, collect streamed `delta.tool_calls`, then
POST each RAG call to `/v1/rag/tool/:name`. They show operation/download cards;
this branch does not feed those RAG results back into a continuing model loop.
Thus these are consumer-executed external tools in the llm-agent #167 model,
not server-executed RAG calls merely because the OpenAI handler binds ALS.

Remove WebUI RAG schema loading, `body.tools` injection and browser dispatch.
Render canonical server tool results through the existing tool-event/recording
path, including collection/record IDs, errors and downloads after add/update.
Keep unrelated consumer tools such as `GenerateFile` on their existing path.
Ship both WebUI copies with the server change to avoid duplicate execution.

## Tool semantics and removed behavior

| Old operation | Replacement |
| --- | --- |
| `rag_list` collection summaries | `collection_records`, paged; `collections_list` for collection discovery/scope/enablement. |
| `rag_list` with `id` | `rag_read` with the exact physical document ID; follow character paging. |
| `rag_add` | Explicit idempotent `collection_create` when needed, then `record_add`, optionally with a caller-chosen `record` id (see Decisions). |
| `rag_correct` | `record_update` using `record`, with `newText` renamed to `text`. |
| `rag_deprecate` for retirement | `record_set_enabled` with `id` and `enabled: false`; reversible retirement. |
| `rag_deprecate` where permanent removal was intended | Explicit `record_delete` using `record`; never silently reinterpret deletion as disabling. |

Code reality: `rag_correct` resolves an active `canonicalKey`, overwrites the
same physical record, and stores `lastCorrectedReason`/`lastCorrectedAt`.
`rag_deprecate` resolves that key and permanently deletes; it only returns reason.
Neither handler currently creates a supersede chain or tags records deprecated.
Legacy `superseded`/`deprecated` filtering exists separately in registry retrieval
and dialogue attachments; preserve it for existing data.

Canonical tools do not resolve canonical keys, accept tags/reasons, generate correction audit metadata, or supersede versions.
Update preserves existing metadata and physical ID but creates no history.
Disabling keeps data/ID and hides content according to record policy; it does not
free a key for re-add. Delete is permanent. Old automatic collection creation,
session-aware/default scope selection, full unpaged read and list tags/lengths
also disappear. Use explicit scope (user for requested durable results, session
for scratch), create then add, and paged readback. Add is not an upsert.

Tutorial artifacts keep human-selected IDs such as `tech-spec` through the optional
`record` input of `record_add`, and update them with `record_update`. Checkers
enumerate and read actual records and verify count/scope. Existing records keep
their IDs and metadata; no bulk rewrite or deletion of canonicalKey metadata.

## One catalogue and execution path

Extract transport-neutral definitions from `srv/agent-mcp-rag.ts`: exact names,
input/output schemas, descriptions and trusted read/write effects. MCP
registration, OpenAI definitions, internal MCP clients, profile catalogues and
tool-RAG candidates derive from it. Unify the current described write schemas
and direct-validation schemas so adapters cannot drift. No second handler map.

The shared MCP RAG executor remains the sole tool implementation, calling
`srv/lib/rag-write-operations.ts`, existing read/toggle operations and registry.
REST tool dispatch and internal calls invoke it in process; no loopback HTTP or
fabricated Express request. Refactor its request-dependent inputs to a typed
execution context: authenticated user ID/roles, session key, admission proof,
effective profile permissions, trace/task IDs and measurement scope.

Bind the human caller's authenticated identity, including MCP_Admin, explicitly
across background work; do not depend on whichever `cds.context` happens to be
active. Never use the destination/service account as the RAG owner or grant.
Keep `withCollectionToolScope` around all tool executions and registry's indirect
agents guard. REST admin/configuration routes retain their separate REST scope.

Four tools are read-only: `rag_search`, `rag_read`, `collections_list`,
`collection_records`. Both toggles and all five CRUD tools have write effects.
Enforce caller permissions and profile/parent ceilings when listing, selecting
and executing, including forged calls and cached agents. Checker/verdict and
`tools: read-only` profiles receive only the four reads; allow/deny policies
intersect grants. Remove the `rag_list` read special case. Route local RAG before
SAP exposition authorization: use REST-equal collection permissions rather than
requiring a SAP tool group or treating every authenticated caller as a writer.

Keep agents collections excluded from every tool mutation, including both
toggles and create-name collisions, for owner/admin alike. Preserve hidden-target
404s, session ownership, existing global-resolution/admin limits, enabled-record
visibility and backend-first failure behavior. Search only enabled eligible
content; list/read disabled content expose attributes/reason, not text.

Keep the 10 MiB UTF-8 JSON-argument limit for content writes, including text and
attributes, before embeddings/storage. Preserve strict write schemas and exact
document IDs, no URL fetch/chunking/implicit collection creation. Preserve MCP
write `content` plus typed `structuredContent.result`, matching text on success
and semantic error; retain existing SDK validation behavior. Adapters preserve
structured fields and `isError`; OpenAI tool messages serialize the result once.
Do not invent a different `{ok,id}` result contract for internal consumers.

## Sessions, admission and accounting

External MCP keeps explicit `session`, then `x-clh-session`, then long-session
`clh_session` cookie precedence, ownership validation and existing errors.
Internal calls use the enclosing admitted chat/dialogue session key, including
background workers after the HTTP request ends. A model-provided different
`session` is rejected; omission or that same key is accepted. This prevents
moving writes/toggles into another conversation even for the same user.

Chat currently uses `sessionIdOf(req)` with a trace/random fallback; not every
such ID is a resolvable long-session key. Require a live caller-owned long
session for all eleven tools, even user-scope writes, as agent MCP does. The
catalogue stays present without one, but execution returns `SESSION_REQUIRED`;
the client opens a session through the existing lifecycle API and retries.
Do not silently promote a trace ID or minted plain cookie to a persistent
session. Document this breaking restriction for plain/stateless chat clients.
Session collections, uploads, enablement overrides and tool leases all use the
same enclosing key; no worker-specific session. User collections outlive closure.

External calls resolve the session, enter `longSessions().run`, acquire the RAG
lease and release in finally after backend settlement. Internal calls under
chat/planner admission reuse a trusted admission token for that user/key; never
enqueue recursively on the same FIFO (deadlock). Background workers retain
`admitBackground` and lifetime holds and supply their own trusted session scope.
The shared executor still validates ownership/liveness and obtains/releases its
RAG lease without reentering the outer queue. Admission bypass is host-only;
no tool argument can request it. Close/retention refusal never recreates a session.

Record one tool measurement per call, exact canonical name, human user/session,
duration, bytes and error, under the originating chat/task trace. Preserve the
outer chat request and actual channel; do not fabricate an `mcp-agent` request
for internal calls. Keep RecordingMcpClient evidence and embedding/storage usage
bound to the same trace/session; avoid counting adapters as additional calls or
inventing LLM tokens. Capture identity/measurement context when scheduling tasks.

## Migration and documentation

Reserve canonical RAG names as host tools. OpenAI `body.tools` entries with
canonical names cannot override schemas/execution: deduplicate valid matching
definitions, reject conflicting definitions with 400. Reject any removed name
with 400 and a migration hint; reject forced tool choices and forged calls too.
Other consumer tools keep #167 external execution. Reject external results
claiming host RAG call identities; keep profile external-result guards intact.

Version persisted dialogue tool contracts. On restoring an older state, retain
completed results/transcripts but block automatic dispatch/replay of unfinished
legacy calls; mark affected work for replanning with the new catalogue and
existing record IDs. Never blind-rename argument objects or replay successful
writes. Validate stored profile allow/deny names and report actionable migration
errors; update shipped seeds, invalidate derived tool indexes/caches and rebuild
tool-RAG candidates. User-edited profiles/presets need explicit migration reports,
not silent overwrites. Historical text may mention removed names but cannot
authorize or execute them.

Update `docs/architecture/API_REFERENCE.md`, `docs/llm-agent/CONFIG_USAGE.md`,
and both code-doc-generation and rap-bo-book-catalog tutorials: README flows,
overview skills, artifact skills/index, phase procedure and kickoff prompts.
Replace old calls/cards, stable-ID examples, correction/deprecation promises and
external-only statements. Keep historical specs/plans/verification as evidence;
mark their conflicting decisions superseded when implementing this design.
Add a breaking-change migration entry to `CHANGELOG.md`; recommend v10.0.0,
not a v9 minor release, because names, arguments, execution ownership and plain
chat session requirements change without aliases.

## Verification

- Compare normalized RAG names, schemas, descriptions and effects from MCP,
  OpenAI, both WebUI flows, planner, workers and every coordinator under the
  same identity/profile; expect the same eleven (or identical ceiling subset).
- Test profile allow/deny, parent ceilings, checker four-read limits, cached
  adapters and forged calls; all seven mutations reject agents targets.
- Reject removed names via tools/list candidates, execution, REST tool dispatch,
  OpenAI client lists/choices and restored plans; no forwarding to upstream RAG.
- Exercise create/add/update/read/disable/delete and checker count/scope readback
  per channel; verify REST-equal user/admin/foreign/global/session permissions.
- Test internal/external session binding, missing/foreign/closed keys, parallel
  sessions, background identity, nested admission without deadlock, lease cleanup,
  10 MiB boundaries, persistent failures and structured-result/usage preservation.
- Assert current prompts/seeds/presets/tutorial examples mention only registered
  tool names; cover stale stored policies and unfinished plans without replay.
- Run focused Jest suites, `npm run test:check`, `npm run lint:check` and
  `npm run docs:check` during implementation; this spec requires no code tests.

## Decisions (maintainer, 2026-10-31)

Record writes share in-process serialization by collection/document id, including REST add/upload and tool add/update/delete. Cross-instance create-only is not atomic: the installed provider interfaces expose only upsert, with no conditional insert.

- Stable record IDs: `record_add` gets an optional `record` input (caller-chosen
  document id, same validation as REST document ids). When given and a record with
  that id exists in the collection, the call fails with `RECORD_EXISTS` / 409 and
  writes nothing; changes go through `record_update`. Without it a UUID is
  generated as today. This is an additive change to the agent-MCP contract, so
  tutorials keep human ids such as `tech-spec`. Correction reasons and version
  history are not reproduced.
- Plain OpenAI clients without a live long session get `SESSION_REQUIRED` for all
  eleven tools, exactly like agent MCP; the tools stay listed.
- Release as v10.0.0 with a breaking-change migration entry.

## Open questions

- Legacy lifecycle tags are filtered separately from enabled state. Should a
  later migration convert deprecated/superseded records to disabled records?
  Keep current filtering/data until decided; enabling alone is not resurrection.
- Resolved: `toolContractVersion` marks persisted state; older unfinished tasks are interrupted and unfinished steps blocked for replanning. Completed work is preserved.
