# Phase 1 — Mechanical GetDumpSection + Principal-Scoped Dump Buffer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the executor read/analyse a large ST22 dump through one mechanical, RAG-selected `GetDumpSection` tool that returns a small **section index** or a single **de-padded chapter** from a principal-scoped in-memory buffer — so a 185K-token dump never enters the LLM context whole.

**Architecture:** cloud-llm-hub only, no core change. The tool wraps the existing `RuntimeGetDumpById` (fetched once via the in-process embedded MCP client), parses it with the lifted `parseDump`/`MAJOR_TITLES`, de-pads, and serves chapters from a `DumpBufferStore` (default in-memory LRU) keyed by `{ principalHash, resolvedDestination, effectiveClient, dump_id }`. "Analyse vs read" is the executor's reasoning (guided by the updated `reading-short-dumps` skill); the tool is purely mechanical.

**Tech Stack:** TypeScript (CommonJS), `@sap/cds`, `@modelcontextprotocol/sdk`, Jest, Biome.

## Global Constraints

- **Cache only immutable artifacts.** A dump by id never changes → no validation. No aggregates, no single-object caching in Phase 1.
- **Buffer behind an injected interface (DI).** `DumpBufferStore` is an interface; the default impl is in-memory, **LRU + total-bytes bounded** (must not reintroduce the OOM v6.24.5/6.25.0 fought), **absolute TTL** (no stable session on the stateless planner surface), **does not survive restart**. A persistent/cross-instance adapter can be injected later without touching the tool.
- **Buffer key = `{ principalHash, resolvedDestination, effectiveClient, dump_id }`.** `effectiveClient = x-sap-client override if present, else the destination's resolved sap-client` (the override is applied AFTER `resolveDestinationSapConfig` in `srv/agent-mcp.ts` / `srv/lib/request-connection.ts`).
- **`principalHash` = `hash(canonicalTuple([cds.context.user.id, authMode, resolvedSapIdentity ?? null, jwtSub ?? null]))`** — WHO only (destination/client are separate key parts). Canonical tuple encoding, **not** raw concatenation. Each component deterministic (value-or-`null`, same on every code path). `resolvedSapIdentity` = `x-sap-login` (basic), destination `User` (service user), or **absent** (principal propagation — no backend round-trip).
- **Fail closed.** If `cds.context.user.id` is missing or `'anonymous'`, `GetDumpSection` **refuses** — no shared-principal buffer, no anonymous fresh fetch.
- **Raw SAP login never in a key, file, or log.** The buffer key carries only `principalHash`. The XSUAA `cds.context.user.id` is a normal diagnostic id and stays in logs.
- **RAG-selected via the SHARED corpus.** The corpus is assembled from `HandlerExporter` via `getStaticTools()` / `getSharedCorpusDocs()` (`srv/agent-manager.ts`), and `tools/generate-tool-embeddings.ts` reads `getSharedCorpusDocs()` too. **Appending to `listToolsHandler` alone will NOT make the tool RAG-selectable** — a **cloud-local tool registry** must be merged into `getStaticTools`/`getSharedCorpusDocs` + the exposition map + `listToolsHandler` + `callToolHandler`. **No `HandlerExporter`/core change** (we merge alongside); our own corpus-assembly functions do change.
- **The `callToolHandler` inside `buildEmbeddedMcpAdapter` has no `req`** — the ALS store is only `{ connection, context }` (`srv/agent-manager.ts`). The principal + system scope must be **computed where `req` exists** (`srv/agent-mcp.ts` `execute_step`) and **carried into the ALS store**, then read back in the tool branch.
- **Reuse `parseDump`/`MAJOR_TITLES`** (lift into `srv/lib/`), do not reinvent. Canonical chapter titles only.
- English everywhere; single quotes, 2-space indent, 100-col; Biome clean; `tsc` clean; Conventional Commits; a test per unit.

---

## File Structure

