# Recurring-Dump Deduplication — Implementation Plan

> Plan for spec `2026-05-04-jira-dedup-design.md`. Issue [#48](https://github.com/fr0ster/cloud-llm-hub/issues/48). PR [#49](https://github.com/fr0ster/cloud-llm-hub/pull/49).

**Goal:** dedupe recurring ABAP dumps so a signature group produces one Jira ticket + comments / `unheard` rows, not N tickets. Race-proof within a cycle and lifecycle-correct across closed→reopen cycles.

**Architecture:** stable `signatureLabel = 'dump-sig-' + sha1(signature)[0..16]` as the canonical Jira dedup key; explicit DB-level group marking by inheriting `jiraIssueKey` at INSERT, anchored to the latest `jiraStatus='created'` row in the group; lifecycle recheck via cached `getIssue` to detect manual closure; new terminal status `'unheard'` for recurrences whose comment slot is already taken or used.

**Tech stack:** existing — TypeScript / @sap/cds / SQLite (gen) / @sap-cloud-sdk / native fetch for Jira REST.

**Status legend:** `[x]` = done in code already; `[ ]` = pending; `[~]` = done but needs revision per current spec.

---

### Task 1: signatureLabel helper in jira-policy.ts

**Files:**
- Modify: `docs/examples/abap-dump-monitor/srv/jira-policy.ts`
- Test:   `docs/examples/abap-dump-monitor/test/unit/jira-policy.test.ts`

- [x] Add `signatureLabel(signature: string): string` returning `'dump-sig-' + sha1(signature)[0..16]`.
- [x] Use `node:crypto` `createHash('sha1')`.
- [ ] Test: deterministic output for same input; different signatures → different labels; format `^dump-sig-[0-9a-f]{16}$`. *(missing — add)*

### Task 2: JiraWorker.processOne — three-branch dedup

**Files:**
- Modify: `docs/examples/abap-dump-monitor/srv/jira-worker.ts`
- Test:   `docs/examples/abap-dump-monitor/test/unit/jira-worker.test.ts`

- [x] Replace per-dump-label-only flow with sigLabel-based dedup.
- [x] Resolution: prefer `row.jiraIssueKey` (group inheritance via `getIssue`), fall back to `searchByLabel(sigLabel)` for manually-created tickets.
- [x] Branches:
  - existing AND open → `comment` → `jiraStatus='commented'`
  - existing AND closed → `create` with `Recurrence after closed ticket <key>` in description → `jiraStatus='created'`
  - not found → `create` → `jiraStatus='created'`
- [x] Both `sigLabel` and `dumpLabel` attached to every created ticket.
- [x] Tests: 4 branches (no-existing, open, closed, group-inherited).

### Task 3: Discoverer / repo.insertParsed — canonical-key INSERT algorithm

**Files:**
- Modify: `docs/examples/abap-dump-monitor/srv/monitor-service.ts` (`CdsDumpRepository.insertParsed`)
- Create/Modify: `docs/examples/abap-dump-monitor/srv/dump-repository.ts` *(side-effect-free home for `CdsDumpRepository` / insert helpers, imported by `monitor-service.ts` and integration tests)*

The current implementation diverges from spec — it selects canonical purely by `firstSeenAt DESC` and decides `'unheard'` only on `prior.jiraStatus === 'commented'`. Spec requires canonical anchored to `jiraStatus='created'` and a full slot rule including `'failed'`. Rewrite required.

- [ ] Replace canonical query with:
  ```
  canonical = SELECT one row in group WHERE jiraStatus = 'created'
                                       AND jiraIssueKey IS NOT NULL
                                       ORDER BY firstSeenAt DESC LIMIT 1
  ```
- [ ] Branch on `canonical is None`:
  - `canonical is None` → `new.jiraStatus = 'pending'`, `new.jiraIssueKey = NULL`. (First-cycle race accepted as out-of-scope per spec.)
  - else → `new.jiraIssueKey = canonical.jiraIssueKey` (inherit), then run lifecycle recheck (Task 4) and the slot rule below.
- [ ] **Open branch** (after recheck returns open): slot rule
  ```
  slot_taken = EXISTS row in group
                 WHERE jiraIssueKey = canonical.jiraIssueKey
                 AND   jiraStatus IN ('pending','failed','commented','unheard')
  ```
  - `slot_taken=true` → `new.jiraStatus = 'unheard'`
  - else → `new.jiraStatus = 'pending'`
- [ ] **Closed branch** (after recheck returns done): slot rule
  ```
  reopen_slot_taken = EXISTS row in group
                        WHERE jiraIssueKey = canonical.jiraIssueKey
                        AND   jiraStatus IN ('pending','failed')
  ```
  - `reopen_slot_taken=true` → `new.jiraStatus = 'unheard'`
  - else → `new.jiraStatus = 'pending'` (claim next-cycle creator slot; worker creates ticket B with back-reference)
- [x] `findPendingJira` projection includes `jiraIssueKey` (already in code).

### Task 4: Per-tick `getIssue` cache for lifecycle recheck

**Files:**
- Modify: `docs/examples/abap-dump-monitor/srv/discoverer.ts` (interface + tick wiring)
- Modify: `docs/examples/abap-dump-monitor/srv/dump-repository.ts` (`CdsDumpRepository.insertParsed` signature + body)
- Modify: `docs/examples/abap-dump-monitor/srv/monitor-service.ts` (wire repository + lifecycle probe factory)
- Modify: `docs/examples/abap-dump-monitor/test/unit/discoverer.test.ts` (mock repos must accept the new param)

The lifecycle recheck issues `jira.getIssue(canonical.jiraIssueKey)` per INSERT. Per spec, implementation MUST cache results per-tick and discard between ticks; long-lived TTL is disallowed. The `CdsDumpRepository` has no Jira dependency today, so the contract between `Discoverer` and the repo must change explicitly.

- [ ] Define a probe interface in `discoverer.ts`:
  ```ts
  export interface LifecycleProbe {
    getIssueCached(key: string): Promise<{ key: string; statusCategoryKey: string }>;
  }
  export function createLifecycleProbe(jira: IJiraClient): LifecycleProbe;
  ```
  Implementation backs `getIssueCached` with a `Map<string, IssueRef>` populated lazily on first call per key. Errors propagate; nothing is cached on failure.
- [ ] Extend `DumpRepository.insertParsed` signature in `discoverer.ts`:
  ```ts
  insertParsed(item: DumpListItem, parsed: ParsedDump, signature: string,
               lifecycle: LifecycleProbe): Promise<string>;
  ```
- [ ] `Discoverer.tickOnce`:
  - Add `lifecycleProbeFactory: () => LifecycleProbe` to `DiscovererDeps` (do not couple `Discoverer` directly to `IJiraClient`).
  - Wire it from `monitor-service.ts` as `lifecycleProbeFactory: () => createLifecycleProbe(jira)`, where `JiraClient` is already constructed.
  - Instantiate a fresh `LifecycleProbe` at the top of the method.
  - Pass it to every `repo.insertParsed(...)` call within the tick.
  - Drop the reference at the end of the tick (out-of-scope after the function returns; GC'd).
- [ ] `CdsDumpRepository.insertParsed`:
  - Accept the new `lifecycle` argument.
  - When `canonical` exists, call `await lifecycle.getIssueCached(canonical.jiraIssueKey)` exactly once per row (the cache may answer it without a Jira round-trip).
  - On read error, throw — `Discoverer.tickOnce`'s per-row `try/catch` already converts that to `log + skip-this-dump`.
- [ ] Update every `Discoverer` construction and mock `DumpRepository` in unit tests (`discoverer.test.ts`, anything else that constructs one) to pass a fake probe factory and to accept/ignore the new `insertParsed` parameter.
- [ ] Tests: 2 INSERTs in same group within one tick → 1 `jira.getIssue` invocation; 2 INSERTs across two simulated ticks → 2 invocations.

### Task 5: pushToJira action — SELECT must include jiraIssueKey + signature

**Files:**
- Modify: `docs/examples/abap-dump-monitor/srv/monitor-service.ts` (action handler around line 350)

Round-2 review P1: action handler currently SELECTs the row without `jiraIssueKey`, so `worker.processOne` always falls back to `searchByLabel`. Manual mode silently misses inherited tickets.

- [ ] Extend the action's SELECT to include columns: `jiraIssueKey`, `signature`, plus everything `JiraPendingRow` requires.
- [ ] Pass the row to `worker.processOne` unchanged so the inheritance path is taken.
- [ ] Test: manual `pushToJira` on an inherited `'pending'` row uses `getIssue`, NOT `searchByLabel`.

### Task 6: UI gating — `@Common.OperationAvailable`

**Files:**
- Modify: `docs/examples/abap-dump-monitor/app/monitor/fiori-service.cds`

Round-2 review P3: `Jira` button on terminal rows reaches the worker, which bails on non-pending/failed status, returning `502 Jira step failed: unknown error`.

- [ ] Annotate `pushToJira`:
  ```cds
  pushToJira @Common.OperationAvailable: { $edmJson: { $Or: [
    { $Eq: [{ $Path: 'in/jiraStatus' }, 'pending'] },
    { $Eq: [{ $Path: 'in/jiraStatus' }, 'failed' ] }
  ]}};
  ```
- [ ] Annotate `retryAnalysis` similarly:
  ```cds
  retryAnalysis @Common.OperationAvailable: { $edmJson: { $Or: [
    { $Eq: [{ $Path: 'in/analysisStatus' }, 'failed' ] },
    { $Eq: [{ $Path: 'in/analysisStatus' }, 'analyzing'] }
  ]}};
  ```
- [ ] **Validate generated metadata** (cds compile passing is necessary but not sufficient — the annotation must actually reach the OData EDMX in the form Fiori evaluates):
  ```bash
  npx cds compile srv/monitor-service.cds app/monitor/fiori-service.cds --to edmx \
    | tee /tmp/edmx.xml \
    | grep -c 'Term="Common.OperationAvailable"'   # expect ≥ 2 (pushToJira + retryAnalysis)
  grep -A4 'pushToJira'    /tmp/edmx.xml | grep -q 'OperationAvailable'  || echo MISSING
  grep -A4 'retryAnalysis' /tmp/edmx.xml | grep -q 'OperationAvailable'  || echo MISSING
  ```
- [ ] Verify in browser on staging: button is `disabled` on terminal-status rows (rendering may be greyed-out OR hidden — both acceptable per spec).

### Task 7: Service projection — virtual recurrence fields

**Files:**
- Modify: `docs/examples/abap-dump-monitor/srv/monitor-service.cds`
- Modify: `docs/examples/abap-dump-monitor/srv/monitor-service.ts` (after-READ)

- [x] Add to `MonitoredDump` projection: `null as recurrenceCount : Integer`, `null as firstOccurrenceID : UUID`.
- [x] Populate in after-READ — `count(*)` and `min(firstSeenAt) → ID` per group.

### Task 8: Tests

To avoid the trap of "fake test confirming a copy of the algorithm", the slot-decision is split into a **pure decision function** in `jira-policy.ts` (covered exhaustively by unit tests) plus a thin **integration check** that the production CDS queries (canonical SELECT, slot EXISTS) actually return what the pure function expects. This way the algorithm AND the SQL contracts are both exercised.

**Files:**
- Modify: `docs/examples/abap-dump-monitor/srv/jira-policy.ts` (add `decideJiraInsertStatus` pure function)
- Modify: `docs/examples/abap-dump-monitor/srv/dump-repository.ts` (`CdsDumpRepository.insertParsed` calls the pure function with rows fetched via real SELECTs)
- Modify: `docs/examples/abap-dump-monitor/test/unit/jira-policy.test.ts` (cover all decision branches)
- Modify: `docs/examples/abap-dump-monitor/test/unit/jira-worker.test.ts` (existing branches)

> **8c (`insert-integration.test.ts`) is deferred to issue [#50](https://github.com/fr0ster/cloud-llm-hub/issues/50)** — see that section below for the full rationale and the deferred checklist.

#### 8a. Pure decision function

- [ ] Extract:
  ```ts
  export interface InsertDecisionInput {
    canonical: { jiraIssueKey: string; statusCategoryKey: 'open'|'done' } | null;
    slotRowsForCanonicalKey: Array<{ jiraStatus: string }>; // ALL pre-fetched rows in same (signature, canonical.jiraIssueKey), not pre-filtered slot rows
  }
  export interface InsertDecisionOutput {
    jiraStatus: 'pending' | 'unheard';
    jiraIssueKey: string | null;
  }
  export function decideJiraInsertStatus(input: InsertDecisionInput): InsertDecisionOutput;
  ```
  Implements the spec's pseudo-code without touching the DB or Jira.
- [ ] Tests: cartesian over `canonical = null | open | done` × `slotRows ∈ {[], ['pending'], ['failed'], ['commented'], ['unheard'], ['pending','commented','unheard'], ['failed','unheard']}`.
- [ ] `CdsDumpRepository.insertParsed` calls `decideJiraInsertStatus` with all rows fetched via real SELECT for the same `(signature, canonical.jiraIssueKey)` — same code path tests use. The pure function, not SQL pre-filtering, owns the open-vs-done slot status sets.

#### 8b. Worker branches

- [x] Drop obsolete `findRecentByJira`-based test (path no longer used).
- [x] Worker branches: no-existing, open, closed, group-inherited.
- [ ] Worker branch: row with `jiraStatus='failed'+inheritedKey` retried → uses `getIssue(row.jiraIssueKey)` (not `searchByLabel`); on success transitions to `commented` or `created` per ticket lifecycle.

#### 8c. Integration tests against in-memory CAP DB — DEFERRED to #50

**Out of scope for PR #49.** Tracked in issue [#50](https://github.com/fr0ster/cloud-llm-hub/issues/50). Two boot paths were attempted during PR #49 review and both stalled under Jest:

- `cds.test()` from `@cap-js/cds-test` — crashes because `monitor-service.ts` registers `cds.on('bootstrap', ...)` and `startLoop` calls in module scope; the test harness boots the full server and trips on those side-effects.
- `cds.deploy(csn).to(db)` directly against in-memory SQLite — hangs (>30s) on SQLite pool acquire inside the Jest worker.

Unblocking the work needs a self-contained refactor: extract the side-effecting `cds.on('bootstrap', ...)` + `startLoop` calls out of `srv/monitor-service.ts` into a separate `srv/server-init.ts` so the service module can be imported without boot side-effects. That refactor and the integration tests below stay in #50.

**Coverage that PR #49 ships with:**
- `decideJiraInsertStatus` exhaustively unit-tested (30 cases). The algorithm is owned by this pure function — production calls it after pre-fetching rows.
- `CdsDumpRepository.insertParsed` is a thin wrapper: two SELECTs (canonical row + slot rows) + the pure function + an INSERT. The SQL is **not** under test in PR #49 — flagged inline in `srv/dump-repository.ts` so a future reader sees the gap and the link to #50.
- Worker branches (no-existing, open, closed, group-inherited, failed-retry) covered in `jira-worker.test.ts`.
- Smoke acceptance is Task 11 (staging deploy).

**Deferred checklist (lives in #50, not in this PR):**
- Race-proof burst (existing cycle): seed 1 `created`+A row → call `insertParsed` 3 times in sequence with stub returning `open` → assert 1 `pending`+A + 2 `unheard`+A in the DB.
- Closed-then-reopen: seed 1 `created`+A row → stub returns `done` for A → 1 insert creates `pending`+A. Promote that pending row externally to `created`+B. Next insert with stub `open` for B → `pending`+B (canonical scoping).
- Burst after close: seed `created`+A row → stub returns `done` for A → 3 inserts → 1 `pending`+A + 2 `unheard`+A.
- Failed-slot ownership: seed `created`+A and `failed`+A in the same group → stub returns `open` → 1 insert → `unheard`+A (not `pending`).
- Per-tick cache check: probe wraps a Jest mock; 2 inserts of same group within one logical tick → mock called once. Reset probe → mock called again on next insert.

First-cycle race is documented as known-limitation; no integration test asserts a particular outcome there (the spec out-of-scope note is the contract).

### Task 9: Docs sync

**Files:**
- Modify: `docs/examples/abap-dump-monitor/docs/DEDUPLICATION.md` (in-tree reference doc; needs to match spec rounds 5-8)
- Modify: `docs/examples/abap-dump-monitor/docs/OVERVIEW.md` (one-line summary)

- [x] DEDUPLICATION.md exists with initial design.
- [ ] Update DEDUPLICATION.md: canonical-key selection, lifecycle recheck, per-tick cache, closed-branch slot rule, `'failed'` slot ownership, UI gating. Mirror spec sections.
- [x] OVERVIEW.md links to DEDUPLICATION.md and summarises the state machine.

### Task 10: Verify

- [ ] `npx tsc --noEmit` clean.
- [ ] `npx jest --no-coverage` — all suites passing (existing 64 + new `decideJiraInsertStatus` cases in `jira-policy.test.ts` + failed-retry case in `jira-worker.test.ts`). `insert-integration.test.ts` is **not** part of this PR — see 8c.
- [ ] `npx cds compile srv/monitor-service.cds app/monitor/fiori-service.cds --to edmx` clean.
- [ ] Biome / lint clean.

### Task 11: Deploy + smoke test on staging

- [ ] `bin/deploy.sh` to `acme-subaccount-abap-dump-monitor-dev`.
- [ ] Smoke: trigger 2 synthetic dumps with identical signature →
      1 `created` row + 1 `commented` row in MonitoredDump,
      1 ticket + 1 comment in Jira.
- [ ] Smoke: 3rd dump → 1 `unheard` row, no Jira write.
- [ ] Smoke: manually close ticket A in Jira; new dump in next polling cycle →
      `pending`+A claimed, worker creates ticket B with `Recurrence after closed ticket A`,
      row updates to `created`+B; next dump → `commented`+B.
- [ ] Smoke: UI shows `Jira` and `Analysis` buttons disabled on terminal rows.

### Task 12: Roll-out (post-merge)

- [ ] Squash-merge PR #49 to main.
- [ ] For each deploy branch (`acme-prod-stg`, `acme-prod`, `acme-sandbox`, `customer-b`):
      `git merge origin/main -X theirs` → push → redeploy in target subaccount.
- [ ] Delete `docs/superpowers/specs/2026-05-04-jira-dedup-design.md` and `docs/superpowers/plans/2026-05-04-jira-dedup-plan.md` per CLAUDE.md cleanup policy (fully implemented → remove).
