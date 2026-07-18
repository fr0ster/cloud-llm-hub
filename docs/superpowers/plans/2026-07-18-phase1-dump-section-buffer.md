# Phase 1 — Mechanical GetDumpSection + Principal-Scoped Dump Buffer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the executor read/analyse a large ST22 dump through one mechanical, RAG-selected `GetDumpSection` tool that returns a small **section index** or a single **de-padded chapter** from a principal-scoped in-memory buffer — so a 185K-token dump never enters the LLM context whole.

**Architecture:** cloud-llm-hub only, no core change. The tool wraps the existing `RuntimeGetDumpById` (fetched once via the in-process embedded MCP client), parses it with the lifted `parseDump`/`MAJOR_TITLES`, de-pads, and serves chapters from a `DumpBufferStore` (default in-memory LRU) keyed by `{ principalHash, resolvedDestination, effectiveClient, dump_id }`. "Analyse vs read" is the executor's reasoning (guided by the shipped `reading-short-dumps` skill); the tool is purely mechanical.

**Tech Stack:** TypeScript (CommonJS), `@sap/cds`, `@modelcontextprotocol/sdk`, Jest, Biome.

## Global Constraints

- **Cache only immutable artifacts.** A dump by id never changes → no validation. No aggregates, no single-object caching in Phase 1.
- **Buffer behind an injected interface (DI).** `DumpBufferStore` is an interface; the default impl is in-memory, **LRU + total-bytes bounded** (must not reintroduce the OOM v6.24.5/6.25.0 fought), **absolute TTL** (no stable session on the stateless planner surface), **does not survive restart**. A persistent/cross-instance adapter can be injected later without touching the tool.
- **Buffer key = `{ principalHash, resolvedDestination, effectiveClient, dump_id }`.** `resolvedDestination`/`effectiveClient` are the **resolved** values: `effectiveClient = x-sap-client override if present, else the destination's resolved sap-client` (the override is applied AFTER `resolveDestinationSapConfig` in `srv/agent-mcp.ts` / `srv/lib/request-connection.ts`).
- **`principalHash` = `hash(canonicalTuple([cds.context.user.id, authMode, resolvedSapIdentity ?? null, jwtSub ?? null]))`** — WHO only (destination/client are separate key parts). Canonical tuple encoding (JSON array or NUL-delimited with escaping), **not** raw concatenation. Each component is deterministic (value-or-`null`, same on every code path). `resolvedSapIdentity` is `x-sap-login` (basic), the destination `User` (service user), or **absent** (principal propagation — do not backend-round-trip).
- **Fail closed.** If `cds.context.user.id` is missing or `'anonymous'`, `GetDumpSection` **refuses** — no shared-principal buffer, no anonymous fresh fetch.
- **Raw SAP login never in a key, file, or log.** The buffer key carries only `principalHash`. The XSUAA `cds.context.user.id` is a normal diagnostic id and stays in logs.
- **Mechanical tool, RAG-selected.** `GetDumpSection` carries no analysis intent. Reached via a new `tool-intents.json` entry + regenerated embedding bundle (uniform with every concrete tool), not always-injected. **No `HandlerExporter` / core change.**
- **Reuse `parseDump`/`MAJOR_TITLES`** (lift into `srv/lib/`), do not reinvent. Canonical chapter titles only.
- English everywhere; single quotes, 2-space indent, 100-col; Biome clean; `tsc` clean; Conventional Commits; a test per unit.

---

## File Structure