- Create `srv/lib/dump-parser.ts` — lifted `parseDump` + `MAJOR_TITLES` + de-pad + section-index/single-section helpers. Self-contained (inline the ~5 needed types).
- Create `srv/lib/principal.ts` — `principalHash(...)`, `resolveSystemScope(...)`, `resolvePrincipal(...)` (null ⇒ fail closed).
- Create `srv/lib/dump-buffer.ts` — `DumpBufferStore` interface + `InMemoryLruDumpBuffer` + `makeDefaultDumpBuffer(env)`.
- Create `srv/lib/get-dump-section.ts` — `getDumpSectionResult(args, deps)` handler.
- Create `srv/lib/cloud-local-tools.ts` — the cloud-local tool registry (`GetDumpSection` def: name, description, inputSchema, exposition tag) + a merge helper.
- Modify `srv/agent-manager.ts` — merge the cloud-local registry into `getStaticTools`/`getSharedCorpusDocs` + the exposition map; extend the ALS store type + `runWithRequestConnection`/`setRequestConnection` with a `dumpScope`; register `GetDumpSection` in `buildEmbeddedMcpAdapter` (`listToolsHandler` + `callToolHandler`).
- Modify `srv/agent-mcp.ts` — compute `principalHash` + system scope at `execute_step` and pass into `runWithRequestConnection` (into the ALS store).
- Modify `srv/tool-intents.json` (+ regenerate `srv/tool-embeddings.json`) — add the `GetDumpSection` intent.
- Modify `srv/skills/reading-short-dumps/SKILL.md` — index-first `GetDumpSection` flow.
- Modify `srv/lib/request-connection.ts`, `srv/mcp-proxy.ts`, `srv/mcp-manager.ts` — mask the raw SAP login in structured logs.
- Tests: `test/unit/{dump-parser,principal,dump-buffer,get-dump-section,cloud-local-tools}.test.ts` + fixture `test/unit/fixtures/zdemo01-dump.formatted.txt`.

---

### Task 1: Lift the dump parser into `srv/lib/` + add de-pad and section API

**Files:** Create `srv/lib/dump-parser.ts`; Test `test/unit/dump-parser.test.ts`; Fixture `test/unit/fixtures/zdemo01-dump.formatted.txt` (raw formatted ZDEMO01_C_BOOK pipe text from `/tmp/developer-latest-dump.md`, markdown fence stripped).

**Interfaces produced:** `parseDump(system, dumpId, payload): ParsedDump`, `MAJOR_TITLES: ReadonlySet<string>`, `dumpSectionIndex(payload): string[]`, `getDumpSection(payload, title): string | null`, `dePad(text): string`.

- [ ] **Step 1: Save the fixture** — raw pipe text containing `Runtime Errors  RAISE_SHORTDUMP`, `Except.  CX_SADL_DUMP_APPL_MODEL_ERROR`, an `Error analysis` chapter with `CX_RAP_HANDLER_NOT_IMPLEMENTED` + `ZDEMO01_C_BOOK`, and a `Source Code Extract` chapter.

- [ ] **Step 2: Write the failing test:**
```ts
import fs from 'node:fs';
import path from 'node:path';
import { parseDump, MAJOR_TITLES, dumpSectionIndex, getDumpSection } from '../../srv/lib/dump-parser';
const payload = fs.readFileSync(path.join(__dirname, 'fixtures/zdemo01-dump.formatted.txt'), 'utf8');
describe('dump-parser (lifted)', () => {
  it('parses the header', () => {
    const d = parseDump('DEV', 'x', payload);
    expect(d.header.runtimeError).toBe('RAISE_SHORTDUMP');
    expect(d.header.exceptionClass).toBe('CX_SADL_DUMP_APPL_MODEL_ERROR');
  });
  it('index lists present chapters, all canonical', () => {
    const idx = dumpSectionIndex(payload);
    expect(idx).toContain('Error analysis');
    for (const t of idx) expect(MAJOR_TITLES.has(t)).toBe(true);
  });
  it('getDumpSection returns one de-padded chapter or null', () => {
    const ea = getDumpSection(payload, 'Error analysis');
    expect(ea).toContain('CX_RAP_HANDLER_NOT_IMPLEMENTED');
    for (const line of ea!.split('\n')) expect(line).not.toMatch(/\s{4,}$/);
    expect(getDumpSection(payload, 'No Such Chapter')).toBeNull();
    expect(ea!.length).toBeLessThan(payload.length / 4);
  });
});
```

- [ ] **Step 3: Run, confirm fail.**
- [ ] **Step 4: Implement** — copy `docs/examples/abap-dump-monitor/srv/dump-parser.ts` verbatim; inline the `DumpHeader`/`CallFrame`/`VariableSnapshot`/`SourceExtract`/`ParsedDump` types from that project's `interfaces.ts`; `export` `MAJOR_TITLES`; add `dumpSectionIndex`, `dePad`, `getDumpSection` (as in the design spec — index via `MAJOR_TITLES` + `pipeContent`; `getDumpSection` = `dePad(extractSection(payload, title))`).
- [ ] **Step 5: Green. Step 6: Commit** — `feat(dump): lift parseDump/MAJOR_TITLES into srv/lib + section index/de-pad`.

