# Agent MCP RAG write tools - design

Status: draft (design only, no code)
Date: 2026-10-30
## Intent

Let external Claude Code, Codex and Copilot clients manage text knowledge through
`/mcp/agent/stream/http`, without REST credentials or a WebUI workflow beyond the
existing authenticated MCP connection. Add five tools beside the six existing
RAG tools in `srv/agent-mcp-rag.ts`. Keep REST authorization and registry storage
semantics in one implementation.

Goals: create user/session knowledge collections; add, replace and delete text
records; delete eligible collections; return usable text and typed MCP results.

Non-goals: implementation in this change, commits, file/binary upload, chunking,
URL fetching, bulk operations, agents configuration, new caches, new internal
LLM capabilities, global collection creation or changes to REST access policy.
A `source` string is attribution only, even if it resembles a URL.
## Tool contracts

All inputs are strict objects. All tools additionally accept optional
`session: string` (nonempty), matching existing session-bound MCP RAG tools.
Required strings are nonempty; preserve text verbatim, including whitespace.
No caller-supplied owner, backend, metadata, namespace, collection kind or record
id on add. `record` means the exact document id, never a title/source lookup.

| Tool | Inputs besides session | Successful structured fields besides result |
| --- | --- | --- |
| `collection_create` | `name: string`, `scope: 'user' \| 'session'` | `collection`, `name`, `scope`, `created: boolean` |
| `collection_delete` | `collection: string` | `collection`, `deleted: true` |
| `record_add` | `collection`, `text: string`, `title?: string`, `source?: string` | `collection`, `record`, `created: true` |
| `record_update` | `collection`, `record`, `text: string`, `title?: string`, `source?: string` | `collection`, `record`, `updated: true` |
| `record_delete` | `collection`, `record` | `collection`, `record`, `deleted: true` |

`collection` and `record` outputs are canonical physical collection and document
ids usable in subsequent calls. Create maps name to REST `id` and `displayName`,
normalizing the logical id through `normalizeLogicalId`; return the normalized
name. Use `userCollectionId` or `sessionCollectionId`, never a raw physical id.
Create knowledge collections only; reject unsupported scope/kind/copy fields.
A collision with an agents collection is forbidden, never returned as knowledge.

Add generates a UUID exactly as REST does and writes one unchunked document.
Title/source map to `metadata.title`/`metadata.source`; omitted values on add
produce no corresponding metadata. Empty optional strings are allowed, as REST
metadata permits them. Update replaces the entire text, never appends or applies
a patch. Omitted title/source on update retain authoritative existing values;
provided values replace them. Preserve other stored metadata (including enabled
and upload bookkeeping) and createdAt. This is full content replacement with
optional attribute edits, not replacement of the whole metadata object.
Delete addresses one document, including when it is one chunk of an old upload.

Every description explicitly states its operation, eligible user/session scopes,
admin-only existing global mutations where reachable, and “agents collections
are excluded”. Update says “replace the full text”; source says “no URL fetch”.
Descriptions also state the session requirement and request size limit.
### Results and errors

Schema violations (missing fields, wrong types, invalid scope, extra fields, or empty required strings) are rejected by the MCP SDK before the callback as text errors with `isError: true`; they are not measured. Semantic errors, including the 10 MiB argument limit and reserved logical names, return structured errors with `structuredContent.result` from the measured callback.

Return `content: [{ type: 'text', text: result }]` and typed `structuredContent`
with the same human-readable `result` string on success and semantic error. Example:
`{ result: 'Record added.', collection: '<physical>', record: '<uuid>', created: true }`.
Do not echo record text or credentials. Preserve structured fields through
`measuredAgentCallback`/`measureAgentTool` in `srv/agent-mcp.ts`; follow the v9.8.1
`structuredContent.result` convention. Use discriminated per-operation result
interfaces and output schemas, rather than JSON text as the only payload.

Semantic errors set `isError: true` and return
`{ result, error: { code: string, message: string, status: number } }`.
Preserve backend `RagError.code` and `CollectionBackendError.httpStatus` when
available. REST generic errors currently expose `{ error: { message } }`, not
named codes: use these proposed shared fallback codes, without claiming they
already exist in REST:

| Failure | Code / status |
| --- | --- |
| Semantic invalid input, reserved logical `__` | `INVALID_ARGUMENT` / 400 |
| Request over limit | `PAYLOAD_TOO_LARGE` / 413 |
| Missing authenticated identity | `UNAUTHENTICATED` / 401 |
| Global write without MCP_Admin | `FORBIDDEN` / 403 |
| Agents target | `TOOL_FORBIDDEN` / 403 |
| Missing/foreign/wrong-session collection | `COLLECTION_NOT_FOUND` / 404 |
| Missing record on update/delete | `RECORD_NOT_FOUND` / 404 |
| Embedding/write failure without a backend code | `EMBEDDING_FAILED` / REST fallback 400 for add/update |
| Other unclassified backend failure | `BACKEND_ERROR` / REST operation fallback |