- Create `srv/lib/dump-parser.ts` — lifted `parseDump` + `MAJOR_TITLES` + de-pad + **section-index / single-section** helpers. Self-contained (inline the ~5 needed types).
- Create `srv/lib/principal.ts` — `principalHash(...)`, `resolveSystemScope(req, resolvedSapConfig)` → `{ resolvedDestination, effectiveClient }`, `resolvePrincipal(req)` → `{ principalHash } | null` (null ⇒ fail closed).
- Create `srv/lib/dump-buffer.ts` — `DumpBufferStore` interface + `InMemoryLruDumpBuffer` (bounded, TTL) + a module singleton factory reading `LLM_AGENT_DUMP_BUFFER_*` env.
- Create `srv/lib/get-dump-section.ts` — `getDumpSection(args, deps)` pure-ish handler (fetch-via-callback, parse, buffer, return index|section).
- Modify `srv/agent-manager.ts` — register `GetDumpSection` in `buildEmbeddedMcpAdapter`'s `listToolsHandler` + `callToolHandler`.
- Modify `srv/tool-intents.json` (+ regenerate `srv/tool-embeddings.json`) — add the `GetDumpSection` intent.
- Modify `srv/lib/request-connection.ts`, `srv/mcp-proxy.ts`, `srv/mcp-manager.ts` — mask the raw SAP login in structured logs.
- Tests: `test/unit/dump-parser.test.ts`, `principal.test.ts`, `dump-buffer.test.ts`, `get-dump-section.test.ts`, and a fixture `test/unit/fixtures/zdemo01-dump.formatted.txt`.

---

### Task 1: Lift the dump parser into `srv/lib/` + add de-pad and section API

**Files:**
- Create: `srv/lib/dump-parser.ts`
- Test: `test/unit/dump-parser.test.ts`
- Fixture: `test/unit/fixtures/zdemo01-dump.formatted.txt` (the real ZDEMO01_C_BOOK formatted payload, saved from `/tmp/developer-latest-dump.md` — strip the markdown wrapper, keep the raw pipe text)

**Interfaces produced (consumed by Tasks 4/8):**
- `parseDump(system: string, dumpId: string, payload: string): ParsedDump` — lifted verbatim from `docs/examples/abap-dump-monitor/srv/dump-parser.ts` (types inlined).
- `MAJOR_TITLES: ReadonlySet<string>` — lifted verbatim (the 21 canonical titles).
- `dumpSectionIndex(payload: string): string[]` — the canonical titles **present** in this payload, in document order.
- `getDumpSection(payload: string, title: string): string | null` — one chapter's text, **de-padded**, or `null` if absent.
- `dePad(text: string): string` — strip trailing per-line whitespace and collapse box padding, preserving column alignment inside `Source Code Extract` (do not touch lines whose section is source/hex).

- [ ] **Step 1: Save the fixture.** Copy the raw formatted payload (pipe text, no markdown fence) to `test/unit/fixtures/zdemo01-dump.formatted.txt`. It must contain `Runtime Errors  RAISE_SHORTDUMP`, `Except.  CX_SADL_DUMP_APPL_MODEL_ERROR`, an `Error analysis` chapter mentioning `CX_RAP_HANDLER_NOT_IMPLEMENTED` and `ZDEMO01_C_BOOK`, and a `Source Code Extract` chapter.

- [ ] **Step 2: Write the failing test.**
```ts
import fs from 'node:fs';
import path from 'node:path';
import { parseDump, MAJOR_TITLES, dumpSectionIndex, getDumpSection, dePad } from '../../srv/lib/dump-parser';

const payload = fs.readFileSync(path.join(__dirname, 'fixtures/zdemo01-dump.formatted.txt'), 'utf8');

describe('dump-parser (lifted)', () => {
  it('parses the header of a real dump', () => {
    const d = parseDump('DEV', '20260717100828…DEVELOPER…18', payload);
    expect(d.header.runtimeError).toBe('RAISE_SHORTDUMP');
    expect(d.header.exceptionClass).toBe('CX_SADL_DUMP_APPL_MODEL_ERROR');
  });

  it('MAJOR_TITLES carries the canonical titles', () => {
    expect(MAJOR_TITLES.has('Error analysis')).toBe(true);
    expect(MAJOR_TITLES.has('Active Calls/Events')).toBe(true);
  });

  it('dumpSectionIndex lists chapters present, in order, all canonical', () => {
    const idx = dumpSectionIndex(payload);
    expect(idx).toContain('Error analysis');
    expect(idx).toContain('Source Code Extract');
    for (const t of idx) expect(MAJOR_TITLES.has(t)).toBe(true);
  });

  it('getDumpSection returns one de-padded chapter, or null', () => {
    const ea = getDumpSection(payload, 'Error analysis');
    expect(ea).toContain('CX_RAP_HANDLER_NOT_IMPLEMENTED');
    expect(ea).toContain('ZDEMO01_C_BOOK');
    // de-padded: no run of >3 trailing spaces on any line
    for (const line of ea!.split('\n')) expect(line).not.toMatch(/\s{4,}$/);
    expect(getDumpSection(payload, 'No Such Chapter')).toBeNull();
  });

  it('a single de-padded chapter is far smaller than the whole payload', () => {
    expect(getDumpSection(payload, 'Error analysis')!.length).toBeLessThan(payload.length / 4);
  });
});
```