---

### Task 2: Principal + system-scope resolution (`srv/lib/principal.ts`)

**Files:** Create `srv/lib/principal.ts`; Test `test/unit/principal.test.ts`.
**Interfaces:** `principalHash(input): string`, `resolveSystemScope(rawClient, resolved): { resolvedDestination, effectiveClient }`, `resolvePrincipal(ctx): { principalHash } | null`.

- [ ] **Step 1: Write the failing test** — canonical tuple (no `"ab"+"c"` vs `"a"+"bc"` collision); deterministic (absent = null every call); hash never contains the raw login; `resolveSystemScope` header-override-wins-else-default (both collapse); `resolvePrincipal` null on missing/`'anonymous'`. (Full assertions as in the design spec.)
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** — `createHash('sha256').update(JSON.stringify([cdsUserId, authMode, resolvedSapIdentity ?? null, jwtSub ?? null])).digest('hex')`; `resolveSystemScope` = `{ resolvedDestination: resolved.destinationName, effectiveClient: (rawClient?.trim() || resolved.client || '').trim() }`; `resolvePrincipal` returns `null` if `!cdsUserId || cdsUserId === 'anonymous'`.
- [ ] **Step 4: Green. Step 5: Commit** — `feat(principal): principalHash canonical tuple + system scope + fail-closed`.

---

### Task 3: `DumpBufferStore` interface + in-memory LRU adapter (`srv/lib/dump-buffer.ts`)

**Files:** Create `srv/lib/dump-buffer.ts`; Test `test/unit/dump-buffer.test.ts`.
**Interfaces:** `DumpBufferKey`, `DumpBufferStore { get, set }`, `class InMemoryLruDumpBuffer implements DumpBufferStore` (ctor `{ maxEntries, maxBytes, ttlMs, now? }`), `makeDefaultDumpBuffer(env)` (reads `LLM_AGENT_DUMP_BUFFER_MAX_ENTRIES`=32, `_MAX_BYTES`=64_000_000, `_TTL_MS`=600_000).

- [ ] **Step 1: Write the failing test** — set/get round-trip; isolation by `principalHash`; LRU eviction past `maxEntries`; total-bytes eviction; TTL expiry via injected `now`. (Assertions as in the design spec.)
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** — `Map` keyed by `JSON.stringify([principalHash, resolvedDestination, effectiveClient, dumpId])`; entry `{ value, bytes: value.raw.length, expiresAt }`; `set` → MRU + evict while `size > maxEntries || totalBytes > maxBytes`; `get` → drop-if-expired else refresh recency.
- [ ] **Step 4: Green. Step 5: Commit** — `feat(dump-buffer): DumpBufferStore iface + bounded in-memory LRU adapter`.

---

### Task 4: `GetDumpSection` handler logic (`srv/lib/get-dump-section.ts`)

**Files:** Create `srv/lib/get-dump-section.ts`; Test `test/unit/get-dump-section.test.ts`.
**Interface:** `getDumpSectionResult(args: { dumpId; section? }, deps: { key: DumpBufferKey; buffer: DumpBufferStore; fetchFormatted: (dumpId) => Promise<string> }): Promise<{ dumpId; index?; section?; text? }>` — `section` omitted → `{ dumpId, index }`; given → `{ dumpId, section, text }` or throw with the valid list; fetches via `fetchFormatted` **only on a buffer miss**, then `buffer.set`.

- [ ] **Step 1: Write the failing test** — inject a fake buffer + a `fetchFormatted` spy over the Task-1 fixture; assert: first call fetches once + caches; second does NOT re-fetch; no `section` → index; valid `section` → de-padded text; invalid section throws listing valid ones.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** — on miss: `raw = await fetchFormatted(dumpId)`; `index = dumpSectionIndex(raw)`; `buffer.set(key, { index, raw })`. Serve from `{ index, raw }`.
- [ ] **Step 4: Green. Step 5: Commit** — `feat(dump): GetDumpSection handler (buffer-once, serve index/section)`.

---

### Task 5: Cloud-local tool registry → merge `GetDumpSection` into the shared corpus (F1)

**Files:** Create `srv/lib/cloud-local-tools.ts`; Test `test/unit/cloud-local-tools.test.ts`; Modify `srv/agent-manager.ts` (`getStaticTools`/`getSharedCorpusDocs` + the exposition map).