Distinguish embedding failures from storage failures; do not label every thrown
error as embedding failure. Preserve existing backend duplicate/orphan,
incompatible, deleting and unavailable codes and their 409/502/503 status.
Preserve REST lease codes `session_closed` / 410 and `gatekeeper_retention` / 503;
retain MCP session validation errors `SESSION_REQUIRED`, `SESSION_NOT_FOUND`,
`SESSION_LIMIT`, `SESSION_STORE_UNAVAILABLE`. Rejections never report success.
Hidden foreign targets remain 404; no ownership/content disclosure.
### Size and validation

REST single-document routes have no field-specific text limit. `/v1` has an
Express JSON body limit of `10mb` in `srv/server.ts`. Adopt the same 10 MiB
(10,485,760 bytes) ceiling for the UTF-8 JSON-serialized MCP arguments, including
text, attributes and session. Validate before embedding/store access, including
direct executor calls. Do not mistake upload's default 2,000-character chunk
size or rag_read's paging limit for an input limit. Retain transport limits too.
Share the request-size constant and operation validators with REST; MCP's strict
narrow surface must not weaken REST validation or introduce a second algorithm.
## Shared REST and registry path

REST handlers are anonymous callbacks inside `registerRagRoutes` in
`srv/rag-handler.ts`; there are no exported named write handlers today. Extract
typed transport-neutral operations into proposed `srv/lib/rag-write-operations.ts`
and call them from both transports. Keep Express response handling, MCP result
formatting and their admission wrappers outside these operations. Do not call
REST over HTTP or fabricate Express requests/responses.

| MCP tool | Existing REST handler under /v1 | Existing CollectionRegistry method in srv/rag-collections.ts |
| --- | --- | --- |
| collection_create | POST /rag/collections | getOrCreateCollection (createCollection internally) |
| collection_delete | DELETE /rag/collections/:id | deleteCollection |
| record_add | POST /rag/collections/:id/documents | addDocument |
| record_update | PUT /rag/collections/:id/documents/:did | updateDocument |
| record_delete | DELETE /rag/collections/:id/documents/:did | deleteDocument |

Reuse `resolveRouteId` in `srv/collection-ids.ts` and `collectionAccessError` in
`srv/lib/collection-access.ts`. REST content writes use `forWrite=true`; this may
resolve a nonexistent logical name but does not itself create a collection.
Require collection existence before mutation; no implicit record-write creation.
Logical names retain session-first lookup; physical ids retain owner and session
checks, including for admins. Retain REST `leased` target-session protection.

Persistent writes continue through `addPersistentDocument`,
`updatePersistentDocument`, `deletePersistentDocument` in
`srv/lib/collection-persistence.ts`, with the existing single-record failure
contract; never enable `persistOnFail` or use bulk/upload paths.
### Freshness and invalidation

The knowledge registry snapshot (`stored.documents`) stays the read model for
`getDocument`, `listDocuments`, `findActiveByCanonicalKey`, `rag_read`, record
listings and search visibility. MCP writes use exactly the REST registry path,
which after a settled write replaces only the written record in that snapshot
with the full record it just wrote (or removes it on delete). That is the
writer's own new value, not an edit of a cached copy. Do not evict knowledge
records from the snapshot; readers would lose them until restart.

The one read-before-write is every `record_update`: for a persistent collection
read the current record from the backend (`getById`), not from the snapshot, for
existence, metadata and createdAt, whether or not title/source are given; this
replaces the snapshot read in the shared registry update path (today
`srv/rag-collections.ts` `updateDocument` reads `stored.documents`); the memory backend's
map is its authoritative store. A missing backend record is `RECORD_NOT_FOUND`
and is not resurrected. Delete existence checks use the same backend read.
Providers do not reliably report whether a failed write reached the store, so
after any failed write re-read that one
record from the backend and set its snapshot entry to the result, or remove it
when the backend has none; if that read fails, report the error and leave a
log warning. Other records and collections stay intact.

Replacing the snapshot with provider listing (`IRag.list`, llm-agent 30.23.0)
is a separate queued task and out of scope here. No new cache, stale fallback or
collection-wide flush. Concurrent writers keep backend last-write semantics.
## Permission matrix

All rows require the existing authenticated agent-MCP endpoint admission. Private
means knowledge data; all five tools reject agents kind, regardless of scope,
owner or admin. Create exposes only user/session scopes.

| Target | User | MCP_Admin |
| --- | --- | --- |
| Own user knowledge | Create and mutate | Create and mutate own |
| Own current-session knowledge | Create and mutate with live session lease | Same |
| Foreign user or other session | 404 | 404 through REST resolver; no admin bypass |
| Existing global knowledge | 403 if resolved | Only mutations REST actually resolves/allows |
| New global | Invalid scope | Invalid scope; REST rejects global creation too |
| Agents, any scope | Forbidden if visible; hidden targets remain 404 | Same |

