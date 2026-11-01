# Source Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every informational item that reaches an LLM carries `[source: …; trust n]`; collections and records
have a mandatory effective trust; admins set trust on global informational sources.

**Architecture:** A shared tag formatter and trust validator live in `@mcp-abap-adt/llm-agent`; the library
renders the tag in planner blocks and `ContextAssembler` when items carry trust. The hub resolves effective
trust (record → collection → class default from `LLM_AGENT_TRUST_DEFAULTS`), persists it, exposes admin setters
(REST + MCP, same tools on every connection) and attaches trust/source to every LLM-facing path.

**Tech Stack:** TypeScript, node:test (llm-agent), jest `--maxWorkers=1` (hub), SAP CAP, biome.

**Spec:** `docs/superpowers/specs/2026-11-01-source-trust-design.md`

## Global Constraints

- Trust is a number 0–5 with at most one decimal; anything else → `INVALID_TRUST` (400 on REST).
- Tag format exactly `[source: <class>:<name>; trust <n>]`, or `[source: <class>; trust <n>]` without a name;
  `<n>` printed without trailing `.0` (5, 4.5). Brackets in names escaped as `&#91;` / `&#93;`.
- Classes: `global`, `user`, `session`, `system`, `docs`. Built-in defaults
  `global=4.5,system=4.5,docs=3.5,user=3,session=2`; env `LLM_AGENT_TRUST_DEFAULTS` overrides per class.
- Agent preset (system prompt, base skills, corrections; `collectionKind === 'agents'` collections incl. user
  copies) and MCP tool groups are never tagged and never carry trust. Informational presets
  (`CollectionMeta.preset === true`, user scope) are ordinary class `user`: tagged and trusted.
- Only `MCP_Admin` changes trust, only on global informational sources; other sources → `TRUST_FIXED`.
- Same tools on every connection (agent MCP, OpenAI/Anthropic endpoints, WebUI, internal LLM).
- Static typing: no any/unknown except narrowed caught errors, no `as unknown as`, no silencing casts.
- A trust write invalidates only its own record/collection cache entry.
- Do not rewrite CHANGELOG history or historical specs.

## Review Focus

- Free-form record metadata containing `trust` or `trustHistory` on add/update/bulk/upload: stripped, never
  becomes the record's trust (Task 3).
- Trust values `"5"`, `4.55`, `-1`, `5.1`, `NaN`, `null` on every setter: `INVALID_TRUST`, `null` only clears a
  record override (Task 5).
- Collection/record/skill names containing `[`, `]` or `;`: tag stays parseable (Task 1, Task 6).
- Collections persisted before this change (no `trust` attribute) after restart: effective trust = class
  default, no write on read (Task 3).
- Truncated target-system results: tag present once, truncation marker count unchanged (Task 7).

---

### Task 1: Trust tag in llm-agent

Repo `C:\Users\OleksiiKyslytsia\projects\llm-agent`, branch `feat/trust-tag` from `origin/main`.

**Files:**
- Create: `packages/llm-agent/src/trust.ts`, `packages/llm-agent/src/trust.test.ts`
- Modify: `packages/llm-agent/src/index.ts` (export), `packages/llm-agent/src/interfaces/dialogue.ts:142-153`
  (`PlannerMemoryEntry`, `PlannerKnowledgeEntry` gain `trust?: number; source?: string`)
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/planner-retrieval.ts` (~line 50: knowledge and
  memory projections copy `metadata.trust` / `metadata.source` when they are a number / string),
  `packages/llm-agent-libs/src/coordinator/dialogue/planner-context-builder.ts` (labels),
  `packages/llm-agent-libs/src/context/context-assembler.ts:88-93` (`formatRagEntry`)
- Test: `packages/llm-agent-libs/src/__tests__/trust-tag.test.ts`
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/skill-select.ts` (~line 78) and
  `packages/llm-agent-libs/src/agent/rag-orchestrator.ts` (~line 300): in hard mode, when no skill name matches,
  load no skills instead of all skills (informational skills are semantic-only); add an option
  only if an existing consumer depends on the old fallback (check and document).