**Interfaces:**
- Consumes: the `ToolDocInput` shape (`srv/agent-manager.ts:828`) and the exposition-map builder.
- Produces: `CLOUD_LOCAL_TOOLS: ToolDocInput[]` (one entry: `GetDumpSection`, `inputSchema` = `{ dump_id: string (required), section?: string }`, a one-line mechanical description, exposition tag `'system'` — dumps require MCP_Analyst, same tier as `RuntimeGetDumpById`) and a `mergeCloudLocalTools(tools: ToolDocInput[]): ToolDocInput[]`.

- [ ] **Step 1: Write the failing test** — `mergeCloudLocalTools([])` contains a `GetDumpSection` entry with exposition `'system'` and a `dump_id` param; and (integration) `getStaticTools()` includes `GetDumpSection` after wiring.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement `cloud-local-tools.ts`** — export `CLOUD_LOCAL_TOOLS` + `mergeCloudLocalTools`. In `srv/agent-manager.ts`, call `mergeCloudLocalTools(...)` inside `getStaticTools()` (so `getSharedCorpusDocs()` and the generator both include it) and make the exposition-map builder tag `GetDumpSection` `'system'`. Do **not** touch `HandlerExporter`.
- [ ] **Step 4: Green — also assert `getSharedCorpusDocs()` now yields a `GetDumpSection` doc.**
- [ ] **Step 5: Commit** — `feat(tool-rag): cloud-local tool registry; merge GetDumpSection into the shared corpus`.

---

### Task 6: Carry principal/scope through ALS + register `GetDumpSection` in the embedded adapter (F2)

**Files:** Modify `srv/agent-manager.ts` (ALS store type, `runWithRequestConnection`, `buildEmbeddedMcpAdapter`), `srv/agent-mcp.ts` (`execute_step`).

**Interfaces:**
- Consumes: Tasks 1–5; `handlerMap.get('RuntimeGetDumpById')`; `resolvePrincipal`/`resolveSystemScope`; `makeDefaultDumpBuffer()`.
- Produces: `GetDumpSection` visible in `listToolsHandler` and dispatchable in `callToolHandler`, keyed by the request's principal/scope.

- [ ] **Step 1:** Extend the ALS store type to `{ connection, context, dumpScope?: { principalHash: string; resolvedDestination: string; effectiveClient: string } }`; thread `dumpScope` through `runWithRequestConnection`/`setRequestConnection` (optional param, defaulted `undefined`).
- [ ] **Step 2:** In `srv/agent-mcp.ts` `execute_step`, where `req` + the resolved `SapConfig` exist, compute `authMode` (`sapLogin ? 'basic' : sapConfig.authType`), `resolvedSapIdentity` (`sapLogin ?? resolved.sapConfig.username ?? null`), `jwtSub` (from the validated JWT if available, else `null`), then `resolvePrincipal(...)`. If `null`, **do not** attach a `dumpScope` (the tool will refuse). Else build `dumpScope` with `resolveSystemScope(req.headers['x-sap-client'], { destinationName, client })` and pass it into `runWithRequestConnection`.
- [ ] **Step 3:** In `buildEmbeddedMcpAdapter`: append the `GetDumpSection` def (from `CLOUD_LOCAL_TOOLS`) to what `listToolsHandler` returns; in `callToolHandler`, add a branch `if (name === 'GetDumpSection')` **before** the `handlerMap` lookup that reads `connectionALS.getStore()?.dumpScope` — **if absent, throw `SAP identity required to analyse a dump (no stable principal)`** — else calls `getDumpSectionResult(args, { key: { ...dumpScope, dumpId: args.dump_id }, buffer: <module singleton>, fetchFormatted: (id) => callToolHandler('RuntimeGetDumpById', { dump_id: id, view: 'formatted', response_mode: 'payload' }) → extract text })` and returns the JSON as tool text. Log with `principalHash` only.
- [ ] **Step 4: Test** — build the adapter against a stubbed `RuntimeGetDumpById` returning the fixture, set an ALS `dumpScope`, call `GetDumpSection` twice → one underlying fetch, correct index/section; and with no `dumpScope` → throws the fail-closed error. (If the adapter is awkward to construct in a unit, assert the branch via a thin extracted function and document a manual check in the report.)
- [ ] **Step 5: Commit** — `feat(agent-mcp): principal-scoped GetDumpSection via ALS dumpScope + embedded adapter`.

---

### Task 7: Tool-intent + regenerate the embedding bundle