- [ ] **Step 3: Run it, confirm it fails** (`npx jest test/unit/dump-parser.test.ts` → "Cannot find module '../../srv/lib/dump-parser'").

- [ ] **Step 4: Implement `srv/lib/dump-parser.ts`.** Copy `docs/examples/abap-dump-monitor/srv/dump-parser.ts` verbatim; inline the `DumpHeader`, `CallFrame`, `VariableSnapshot`, `SourceExtract`, `ParsedDump` types from that project's `interfaces.ts` at the top (type-only, no runtime deps). Then add:
```ts
export function dumpSectionIndex(payload: string): string[] {
  const found: string[] = [];
  for (const raw of payload.split(/\r?\n/)) {
    if (!raw.startsWith('|')) continue;
    const c = pipeContent(raw).trim();
    if (MAJOR_TITLES.has(c) && !found.includes(c)) found.push(c);
  }
  return found;
}

export function dePad(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, '').replace(/\s{2,}\|/g, ' |').replace(/\|\s{2,}/g, '| '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function getDumpSection(payload: string, title: string): string | null {
  if (!MAJOR_TITLES.has(title)) return null;
  const raw = extractSection(payload, title); // already in the lifted file
  return raw ? dePad(raw) : null;
}
```
Export `MAJOR_TITLES` (add `export` to its declaration).

- [ ] **Step 5: Run tests to green** (`npx jest test/unit/dump-parser.test.ts`).

- [ ] **Step 6: Commit** — `feat(dump): lift parseDump/MAJOR_TITLES into srv/lib + section index/de-pad`.

---

### Task 2: Principal + system-scope resolution (`srv/lib/principal.ts`)

**Files:**
- Create: `srv/lib/principal.ts`
- Test: `test/unit/principal.test.ts`

**Interfaces:**
- Consumes: `cds.context.user.id`, request headers (`x-sap-client`, auth), a resolved `SapConfig`.
- Produces:
  - `principalHash(input: { cdsUserId: string; authMode: string; resolvedSapIdentity?: string | null; jwtSub?: string | null }): string`
  - `resolveSystemScope(rawClient: string | undefined, resolved: { destinationName: string; client?: string }): { resolvedDestination: string; effectiveClient: string }`
  - `resolvePrincipal(ctx: { cdsUserId: string | undefined; authMode: string; resolvedSapIdentity?: string | null; jwtSub?: string | null }): { principalHash: string } | null` — returns `null` when `cdsUserId` is falsy or `'anonymous'` (fail closed).

- [ ] **Step 1: Write the failing test.**
```ts
import { principalHash, resolveSystemScope, resolvePrincipal } from '../../srv/lib/principal';

describe('principal', () => {
  it('hashes a canonical tuple, not concatenation (no boundary collisions)', () => {
    const a = principalHash({ cdsUserId: 'ab', authMode: 'basic', resolvedSapIdentity: 'c' });
    const b = principalHash({ cdsUserId: 'a', authMode: 'basic', resolvedSapIdentity: 'bc' });
    expect(a).not.toBe(b);
  });
  it('is deterministic: absent identity is null, same every call', () => {
    const a = principalHash({ cdsUserId: 'u', authMode: 'propagation' });
    const b = principalHash({ cdsUserId: 'u', authMode: 'propagation', resolvedSapIdentity: null, jwtSub: null });
    expect(a).toBe(b);
  });
  it('never contains the raw SAP login', () => {
    const h = principalHash({ cdsUserId: 'u', authMode: 'basic', resolvedSapIdentity: 'SECRETLOGIN' });
    expect(h).not.toContain('SECRETLOGIN');
  });
  it('resolveSystemScope: header override wins, else resolved default; both collapse', () => {
    expect(resolveSystemScope('600', { destinationName: 'S4HANA_DEV', client: '100' }))
      .toEqual({ resolvedDestination: 'S4HANA_DEV', effectiveClient: '600' });
    expect(resolveSystemScope(undefined, { destinationName: 'S4HANA_DEV', client: '100' }))
      .toEqual({ resolvedDestination: 'S4HANA_DEV', effectiveClient: '100' });
  });
  it('resolvePrincipal fails closed on missing/anonymous', () => {
    expect(resolvePrincipal({ cdsUserId: undefined, authMode: 'basic' })).toBeNull();
    expect(resolvePrincipal({ cdsUserId: 'anonymous', authMode: 'basic' })).toBeNull();
    expect(resolvePrincipal({ cdsUserId: 'alice', authMode: 'basic' })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement.**
```ts
import { createHash } from 'node:crypto';