Code detail: `collectionAccessError` permits global writes for MCP_Admin, but
`resolveRouteId` currently resolves exact global ids specially only for agents.
Do not add global knowledge lookup or creation to widen REST behavior. If REST
later exposes global knowledge, use that same resolver and admin guard.

Wrap MCP writes in `withCollectionToolScope`, never `withCollectionRestScope`.
Keep registry `assertCollectionWrite` in `srv/lib/collection-write-scope.ts` as
an indirect-path agents guard; reject visible agents metadata before mutation.
## Session lifecycle and accounting

Use existing MCP precedence: explicit `session`, then `x-clh-session`, then
long-session `clh_session` cookie via `resolveSessionKey`. Obtain keys with
`session_open`; transport `mcp-session-id`/legacy `x-session-id` are not keys.
All five tools require a live caller-owned session, even for user collections,
matching existing MCP RAG tools. Resolve with `resolveSession(userId, key)`,
serialize through `longSessions().run`, acquire `leaseSession(..., 'rag',
{ presented: true })`, release in finally after backend settlement.

Session creation uses the resolved key, authenticated owner, deterministic id
and `expiresAt = Date.now() + sessionCollectionTtlMs()`. Reuse existing refresh,
retention and lifecycle cleanup in `srv/rag-collections.ts` and
`srv/lib/session-lifecycle.ts`; a closed session cannot be recreated by a write.
User collections outlive session closure. No new TTL/configuration variable.

Register through `registerRagMcpTools` and its existing measurement callback:
`measureRequest` records surface `mcp-agent`, exact tool name, user/session,
duration, response bytes and errors. No planner/executor/checker invocation or
fabricated LLM tokens. Preserve existing provider embedding usage and registry
storage snapshots; bind write embedding usage to caller/session and current
request trace using existing usage scopes, without counting the request twice.
Verify failure accounting and that measurement preserves structuredContent.
## Internal LLM exclusion

Keep an explicit external write-name set in `srv/agent-mcp-rag.ts`, registered
only by the agent endpoint in `srv/agent-mcp.ts`. Shared operations contain no
tool registration. Do not add these names to `getRagToolNames`,
`buildRagToolSchemas` or `dispatchRagTool` in `srv/rag-tool-dispatcher.ts`,
`DialogueRagMcpClient`/tool-RAG injection in `srv/lib/dialogue-rag-tools.ts`, or
planner/executor/checker lists in `srv/agent-manager.ts`.
Internal adapters must reject forged calls to these five names before forwarding
to any underlying client, even when profiles allow all tools. Filter these exact
names from imported internal catalogues/retrieval candidates too; name prefixes
alone are insufficient (`collection_*`/`record_*` do not start with `rag_`).
Keep existing internal rag_add/rag_correct/rag_deprecate behavior unchanged.
## Verification and documentation

- Unit tests per tool in `test/unit/agent-mcp-rag.test.ts`: strict inputs, result
  ids, text/metadata semantics, missing targets, idempotent duplicate create, embedding/store
  failures, and no writes after rejection. Test 10 MiB boundary with UTF-8 and
  JSON escaping; no upload/chunk/fetch path runs.
- Shared REST/operation tests in `test/unit/rag-handler.test.ts`: same normalized
  identities, permissions, validation, status/code translation and lease cleanup.
  Cover user/admin against each matrix row, explicit physical and logical ids,
  session shadowing, foreign owners and parallel sessions.
- Agents rejection for all five tools, including normalized-name collision,
  admin/owner calls and indirect registry mutations under tool scope.
- Session argument/header/cookie precedence, missing/expired/closed keys,
  retention refusal, queueing, lease held through backend completion and cleanup.
- Persistent freshness tests: external edit followed by update preserves current
  metadata; missing backend record is not resurrected. A successful write is
  immediately visible to rag_read and listings; a failed write re-reads only
  its record; unrelated snapshot records are untouched.
- Assert absence from planner/executor/checker definitions, tool-RAG candidates,
  dialogue tools and dispatcher schemas; forged calls fail without forwarding.
  Test profiles allowing all tools as well as read-only profiles.
- Every success/error includes matching text and structuredContent.result; verify
  registration and measured callback round-trips, usage identity and error counts.
- No any/unknown in new production or test types except narrowed caught errors;
  no as unknown as. Type callbacks explicitly and include tests in type checking.
  Run focused Jest suites with --maxWorkers=1, npm run test:check,
  npm run lint:check and npm run docs:check at implementation time.

Update `docs/architecture/API_REFERENCE.md` with schemas, examples, exclusions,
session keys and errors; `docs/llm-agent/CONFIG_USAGE.md` with external-client
workflow and internal exclusion (no new env settings); `CHANGELOG.md` at
implementation time. This change writes only this design document.
## Duplicate collection names

REST POST collection creation returns existing metadata successfully (200) for
a duplicate normalized name. MCP keeps exact REST parity: `collection_create` is
idempotent and returns the existing knowledge collection with `created: false`
(`result` says it already existed), so an agent can retry safely. An agents
collection with that name is still forbidden, never returned.