**Files:** Modify `srv/tool-intents.json`, `srv/tool-embeddings.json` (regenerated). **Depends on Task 5** (corpus must include `GetDumpSection` or the generator will not embed it).

- [ ] **Step 1:** Add a `GetDumpSection` entry to `srv/tool-intents.json` (`{ text, enriched }` shape) with an `enriched` `Intent:` line foregrounding outcomes: `read short dump section, dump error analysis, dump call stack, dump source extract, get a chapter of a runtime dump, view part of an ST22 dump`. No poison tokens.
- [ ] **Step 2:** `npm run update:env` (cf-target acme-prod) → refresh `default-env.json`; `npx tsx tools/generate-tool-embeddings.ts` → regenerate `srv/tool-embeddings.json`. Confirm the entry count grew by one and `GetDumpSection` is present.
- [ ] **Step 3:** Offline-rank (v6.27.0 pattern) `"read the error analysis of the latest short dump"` → assert `GetDumpSection` (and `RuntimeListFeeds`) rank in the top-15.
- [ ] **Step 4: Commit** — `feat(tool-rag): GetDumpSection intent + regenerated embedding bundle`.

---

### Task 8: Update the `reading-short-dumps` skill to the index-first `GetDumpSection` flow (F3)

**Files:** Modify `srv/skills/reading-short-dumps/SKILL.md`; the allow-list test already includes the skill (no test change unless the description changes — keep the description unique).

- [ ] **Step 1:** Rewrite the skill body to the new flow: (1) list dumps from the runtime **feed** and normalise the id (last URL segment) — unchanged; (2) to read one, call **`GetDumpSection`** — with no `section` to get the **section index**, then with a specific chapter name to get that chapter; (3) do **not** fetch the whole `RuntimeGetDumpById` formatted view (it is huge); (4) for root-cause analysis, read `Error analysis` + `Chain of Exception Objects` + `Source Code Extract` + `Active Calls/Events`. Keep it self-contained facts, no tool-selection crutch.
- [ ] **Step 2:** Run `npx jest test/unit/skills-content.test.ts` — passes (unique description preserved).
- [ ] **Step 3: Commit** — `docs(skills): reading-short-dumps uses GetDumpSection index-first flow`.

---

### Task 9: Repo-wide log-hygiene sweep (raw SAP login)

**Files:** Modify `srv/lib/request-connection.ts`, `srv/mcp-proxy.ts`, `srv/mcp-manager.ts`.

- [ ] **Step 1:** `grep -rnE "x-sap-login|sapLogin|username:" srv` to **enumerate** structured-log sites. For each **whose value is the SAP login / a credential-adjacent identity**, replace the raw value with `'user-basic'` (or `principalHash` where available). Do NOT touch the XSUAA `userId:` diagnostic fields (`srv/auth.ts`, `srv/server.ts`).
- [ ] **Step 2: Test** — a focused unit per changed file (stub `cds.log`, assert the payload omits the raw login), or assert the log-payload builder.
- [ ] **Step 3: Commit** — `fix(log): mask raw SAP login in structured logs (repo-wide)`.

---

### Task 10: End-to-end check on the real ZDEMO01_C_BOOK dump

- [ ] **Step 1:** Deploy (or `cds watch` against a dev subaccount). Call `execute_step` on `:3001`: *"Analyse the latest short dump for user DEVELOPER — root cause."* Confirm the executor selects `RuntimeListFeeds` + `GetDumpSection`, reads the `Error analysis`/`Source Code Extract` chapters (small), and reports `CX_RAP_HANDLER_NOT_IMPLEMENTED` / `INSTANCE_AUTHORIZATION` / `ZDEMO01_C_BOOK` **without a 400**.
- [ ] **Step 2:** Call again → confirm no second underlying ADT fetch (buffer hit) in the logs.
- [ ] **Step 3:** Record the transcript in the task report. No commit (verification only).

---

## Notes on ordering & review

- Tasks 1–4 are pure units (TDD, no live SAP). Task 5 makes the tool corpus-visible (F1); Task 6 wires principal/scope + the adapter (F2); Task 7 embeds it; Task 8 teaches the executor the flow (F3); Task 9 is independent hardening; Task 10 is the live proof.
- **Task 5 before Task 7** — the generator reads `getSharedCorpusDocs()`, so the tool must be in the corpus before the bundle is regenerated.
- Task 7 mutates the committed corpus — run the live `execute_step` (Task 10) before calling it "done" (the `enriched`-required lesson).
- No `HandlerExporter` / mcp-abap-adt core change anywhere — that is Phase 2.