export function principalHash(input: {
  cdsUserId: string;
  authMode: string;
  resolvedSapIdentity?: string | null;
  jwtSub?: string | null;
}): string {
  const tuple = [
    input.cdsUserId,
    input.authMode,
    input.resolvedSapIdentity ?? null,
    input.jwtSub ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

export function resolveSystemScope(
  rawClient: string | undefined,
  resolved: { destinationName: string; client?: string },
): { resolvedDestination: string; effectiveClient: string } {
  return {
    resolvedDestination: resolved.destinationName,
    effectiveClient: (rawClient?.trim() || resolved.client || '').trim(),
  };
}

export function resolvePrincipal(ctx: {
  cdsUserId: string | undefined;
  authMode: string;
  resolvedSapIdentity?: string | null;
  jwtSub?: string | null;
}): { principalHash: string } | null {
  if (!ctx.cdsUserId || ctx.cdsUserId === 'anonymous') return null;
  return { principalHash: principalHash({ ...ctx, cdsUserId: ctx.cdsUserId }) };
}
```

- [ ] **Step 4: Run tests to green. Step 5: Commit** — `feat(principal): principalHash canonical tuple + system scope + fail-closed`.

---

### Task 3: `DumpBufferStore` interface + in-memory LRU adapter (`srv/lib/dump-buffer.ts`)

**Files:**
- Create: `srv/lib/dump-buffer.ts`
- Test: `test/unit/dump-buffer.test.ts`

**Interfaces:**
- `interface DumpBufferKey { principalHash: string; resolvedDestination: string; effectiveClient: string; dumpId: string }`
- `interface DumpBufferStore { get(key: DumpBufferKey): { index: string[]; raw: string } | undefined; set(key: DumpBufferKey, value: { index: string[]; raw: string }): void }`
- `class InMemoryLruDumpBuffer implements DumpBufferStore` — ctor `{ maxEntries: number; maxBytes: number; ttlMs: number; now?: () => number }`; LRU + total-bytes eviction + absolute TTL.
- `function makeDefaultDumpBuffer(env = process.env): DumpBufferStore` — reads `LLM_AGENT_DUMP_BUFFER_MAX_ENTRIES` (default 32), `_MAX_BYTES` (default 64_000_000), `_TTL_MS` (default 600_000).

- [ ] **Step 1: Write the failing test** — cover: set/get round-trip; key isolation (different `principalHash` never collides); LRU eviction past `maxEntries`; total-bytes eviction; TTL expiry via injected `now`. (Use an injected `now` and small caps.)
```ts
import { InMemoryLruDumpBuffer } from '../../srv/lib/dump-buffer';
const K = (p: string, d = 'principal') => ({ principalHash: p, resolvedDestination: 'D', effectiveClient: '100', dumpId: d });
it('isolates by principalHash', () => {
  const b = new InMemoryLruDumpBuffer({ maxEntries: 10, maxBytes: 1e6, ttlMs: 1e6 });
  b.set(K('A'), { index: ['x'], raw: 'aa' });
  expect(b.get(K('B'))).toBeUndefined();
  expect(b.get(K('A'))?.raw).toBe('aa');
});
it('evicts LRU past maxEntries and expires by TTL', () => {
  let t = 0; const b = new InMemoryLruDumpBuffer({ maxEntries: 1, maxBytes: 1e6, ttlMs: 100, now: () => t });
  b.set(K('A', 'd1'), { index: [], raw: 'a' });
  b.set(K('A', 'd2'), { index: [], raw: 'b' }); // evicts d1 (LRU)
  expect(b.get(K('A', 'd1'))).toBeUndefined();
  t = 101; expect(b.get(K('A', 'd2'))).toBeUndefined(); // TTL
});
```

- [ ] **Step 2: Run, confirm fail. Step 3: Implement** — a `Map<string, {value, bytes, expiresAt}>` keyed by `JSON.stringify([principalHash, resolvedDestination, effectiveClient, dumpId])`; on `set` push to MRU, evict oldest while `size > maxEntries` or `totalBytes > maxBytes`; on `get` drop-if-expired, else refresh recency. `bytes = raw.length`.

- [ ] **Step 4: Green. Step 5: Commit** — `feat(dump-buffer): DumpBufferStore iface + bounded in-memory LRU adapter`.

---

### Task 4: `GetDumpSection` handler logic (`srv/lib/get-dump-section.ts`)

**Files:**
- Create: `srv/lib/get-dump-section.ts`
- Test: `test/unit/get-dump-section.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseDump`/`dumpSectionIndex`/`getDumpSection`), Task 3 buffer, a `fetchFormatted(dumpId): Promise<string>` callback (Task 5 supplies the real one that calls `RuntimeGetDumpById`), and a resolved `DumpBufferKey` (Task 2 supplies it).
- Produces: `getDumpSectionResult(args: { dumpId: string; section?: string }, deps: { key: DumpBufferKey; buffer: DumpBufferStore; fetchFormatted: (dumpId: string) => Promise<string> }): Promise<{ dumpId: string; index?: string[]; section?: string; text?: string }>`.
  - `section` omitted → `{ dumpId, index }` (the section index only — small).
  - `section` given → `{ dumpId, section, text }` (one de-padded chapter) or throws `section not found` (list valid ones).
  - Fetches via `fetchFormatted` **only on a buffer miss**, then `buffer.set`.

- [ ] **Step 1: Write the failing test** — inject a fake buffer + a `fetchFormatted` spy over the Task-1 fixture; assert: first call fetches once and caches; second call does NOT re-fetch; `section` omitted returns the index; a valid `section` returns its de-padded text; an invalid section throws with the valid list.

- [ ] **Step 2: Run, confirm fail. Step 3: Implement** — on miss: `raw = await fetchFormatted(dumpId)`; `index = dumpSectionIndex(raw)`; `buffer.set(key, { index, raw })`. Then serve from `{ index, raw }`: no `section` → `{ dumpId, index }`; with `section` → `getDumpSection(raw, section)` (throw if null, message lists `index`).

- [ ] **Step 4: Green. Step 5: Commit** — `feat(dump): GetDumpSection handler (buffer-once, serve index/section)`.

---

### Task 5: Register `GetDumpSection` in the embedded MCP adapter

**Files:**
- Modify: `srv/agent-manager.ts` (`buildEmbeddedMcpAdapter`, ~line 1559)

**Interfaces:**
- Consumes: Tasks 1–4; the existing `handlerMap` (to call `RuntimeGetDumpById`), `connectionALS` (per-request scope for the principal/system inputs), `cds.context`.
- Produces: the tool visible in `listToolsHandler` and dispatchable in `callToolHandler`.

- [ ] **Step 1:** In `buildEmbeddedMcpAdapter`, define the tool descriptor (name `GetDumpSection`, inputSchema `{ dump_id: string (required), section?: string }`, a one-line mechanical description) and **append it to** the array `listToolsHandler` returns.

- [ ] **Step 2:** In `callToolHandler`, add a branch `if (name === 'GetDumpSection')` **before** the `handlerMap` lookup that:
  - reads the request scope (`connectionALS.getStore()`), resolves `principalHash` via `resolvePrincipal({ cdsUserId: cds.context?.user?.id, authMode, resolvedSapIdentity, jwtSub })` — **if `null`, throw `SAP identity required to analyse a dump (no stable principal)`** (fail closed);
  - builds the `DumpBufferKey` from `principalHash` + `resolveSystemScope(...)` + `args.dump_id`;
  - calls `getDumpSectionResult(args, { key, buffer: <module singleton makeDefaultDumpBuffer()>, fetchFormatted: (id) => handlerMap.get('RuntimeGetDumpById')!(…{ dump_id: id, view: 'formatted', response_mode: 'payload' }) })` and returns its result as the tool's `content` text (JSON-stringified).
  - Log with `principalHash` (never the SAP login).

- [ ] **Step 3: Test** — an integration-style unit that builds the adapter against a stubbed `RuntimeGetDumpById` handler returning the fixture, then calls `GetDumpSection` twice and asserts one underlying fetch + correct index/section. (If wiring is hard to unit-test, cover the branch logic in Task 4 and keep this step a thin manual check documented in the task report.)

- [ ] **Step 4: Commit** — `feat(agent-mcp): register mechanical GetDumpSection in the executor embedded adapter`.

---

### Task 6: Tool-intent + regenerate the embedding bundle

**Files:**
- Modify: `srv/tool-intents.json`, `srv/tool-embeddings.json` (regenerated)

- [ ] **Step 1:** Add a `GetDumpSection` entry to `srv/tool-intents.json` mirroring the existing `{ text, enriched }` shape, with an `enriched` `Intent:` line that foregrounds the outcome words: `read short dump section, dump error analysis, dump call stack, dump source extract, get a chapter of a runtime dump, view part of an ST22 dump`. No `$TMP`/`ZDEMO*`-style poison tokens (per v6.27.0).

- [ ] **Step 2:** `npm run update:env` (cf-target acme-prod, which binds AI Core) → refresh `default-env.json`; then `npx tsx tools/generate-tool-embeddings.ts` to regenerate `srv/tool-embeddings.json`.

- [ ] **Step 3:** Verify with the offline ranker pattern from v6.27.0: embed `"read the error analysis of the latest short dump"` and confirm `GetDumpSection` (and `RuntimeListFeeds`) rank in the top-15.

- [ ] **Step 4: Commit** — `feat(tool-rag): GetDumpSection intent + regenerated embedding bundle`.

---

### Task 7: Repo-wide log-hygiene sweep (raw SAP login)

**Files:**
- Modify: `srv/lib/request-connection.ts` (`username: sapLogin`), `srv/mcp-proxy.ts` (`username: headers['x-sap-login']`), `srv/mcp-manager.ts` (`username: sapLogin`)

- [ ] **Step 1:** `grep -rnE "x-sap-login|sapLogin|username:" srv` to **enumerate** structured-log sites. For each **whose value is the SAP login / a credential-adjacent identity**, replace the raw value with `'user-basic'` (or the `principalHash` where available). Do NOT touch the XSUAA `userId:` diagnostic fields (auth.ts/server.ts) — those are allowed.

- [ ] **Step 2: Test** — a unit that stubs `cds.log` and drives each masked path (or asserts the log payload builder omits the raw login). At minimum, a focused assertion per changed file.

- [ ] **Step 3: Commit** — `fix(log): mask raw SAP login in structured logs (repo-wide)`.

---

### Task 8: End-to-end check on the real ZDEMO01_C_BOOK dump

- [ ] **Step 1:** With acme deployed (or `cds watch` against a dev subaccount), call `execute_step` on `:3001`: *"Analyse the latest short dump for user DEVELOPER — root cause."* Confirm the executor selects `RuntimeListFeeds` + `GetDumpSection`, gets the `Error analysis`/`Source Code Extract` chapters (small), and reports the root cause (`CX_RAP_HANDLER_NOT_IMPLEMENTED`, `INSTANCE_AUTHORIZATION`, `ZDEMO01_C_BOOK`) **without a 400**.
- [ ] **Step 2:** Call again → confirm no second underlying ADT fetch (buffer hit) in the logs.
- [ ] **Step 3:** Record the transcript in the task report. No commit (verification only).

---

## Notes on ordering & review

- Tasks 1–4 are pure units (TDD, no live SAP). Task 5 wires them; Task 6 makes the tool selectable; Task 7 is independent hardening; Task 8 is the live proof.
- Task 6 mutates the committed corpus — run a real `execute_step` (Task 8) before calling the tool "done" (the `enriched`-required lesson).
- No core / `HandlerExporter` change anywhere — that is Phase 2.