- Tool-result trust (one contract, all in this task): `ToolTrust = (toolName: string) => { source: string; trust: number } | undefined`
  exported from `@mcp-abap-adt/llm-agent`. Plumbing: `SmartAgentConfig.toolTrust?: ToolTrust` (set via
  `SmartAgentBuilder.withToolTrust(fn)`), `DialogueSessionOptions.toolTrust?: ToolTrust` (passed on to
  `PlannerToolsClient` and `tool-trace-render.ts`). Raw and model-facing values stay separate: availability checks, session logging, execution callbacks, trace
  capture, pending-result storage and `ToolRound.results` (recorded by context strategies, `tool-loop.ts`
  `batchRound` / `strategy.record`) keep the raw `text`. A single projection `toModelToolMessage(raw, toolTrust)`
  is applied when messages are handed to the LLM: the live tool messages of a round, replayed rounds from every
  context strategy, and pending results injected as messages (mixed-tool-call path). `ToolTrust` is wired through the tool-loop interfaces,
  `ContextAssemblerConfig` and `default-pipeline.ts`; `ContextAssembler` tool-history rendering;
  `tool-trace-render.ts` (checker evidence: the complete tag is rendered outside the JSON-quoted raw excerpt,
  e.g. `[source: system:GetClass; trust 4.5] result: "<escaped excerpt>"`, with its length reserved in the
  enclosing budget; the excerpt's own truncation is unchanged); and a `get_task` response projection in `planner-tools-client.ts`
  (~420) that tags each `toolTrace` result in a copy, never the board's stored task. Stored traces, outcome
  parsing and truncation counts stay untagged; a result is tagged once.
- Skill discovery: `skills/skill-utils.ts` `scanDirsForSkills` reports a name that appears in several directories
  with different front matter `kind` as an error before deduplication (`byName.set`), instead of silently keeping
  one.
- Rerankers: `reranker/llm-reranker.ts` (~128) and `reranker/decision-reranker.ts` (~155) render candidates with
  the same tag when `metadata.trust` is a number; relevance scoring is unchanged (no trust-based filtering).
- Changeset: minor for both packages.

**Interfaces:**
- Produces: `normalizeTrust(value: number): number | undefined` (rounds nothing; returns the value when
  0 ≤ v ≤ 5 and `Math.round(v*10) === v*10`, else undefined); `formatTrust(n: number): string` (`5`, `4.5`);
  `formatTrustTag(source: string | undefined, trust: number): string`; `escapeTrustName(s: string): string`.

- [ ] **Step 1: Failing tests**

```ts
test('formatTrustTag', () => {
  assert.equal(formatTrustTag('user:Notes/r1', 3), '[source: user:Notes/r1; trust 3]');
  assert.equal(formatTrustTag(undefined, 4.5), '[source: unknown; trust 4.5]');
  assert.equal(formatTrustTag('global:a[b]', 5), '[source: global:a&#91;b&#93;; trust 5]');
});
test('normalizeTrust', () => {
  for (const ok of [0, 2.5, 5]) assert.equal(normalizeTrust(ok), ok);
  for (const bad of [-1, 5.1, 4.55, Number.NaN]) assert.equal(normalizeTrust(bad), undefined);
});
// libs
test('planner knowledge label carries trust', () => {
  const [block] = renderPlannerRetrieval({ memory: [], knowledge: [{ collection: 'kb', id: 'r1', text: 't', trust: 4, source: 'user:kb/r1' }] });
  assert.match(block, /\(user:kb\/r1; trust 4\) t/); // entry.source replaces the collection/id label when present
  // trust without source → '(kb/r1; trust 4)'; source without trust → unchanged '(kb/r1)'
});
test('planner label without trust is unchanged', () => { /* (kb/r1) t */ });
test('memory label carries trust', () => { /* (planner-input s1 q1 offset 0; trust 2) text */ });
test('planner retrieval keeps trust and source from metadata', async () => {
  // knowledge result metadata { id: 'r1', trust: 4, source: 'user:kb/r1' } → entry.trust 4, entry.source 'user:kb/r1';
  // same through search_knowledge rendering and planner-create/revise context
});
test('hard-mode skill selection loads nothing when no skill matches (pipeline and rag-orchestrator)', () => { /* was: all skills */ });
test('checker evidence tag sits outside the quoted excerpt', () => {
  // exact tag text, excerpt truncation unchanged, very long tool name keeps a whole tag within budget
});
test('toolTrust tags model-facing tool results only', () => {
  // tool-loop-core message construction and pending-result injection: model message '[source: system:GetClass; trust 4.5]\n<result>',
  // internal consumers (availability check, session log, callbacks, pending store, recorded ToolRound) see the raw text;
  // replayed rounds from each context strategy reach the model with exactly one tag,
  // recorded invocation untagged; truncated result tagged once; tool without toolTrust answer untagged;
  // ContextAssembler history, checker evidence and get_task projection tagged once; board task unchanged
});
test('rerankers show the trust tag and keep relevance scoring', () => {});
test('skill discovery rejects one name with base and informational kinds across two directories', () => {});
test('ContextAssembler tags results with metadata.trust', () => {
  // RagResult { text: 'x', metadata: { trust: 3, source: 'user:Notes/r1' }, score: 0.9 } → "- [source: user:Notes/r1; trust 3] x"
  // without metadata.trust → "- x"; non-number trust → "- x"
});
```

- [ ] **Step 2:** Run `npm test` in both packages (on Windows: `node --import tsx/esm --test` with expanded
  globs) — new tests FAIL.
- [ ] **Step 3:** Implement. `formatRagEntry` reads `typeof r.metadata.trust === 'number'` and
  `typeof r.metadata.source === 'string'`; provenance score annotation stays as is after the text.
- [ ] **Step 4:** Tests, `npm run typecheck`, `npm run lint:check` pass.
- [ ] **Step 5:** Commit `feat(context): trust tag for planner retrieval and context assembler`. PR, Codex
  review, merge, release (version PR → signed tags → user publishes npm). Hub tasks use the new versions.

### Task 2: Trust classes and defaults (hub)

Hub branch `feat/source-trust` from the reviewed `design/source-trust` head (spec + plan), rebased on current
`main`.

**Files:**
- Create: `srv/lib/trust.ts`, `test/unit/trust.test.ts`
- Modify: `srv/agent-config.ts` (parse `LLM_AGENT_TRUST_DEFAULTS` at startup, expose `config.trust.defaults`)

**Interfaces:**
- Produces: `type TrustClass = 'global' | 'user' | 'session' | 'system' | 'docs'`;
  `parseTrustDefaults(value: string | undefined): Record<TrustClass, number>` (throws
  `BuildValidationError` naming the bad entry); `classForScope(scope: 'global' | 'user' | 'session'): TrustClass`;
  `effectiveTrust(input: { record?: number; collection?: number; scope: 'global' | 'user' | 'session' }, defaults: Record<TrustClass, number>): number`.

- [ ] **Step 1: Failing tests**

```ts
expect(parseTrustDefaults(undefined)).toEqual({ global: 4.5, system: 4.5, docs: 3.5, user: 3, session: 2 });
expect(parseTrustDefaults('user=4,session=1.5')).toEqual({ global: 4.5, system: 4.5, docs: 3.5, user: 4, session: 1.5 });
for (const bad of ['user=6', 'user=x', 'nope=1', 'user', 'user=4.55'])
  expect(() => parseTrustDefaults(bad)).toThrow(/LLM_AGENT_TRUST_DEFAULTS/);
expect(effectiveTrust({ record: 1, collection: 4, scope: 'user' }, d)).toBe(1);
expect(effectiveTrust({ collection: 4, scope: 'user' }, d)).toBe(4);
expect(effectiveTrust({ scope: 'session' }, d)).toBe(2);
```

- [ ] **Step 2–4:** Fail, implement (uses `normalizeTrust` from Task 1), pass; tsc both configs, lint.
- [ ] **Step 5:** Commit `feat(trust): trust classes and deploy defaults`.

### Task 3: Persist collection and record trust

**Files:**
- Modify: `srv/rag-collections.ts:165-196` (`CollectionMeta.trust?: number`, `trustHistory?: TrustHistoryEntry[]`),
  `srv/lib/collection-persistence.ts` (`encodeAttributes` `:96`, `decodeRecord` `:129`,
  `canonicalCollectionMeta` `:413` — all three handle both `trust` and `trustHistory` (JSON array, last 20);
  value and history are written in one update; record payload `:482`, `restoredDocument`),
  `srv/lib/record-policy.ts:27` (new signature below) and every caller of `recordAttributes`

Record trust is stored in dedicated payload fields `_trust` / `_trustHistory`, written only by the trust
setter and restored explicitly; they are not part of `PAYLOAD_BOOKKEEPING` (which would also drop them on
restore). Two separate paths: (1) `sanitizeExternalMetadata()` strips `trust`, `trustHistory`, `_trust`, `_trustHistory`
from caller-supplied metadata in add, update, bulk and upload, before anything else; (2) internal persistence
(`ownMetadata()`, payload construction, restore, content replacement) carries `_trust` / `_trustHistory`
through untouched. On `RagDocument` the trusted values live in `metadata._trust` / `metadata._trustHistory`
(written only by the setter); query projections read them from the stored payload. The existing metadata `source` (uploaded file name: upload grouping,
source toggles, WebUI reassembly/export) is kept as is; trust provenance never reads it — every projection
derives provenance from the collection context instead. Content updates preserve `_trust` / `_trustHistory`.
- Test: `test/unit/collection-trust-persistence.test.ts` (PGlite)

**Interfaces:**
- Produces: `documentView(doc: RagDocument, collection: CollectionMeta, defaults): (RagDocument & { enabled: boolean; trusted: true; trust: number; trustOverride?: number; source: string }) | (RagDocument & { enabled: boolean; trusted: false })`
  — `trusted: false` without trust fields for agent-preset collections. `RecordTrustView = { trusted: true; trust: number; trustOverride?: number; source: string } | { trusted: false }`
  is the one shared union; `defaults: Record<TrustClass, number>`. Projections are synchronous over a
  pre-resolved input: `TrustInput = { class: TrustClass; source: string; collectionTrust?: number; recordTrust?: number }`.
  Catalog collections build it from meta and `_trust`; the `@skills` source builds it with
  `await TrustStore.getSource/getRecord` before projecting, so REST and MCP share one projection for both.
  — the one projection for REST document listings and reads (`srv/rag-handler.ts` ~708, ~911) and the virtual
  `@skills` listing; `recordAttributes` (MCP) uses the same resolution.
- Produces: `collectionView(meta: CollectionMeta, defaults): (CollectionMeta & { trusted: true; trust: number; trustOverride?: number; trustClass: TrustClass }) | (CollectionMeta & { trusted: false })`
  — `trusted: false` for agent-preset collections (`collectionKind === 'agents'`), with no trust fields
  — the one response projection for `GET /rag/collections` (ordinary and virtual rows) and collection tools;
  it never writes defaults back to persisted metadata.
- Produces: `TrustHistoryEntry = { from: number | null; to: number | null; actor: string; at: string }`
  (max 20, newest last); `recordAttributes(doc: RagDocument, collection: CollectionMeta, defaults: Record<TrustClass, number>): { enabled: boolean } & RecordTrustView`
  (was `recordAttributes(metadata)`; callers to update: `rag_read`, hidden-record reads and `collection_records` in
  `srv/agent-mcp-rag.ts`, and any other caller found by `grep recordAttributes`) where `trust` is effective and
  `source` is `<class>:<collection displayName>/<record id>`.

- [ ] **Step 1: Failing tests:** round-trip collection `trust: 4` + `trustHistory` and record `_trust: 1.5` +
  `_trustHistory` through PGlite restore (restart keeps values and the last 20 history entries); a content update keeps the record override; add / update / bulk / upload with
  metadata `{ trust: 5, trustHistory: [], _trust: 5, _trustHistory: [] }` store none of them, while an existing
  override survives update, restart and content replacement; upload keeps `metadata.source` (file name) and source toggles, chunk
  grouping and export still work; REST document listing shows inherited trust, a record override, and inherited
  again after the override is cleared (for a catalog collection and for `@skills`, including a live change of
  the `@skills` source value); an agents collection lists as `trusted: false` without trust fields, and its documents (REST list/read, MCP
  `rag_read` / `collection_records`) carry no trust fields either; collection stored without `trust` restores with `trust` undefined and `recordAttributes` reports the
  class default; record added with metadata `{ trust: 5, trustHistory: [] }` stores neither key (stripped);
  history keeps the last 20 entries.
- [ ] **Step 2–4:** Fail, implement, pass; full jest for persistence suites.
- [ ] **Step 5:** Commit `feat(trust): persist collection and record trust`.

### Task 4: Global informational skills and the trust store

**Files:**
- Create: `srv/lib/trust-store.ts` (hub-internal store `h_trust`, same provider pattern as `h_sessions`),
  `srv/lib/trust-resolver.ts` (contract in the cache section below)
- Modify: `srv/lib/skills-pool.ts` (read front matter `kind: base | informational`, default `informational`),
  `srv/lib/collection-persistence.ts` orphan-sweep exclusion lists (~lines 794–797 and 863–866: add the
  `h_trust` predicate, including prefixed provider names)
- Test: `test/unit/trust-store.test.ts`, `test/unit/skills-kind.test.ts`

**Interfaces:**
- Produces: `TrustStore.getSource(source: 'skills'): Promise<number | undefined>`,
  `TrustStore.setSource(source: 'skills', trust: number, actor: string): Promise<void>`,
  `TrustStore.getRecord(source: 'skills', record: string): Promise<number | undefined>`,
  `TrustStore.setRecord(source: 'skills', record: string, trust: number | null, actor: string): Promise<void>`
  (value and history written in one record; `getSourceHistory` / `getRecordHistory` return the last 20);
  resolution record override → source value → `global` default;
  `skillKind(name: string): 'base' | 'informational'`.

- [ ] **Step 1: Failing tests:** set/get/clear round-trip on PGlite for source and record; a record override
  does not change sibling records; clearing a record override falls back to the source value; a write
  invalidates only that key; orphan sweep keeps `h_trust`; history survives a restart; skill without `kind` is informational; `kind: base`
  is reported base.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit `feat(trust): trust store and skill kinds`.

Cache contract (applies to Tasks 3–7): effective trust is resolved live on every read through one
`TrustResolver` created at startup with the registry, the `TrustStore` (initialized on the same RAG provider as
the other `h_*` stores) and the defaults. Collection trust is read from the registry's current meta, never
captured when a long-lived store wrapper is built. `TrustStore` is a persistence facade without its own cache:
caching stays in the DB provider (cache-only-in-DB-provider rule) with key-scoped invalidation, so a write
invalidates only its own record, collection or source entry.

`TrustResolver` (`srv/lib/trust-resolver.ts`, created in Task 4, wired at startup in `srv/agent-manager.ts` next to
the registry): `classDefault(c: TrustClass): number` and `systemTool(name: string): number` are synchronous
(defaults only — `ToolTrust` is synchronous); `collection(meta: CollectionMeta): number`,
`record(doc: RagDocument, meta: CollectionMeta): number` are synchronous over the registry's current meta and the
stored `_trust`; `skill(name: string): Promise<number>` awaits `TrustStore`.

### Task 5: Admin setters (REST + MCP)

**Files:**
- Create: `srv/lib/trust-guard.ts` — zod schemas `collectionTrustArgs` (`trust: number`) and `recordTrustArgs`
  (`trust: number | null`) refined with `normalizeTrust`; REST bodies and MCP tool arguments are parsed by these
  schemas where they enter (the MCP tool definitions already validate with zod), and only the inferred types
  travel further. Then
  `trustWriteError(input: { admin: boolean; target: TrustTarget; value: number | null; allowNull: boolean }): { status: 400 | 403 | 404 | 409; code: 'INVALID_TRUST' | 'FORBIDDEN' | 'NOT_FOUND' | 'TRUST_FIXED' } | undefined`,
  the trust policy used by REST, MCP and `@skills`. Validation failures of these schemas (wrong type, out of
  range, two decimals, `null` on the collection setter) are mapped explicitly to `INVALID_TRUST` (REST 400; MCP
  tool error code `INVALID_TRUST`), not to the generic argument-validation error. It runs after the existing `collectionAccessError`
  visibility/ownership check (pending agent copies stay hidden, inaccessible collections stay `NOT_FOUND`), and
  adds the stricter admin + global-informational rule on top
- Modify: `srv/rag-handler.ts` (`PUT /rag/collections/:id` accepts `trust`; new
  `PATCH /rag/collections/:id/documents/:did/trust`; virtual source `@skills` is routed before the registry
  middleware: `GET /rag/collections` lists it (class `global`, effective trust),
  `GET /rag/collections/@skills/documents` lists informational skills with `trust` / `trustOverride`, and both
  setters accept it), `srv/lib/rag-tool-catalogue.ts` (two tools),
  `srv/agent-mcp-rag.ts` (handlers), `srv/lib/rag-write-operations.ts` (shared write path),
  `srv/rag-collections.ts:1224` (`updateCollection` accepts trust)
- Test: `test/unit/trust-setters.test.ts`

**Interfaces:**
- Produces: MCP `collection_set_trust({ collection: string, trust: number })`,
  `record_set_trust({ collection: string, record: string, trust: number | null })`, effect `write`.
  `collection: '@skills'` addresses global informational skills (record = skill name) via Task 4.
  Errors: non-admin → `FORBIDDEN` (403); non-global or agent-preset source (`collectionKind === 'agents'`, base skills, MCP tool groups) and
  user/session collections including informational presets → `TRUST_FIXED` (409); invalid value → `INVALID_TRUST` (400); unknown → `NOT_FOUND` (404).

- [ ] **Step 1: Failing tests:** admin sets source `@skills` to 3 → every informational skill effective 3;
  admin sets `@skills/<informational>` to 2 → that one 2, siblings 3; `collection_set_trust` with `null` →
  `INVALID_TRUST`; a real user collection with logical id `skills` stays reachable and unaffected through REST and
  MCP (`@skills` cannot collide: logical ids match `^[a-z0-9][a-z0-9_-]*$`); non-admin → 403 /
  `FORBIDDEN`; user collection → `TRUST_FIXED`; informational preset (`preset: true`) → `TRUST_FIXED` but its hits are tagged
  `user` (Task 6); agents collection → `TRUST_FIXED`; base skill → `TRUST_FIXED`;
  values `"5"`, `4.55`, `-1`, `5.1`, `NaN` → `INVALID_TRUST`; `null` on `record_set_trust` clears;
  malformed values asserted through REST dispatch and MCP tool dispatch (status / error code), not only
  through the schema; both tools are listed by `eligibleRagTools()` wherever the other write RAG tools are
  (agent MCP and internal catalogues; parity test), and, like them, are hidden in read-only mode and by profile
  ceilings (the same-tools rule keeps ceilings); a non-admin sees them and gets `FORBIDDEN` on call; a pending agent copy and another
  user's agents collection stay `NOT_FOUND` for admin and non-admin alike; another user's ordinary collection
  stays visible to the admin (existing policy) and returns `TRUST_FIXED`.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit `feat(trust): admin trust setters`.

### Task 6: Tag RAG paths

**Files:**
- Modify: `srv/agent-mcp-rag.ts:538-645` (`rag_search` hits gain `source`, `trust`), `:681-724` (`rag_read`,
  `collection_records` via `recordAttributes`), `srv/lib/collection-retrieval.ts:188-284` (chat auto-retrieval
  joins tagged hits; the injected `CollectionSearchRag` stores receive the trusted collection context and
  overwrite `metadata.trust` / `metadata.source` with derived values, so stored metadata cannot impersonate
  `system`),
  `srv/lib/session-history-rag.ts` (class `session`), `srv/lib/planner-memory.ts`
  (`scopedPlannerMemory(...)` ~line 89 — the coordinator's memory store — is wrapped so every query result gets
  class `session` trust and source, overwriting stored values; `plannerSessionOptions()` wraps each
  `registry.getRagStore(id)` in the same trust-enriching store as chat
  retrieval instead of passing it raw; `planAuthorContextNotes()` ~line 201 builds its own memory entries and
  gets `trust`/`source` too), `srv/lib/planner-context.ts`. Enrichment always resolves effective trust
  (`_trust` → collection → default) and overwrites any `metadata.trust`/`metadata.source`, so old records without
  trust and records with spoofed provenance render correctly.
- Modify: `srv/lib/dialogue-attachments.ts` and `srv/lib/dialogue-planner-content.ts` (~72, `[attached files]`):
  each attached document preview starts with its tag (provenance from the collection meta via
  `TrustResolver`); the tag counts toward the preview budget and is never truncated.
- Test: `test/unit/trust-tags-rag.test.ts`

- [ ] **Step 1: Failing tests:** exact strings — chat retrieval block contains
  `[source: user:Notes/r1; trust 3]\n<text>`; `rag_search` hit JSON has `"source":"user:Notes/r1","trust":3`;
  planner block line `(user:Notes/r1; trust 3) <text>` (coordinator, plan author and `search_knowledge`
  output); session history item `[source: session; trust 2]`; a record
  override 1 beats collection 4; a name with `[x]` is escaped; a record whose free-form metadata claims
  `source: 'system:x'` is rendered with its real source; both chat auto-retrieval and library pipeline retrieval
  (`ContextAssembler`) show the tag; coordinator retrieval, `search_knowledge` and planner-create/revise context
  show it for old records without trust and for records with spoofed metadata; each `[attached files]` entry
  carries a whole tag even when the preview is truncated; after an admin changes a
  collection's or the `@skills` source's trust, an already-built agent's next retrieval shows the new value (record and source writes, no second cache); coordinator recall of
  planner-memory records written before this change shows `; trust 2`.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit `feat(trust): tag RAG paths`.

### Task 7: Tag target-system results and informational skills

**Files:**
- Create: `srv/lib/system-tool-trust.ts` — `systemToolTrust(isSystemTool: (name: string) => boolean, resolver: TrustResolver): ToolTrust`
  answering `{ source: 'system:<tool>', trust }` only for names in the embedded mcp-abap-adt registry
  (`buildEmbeddedMcpAdapter`, ~`srv/agent-manager.ts:2367`); hub RAG and orchestration tools get `undefined`.
- Modify: inject it everywhere a builder or dialogue session is created: `configureDestinationAgentBuilder`
  (~2736, `withToolTrust`), planner construction (~2882), destination recording (~3130), executor/checker workers
  and `DialogueSession.open` (`toolTrust`). No client decorator; recording clients are unchanged.
- Modify: `srv/lib/step-reviewer.ts` (~69–137): `describeTool()` and `renderHistory()` add the system tag to
  embedded-tool outcomes in the critic messages they build; `parseToolOutcome()`, recordings and truncation
  measurements stay raw.
- Create: `srv/lib/trusted-skill.ts` — `withSkillTrust(skill: ISkill, trust: () => Promise<number>): ISkill`, a
  wrapper preserving every other skill method and metadata, whose `getContent` prefixes
  `[source: global:skills/<name>; trust n]` resolved live (no cached value).
- Modify: `srv/lib/composite-skill-manager.ts` (`getSkill`, `matchSkills`, `listSkills` return wrapped
  informational skills; base skills unwrapped).
- Modify: the tools/skills RAG store in `srv/agent-manager.ts` (skills vectorized as `skill:<name>`
  descriptions, rendered by `ContextAssembler` from `ctx.ragResults`): wrap it so informational `skill:*` results
  get live `metadata.trust` / `metadata.source` (`global:skills/<name>`) on every query; MCP tool-group entries
  stay untagged. Rendering stays in the library (`skill-select.ts`,
  `rag-orchestrator.ts`), which calls `getContent` — test both paths.
- Test: `test/unit/trust-tags-tools.test.ts`

- [ ] **Step 1: Failing tests (each chain: chat, planner, executor, checker):** an embedded SAP tool result
  reaches the LLM as
  `[source: system:GetClass; trust 4.5]\n<result>`; the recorded result and reviewer `parseToolOutcome` input
  are untagged; a truncated result has the tag once and the same truncation marker; RAG and orchestration tool
  results are untagged; replayed tool history and checker evidence / `get_task` traces of
  an embedded SAP call show the tag once, stored traces do not; the step reviewer's critic messages show the tag
  for embedded-tool outcomes; informational skill content starts with `[source: global:skills/<name>; trust 4.5]`,
  base skill content has no tag; after `setRecord` on an
  already-built agent the next `getContent` and the next retrieved `skill:<name>` description both show the new
  trust; tool-group entries in the same store stay untagged.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit `feat(trust): tag system results and informational skills`.

### Task 7b: Base skills load directly

The spec loads the agent preset (system prompt, base skills, corrections) without semantic search. Today all
file skills go through semantic selection (library `pipeline/handlers/skill-select.ts`).

**Files:**
- Modify: `srv/lib/skills-pool.ts` / `srv/lib/composite-skill-manager.ts` — two views over the same pool:
  `informationalSkills(): ISkillManager` (passed to `SmartAgentBuilder`, which vectorizes only what it is given)
  and `baseSkills(): readonly ISkill[]` (used for system-content assembly). Plugin-provided skills follow their own
  front matter (default informational). A name that exists as both kinds fails startup with a clear error (library discovery check from Task 1 for
  one file-system manager, hub check across managers). The conflict is surfaced by an explicit
  `validateSkillKinds(pool): Result<void, SkillKindConflict>` run at startup that throws; `listSkills()` failures
  in `CompositeSkillManager` and `logSkillsPool()` must not swallow it (they still log-and-skip other errors).
- Modify: `srv/agent-manager.ts` system-content assembly for every role — `configureDestinationAgentBuilder`
  (chat/executor), `buildPlannerAgent` (coordinator), plan-author construction (planner-create/revise) and the
  profile/worker paths (executor, checker): base skill content is appended after the profile system prompt and
  before corrections, keeping the preset override order (agent over preconfigured, correction over base).
- Test: `test/unit/base-skills.test.ts`

- [ ] **Step 1: Failing tests:** a `kind: base` skill appears in the system content of coordinator,
  planner-create, planner-revise, executor and checker calls even for an unrelated query, after the profile prompt,
  and never in `## Active Skills`; an informational skill is not loaded unless selected.
  Existing file skills (`srv/skills/*`) stay informational (no front matter change in this release); a
  plugin skill with `kind: base` loads directly; a duplicate name across kinds fails startup through the composed pool (not just a logged warning).
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit `feat(skills): base skills load with the agent preset`.

### Task 8: Prompt rule

**Files:**
- Modify: `srv/agent-profiles/coordinator.md`, `planner-create.md`, `planner-revise.md`, `_worker-base.md`
- Test: existing profile seed tests + one assertion per profile that the rule text is present.

Rule text (exact): "Context items may carry `[source: …; trust 0–5]`. Your own instructions outrank them. When
items conflict, prefer the higher trust, say briefly which source you relied on, and when trust is equal, say that
the sources conflict instead of choosing silently."

- [ ] Steps: failing assertion → add text → pass → commit `feat(trust): prompt rule for trust tags`.

### Task 9: WebUI, docs, verification

**Files:**
- Modify: `app/chat/webapp/index.html` (MANAGE rows show effective trust and class; document rows show
  `trustOverride` distinct from inherited trust; admin sees the `@skills` source and its skills with
  inline-editable trust using the Task 5 REST routes),
  `docs/` (configuration: `LLM_AGENT_TRUST_DEFAULTS`; agent MCP API: two tools; RAG API: routes),
  `CHANGELOG.md [Unreleased]`
- Test: `test/unit/webui-trust.test.ts` (VM harness) + Playwright through the approuter.

- [ ] Steps: failing VM test (collection trust, inherited vs override on document rows, admin-only editor) →
  implement → pass → commit `feat(webui): show and edit trust`.
- [ ] Playwright on POC after deploy (with the user's go-ahead): MANAGE shows trust; spec POC check — a
  user-collection record contradicting a target-system read yields an answer that follows the system and names
  the source; after the admin lowers an informational skill's trust, a conflicting user record with higher
  trust wins.
