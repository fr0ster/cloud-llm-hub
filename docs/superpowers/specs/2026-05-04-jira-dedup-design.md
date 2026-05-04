# Recurring-Dump Deduplication — Design

> Spec for issue [#48](https://github.com/fr0ster/cloud-llm-hub/issues/48). PR [#49](https://github.com/fr0ster/cloud-llm-hub/pull/49).

## Problem

`abap-dump-monitor` creates a separate Jira ticket per dump. Same root-cause dumps recurring every few minutes spawn N tickets for one defect. Effects:

- Triage noise; the same RCA gets re-discovered N times.
- No visibility into "we raised the alarm via Jira but the issue keeps recurring" (operators ignored the open ticket).
- Per-dump label `<system>-<dumpId>` is unique per occurrence → Jira-side dedup never triggers across recurrences.

## Goal

A recurring dump (matching a known signature) must:

1. Not create a duplicate Jira ticket.
2. Comment on the existing open ticket — once, not every time.
3. If the existing ticket is closed, create a new ticket with a back-reference to the closed key. Manual closure is detected on **the next recurrence INSERT in a subsequent Discoverer tick** (per-tick cache, see "Cost of the recheck"); detection is event-bounded, not time-bounded — without a new dump in a later tick, closure stays unobserved and no new ticket is created.
4. After the alarm has been raised + commented at least once, every further recurrence is marked **unheard** in our DB and skips Jira **writes** (does not `create` or `comment`). The discoverer still issues a single `getIssue` read per INSERT to detect manual closure of the canonical ticket — see "Lifecycle recheck" below — but never produces a new Jira event from an `unheard` row. Operators see in our UI that the issue keeps happening despite an open ticket; we don't spam Jira.

Each dump remains a separate `MonitoredDump` row (audit trail). The deduplication is at the Jira-write boundary, not in our storage.

## Group identity

Existing `MonitoredDump.signature: String(200)` is the grouping key. Computed in the discoverer at INSERT from `Setting('DUMP_SIGNATURE_FIELDS')` (default: `system | runtimeError | program | include`). Two rows with the same `signature` are the same group.

For the Jira side, derive a stable label:

```
signatureLabel(signature) = 'dump-sig-' + sha1(signature)[0..16]
```

Same value across every recurrence. A single `searchByLabel(sigLabel)` is the canonical Jira-side dedup point. Truncated SHA-1 keeps the label short and Jira-valid; collision risk over the dataset is negligible.

## Group marking in our DB

**Decision: explicit at the row level, no new database columns.**

The discoverer, at INSERT, looks up the current canonical ticket-creation row in the same `signature` group (defined in the state machine below as the latest row with `jiraStatus='created'` and `jiraIssueKey IS NOT NULL`). If found:

- **Inherits** that `jiraIssueKey` onto the new row immediately. Each dump in a group knows its group's canonical Jira ticket without an extra Jira API call.
- Picks the new row's initial `jiraStatus` based on the group's history (state machine below).

Recurrence visibility for UI uses two virtual fields populated in after-READ over rows sharing the same signature:

- `recurrenceCount: Integer` — total dumps in this group seen so far.
- `firstOccurrenceID: UUID` — ID of the oldest row in the group (List Report → Object Page navigation target).

No schema migration. Group is recoverable purely from `signature` + `jiraIssueKey`.

## State machine

The INSERT rule is scoped to the **canonical key** of the current ticket cycle, not to the group's all-time history. This makes the rule both race-proof within a cycle (at most one `pending`-with-inherited-key row exists, so the worker comments at most once per cycle) and lifecycle-correct across cycles (closed → re-opened with a new ticket → the new cycle gets its own comment).

**Canonical selection:** the canonical row is the latest **ticket-creation event** in the group, not the latest keyed row by `firstSeenAt`. A burst of `unheard` followers can have later `firstSeenAt` than the creator row whose `jiraIssueKey` was overwritten to a new cycle's ticket; selecting purely by `firstSeenAt DESC` would let those followers shadow the new cycle and trigger spurious next-cycle creates. Selecting on `jiraStatus='created'` keeps canonical anchored to the current cycle's ticket-creation row regardless of subsequent unheard inserts.

```
INSERT algorithm (set by the discoverer):

  canonical := SELECT row in group
                 WHERE jiraStatus = 'created' AND jiraIssueKey IS NOT NULL
                 ORDER BY firstSeenAt DESC LIMIT 1

  if canonical is None:
    new.jiraStatus    = 'pending'                              # group has no ticket yet — this row will create the first
    new.jiraIssueKey  = NULL

  else:
    new.jiraIssueKey  = canonical.jiraIssueKey                  # inherit canonical key

    # Lifecycle recheck — the canonical ticket may have been closed manually
    # since the last recurrence. Without this read, every later recurrence
    # would land in 'unheard' (the cycle's slot already used) and the worker
    # would never reach the closed→create-new branch.
    issue := jira.getIssue(canonical.jiraIssueKey)

    if issue.statusCategoryKey == 'done':
      # Canonical ticket closed → start a new cycle. Slot rule applies just
      # like in the open branch, but scoped to ONE pending claim per
      # (signature, old canonical key) so a burst after manual close does
      # not produce N new tickets. The first INSERT after close claims
      # 'pending'; the worker creates ticket B with a 'Recurrence after
      # closed ticket A' back-reference and overwrites jiraIssueKey on
      # success. Every burst follower lands in 'unheard'. A failed creator
      # attempt still owns this slot until it succeeds or exhausts retries.
      reopen_slot_taken := EXISTS row in group
                             WHERE jiraIssueKey = canonical.jiraIssueKey
                             AND   jiraStatus IN ('pending','failed')
      if reopen_slot_taken:
        new.jiraStatus = 'unheard'      # someone else will create the next-cycle ticket
      else:
        new.jiraStatus = 'pending'      # claim the next-cycle creator slot
    else:
      # Ticket still open → apply the slot rule scoped to the CURRENT cycle.
      # Old rows from a previous closed→reopened cycle (different
      # jiraIssueKey) are ignored.
      slot_taken := EXISTS row in group
                      WHERE jiraIssueKey = canonical.jiraIssueKey
                      AND   jiraStatus  IN ('pending','failed','commented','unheard')
      if slot_taken:
        new.jiraStatus = 'unheard'      # comment slot already claimed (pending/failed) or used (commented/unheard)
      else:
        new.jiraStatus = 'pending'      # canonical.jiraStatus = 'created' AND no slot holder yet — claim it
```

Race-proofness within a cycle: between creation of the first ticket (`canonical.jiraStatus='created'`) and the worker's comment-tick on the second dump, more dumps may land. The first recurrence finds `slot_taken=false` and takes `'pending'+key`. Every subsequent insert sees the now-pending row in the same cycle (`slot_taken=true`) and lands in `'unheard'`. The worker comments once.

Lifecycle across cycles: the explicit `jira.getIssue(canonical.jiraIssueKey)` read at INSERT detects manual closure of the canonical ticket. When detected, the new row goes to `'pending'`, the worker enters the closed-ticket branch and creates ticket B with the back-reference. The new row's `jiraStatus='created'+B` becomes the new canonical. Subsequent recurrences scope their slot check to `jiraIssueKey=B`; rows from cycle A are ignored.

Cost of the recheck: **logically** one Jira `GET /rest/api/2/issue/{key}` per INSERT in a group with a canonical key. **Physically**, implementation MUST cache `getIssue` results **per-tick** (i.e. for the duration of one `Discoverer.tickOnce` call), so a burst of recurrences against the same canonical key within a single tick collapses to **at most one Jira read per canonical key per tick**. The cache MUST be discarded between ticks — cross-tick reads always re-fetch from Jira.

Manual-closure detection is **event-bounded, not time-bounded**: it is bounded by the next recurrence INSERT processed after the current tick, with a fresh per-tick Jira read. A ticket closed during tick N — after the cache already returned `open` — is still seen as `open` for the rest of tick N's INSERTs (those rows go to `unheard` and stay there). The first INSERT in tick N+1 (or later) for the same signature group sees the fresh `done` status and triggers the closed-cycle slot rule. If no new dump for that signature ever arrives, closure stays unobserved and no new ticket is created — that is acceptable for a recurrence-driven monitor. Acceptance criteria for the closed-then-reopened lifecycle reflect this event-bounded contract.

The cache lives in the discoverer / Jira client wrapper, never in CDS state. A long-lived TTL cache (e.g. 30 s spanning multiple ticks) is explicitly disallowed because it can hide a manual close between ticks and starve the new-cycle creation indefinitely.

Concurrency assumption: a single Discoverer instance per deployment, INSERTs are serialised within a tick. With multiple Discoverer instances the rule needs a DB-level claim. Suitable shape: a unique partial index `UNIQUE INDEX ... ON MonitoredDump (signature, jiraIssueKey) WHERE jiraStatus = 'pending' AND jiraIssueKey IS NOT NULL`. With that index in place, two concurrent INSERTs for the same `(signature, canonical.jiraIssueKey)` cannot both produce a `'pending'` row — the loser hits a unique-constraint violation and the discoverer retries with the slot-rule outcome. Explicitly out of scope for this PR.

```
jiraStatus transitions driven by JiraWorker / pushToJira action
(operates on 'pending' or 'failed' rows; 'unheard' bypasses the worker):

  pending  ──► created    (no group ticket exists — fresh ticket; sigLabel + dumpLabel attached)
  pending  ──► commented  (group ticket exists AND open  — single comment)
  pending  ──► created    (group ticket exists AND closed — new ticket with back-reference)
  pending  ──► failed     (Jira call threw — auto-retried up to JIRA_MAX_ATTEMPTS)
  failed   ──► created | commented   (next worker tick / button click)
```

`'unheard'` is terminal. No further Jira write.

## Worker resolution at processOne

```
1. Resolve the group's existing ticket:
     row.jiraIssueKey set (group inheritance)  → getIssue(row.jiraIssueKey)
     else                                       → searchByLabel(sigLabel)   ← also covers manually-created tickets

2. existing AND open    → comment                                       → jiraStatus='commented'
3. existing AND closed  → create with description "Recurrence after
                          closed ticket <key>"                          → jiraStatus='created'
4. not found            → create                                        → jiraStatus='created'

Created tickets always carry both labels:
  • sigLabel  (dedup key, stable across recurrences)
  • dumpLabel (per-dump cross-reference, "<system>-<dumpId>" sanitized to [A-Za-z0-9._-])
```

## Manual control

`pushToJira` admin action runs the same dedup logic on a single row. The action handler MUST select the row with `jiraIssueKey` and `signature` columns populated, so the worker's group-inheritance path (`row.jiraIssueKey ? getIssue : searchByLabel`) takes the cheap branch when a group ticket is known. Otherwise manual mode silently degrades to label-only search and risks duplicating tickets that were created before `sigLabel` existed.

### UI gating

The Object Page **Jira** button is exposed only on rows where the action can do something useful. UI-side gating via `@Common.OperationAvailable`:

```
pushToJira    → enabled when jiraStatus IN ('pending', 'failed')
retryAnalysis → enabled when analysisStatus IN ('failed', 'analyzing')
```

Server-side handlers keep their own preconditions as defence-in-depth; the annotation only affects the rendered button state. Clicking `pushToJira` on a `'unheard'` row would otherwise route through the worker, which bails on non-pending status, and the action returns `502 Jira step failed: unknown error` — the annotation prevents that misleading outcome from being reachable in the first place.

`Setting('JIRA_MODE')` controls auto-mode:

- `manual` (default) — JiraWorker dormant; operator clicks **Jira** in the UI.
- `auto` — worker runs every `JIRA_TICK_MS`.

Dedup logic is identical in both modes.

## Backfill

Pre-existing tickets carry only the per-dump label. This change does **not** retroactively add `sigLabel` to old tickets — adding it to NEW tickets is sufficient for the dedup loop to converge as new dumps arrive (the discoverer's group resolution queries our DB, not Jira labels, so recurrences of pre-existing groups still inherit their group's `jiraIssueKey`).

If full backfill becomes necessary later, add a one-shot migration action that walks `MonitoredDump` rows with `jiraIssueKey IS NOT NULL` and PATCHes each Jira ticket to add `sigLabel`. Idempotent; can be re-run.

## Acceptance criteria

- **First and second recurrence:** two synthetic dumps with identical signature → first row `jiraStatus='created'`, second row `jiraStatus='commented'`. Jira side: 1 ticket + 1 comment.
- **Third recurrence:** three synthetic dumps with identical signature processed sequentially → `created` + `commented` + `unheard`. Jira side: still 1 ticket + 1 comment.
- **Burst case (race-proof, existing cycle):** after the first ticket already exists (`canonical != None`), N (≥2) recurrence dumps with identical signature inserted before the worker's first comment-tick → exactly 1 `pending`→`commented` row + N-2 `unheard` rows. Only one comment is posted regardless of insert/tick timing.
- **Closed-then-reopened lifecycle:** create cycle A → close ticket A manually → new dump arrives in a **subsequent** Discoverer tick → worker creates ticket B with back-reference → next recurrence in same group becomes `commented` against B (not `unheard` against A's history). Verifies canonical-key scoping AND the per-tick cache discipline. Closure detection is **event-bounded** by the next recurrence INSERT in a later tick — not time-bounded; if no new dump arrives in any subsequent tick, the closure remains unobserved and no ticket B is created. That outcome is acceptable for a recurrence-driven monitor.
- **Burst after close (race-proof closed branch):** ticket A closed manually → N (≥2) dumps with that signature land before the worker has created cycle B → exactly 1 row claims `pending+old key A` (worker promotes it to `created+B`); the other N-1 land in `unheard+old key A`. Jira side: 1 new ticket, no duplicates.
- **Failed slot ownership:** a row that claimed the open-cycle comment slot or closed-cycle creator slot and then moved to `jiraStatus='failed'` still owns that slot for retries. A later recurrence in the same `(signature, jiraIssueKey)` cycle lands in `unheard`, not a second `pending`, so retry ownership cannot duplicate the same Jira write.
- `pushToJira` action manually triggered on an inherited `'pending'` row → uses `getIssue(row.jiraIssueKey)` (1 Jira call), not `searchByLabel` (would be 2 calls and miss labels-not-yet-applied).
- Object Page **Jira** button is **not executable** (disabled by `@Common.OperationAvailable`) on rows where `jiraStatus IN ('created','commented','skipped','unheard')`. Whether the disabled button is hidden vs greyed-out is a per-Fiori-client rendering choice and not part of the contract.
- Unit tests in `test/unit/jira-worker.test.ts` covering the four worker branches (no existing, open, closed, group-inherited) plus discoverer-level tests for the burst case (3 inserts → exactly 1 pending claim), the closed→reopen case (canonical-key scoping), and failed-slot ownership (`failed` claim blocks a second pending claim).

## Out of scope

- Schema changes (no new columns).
- Retroactive backfill of pre-existing Jira tickets.
- UI grouping in List Report — `recurrenceCount` is exposed as a column; visual grouping (`@UI.PresentationVariant.GroupBy`) is left for a follow-up if it turns out to be needed in practice.
- **First-cycle burst race.** A group with no prior `'created'` row (the very first cycle for a fresh signature) has `canonical = None` for every INSERT before the first worker create, so several burst dumps can all land as `'pending'+no-key`. The worker then `searchByLabel(sigLabel)` for each: the first call creates ticket A, every subsequent call finds A and `comment`s. Result: 1 ticket + 1 expected comment + (N-2) extra comments instead of 1 ticket + 1 comment + (N-2) `unheard` rows. Acceptable bounded noise — operationally rare because the discoverer normally inserts the very first dump of a brand-new signature ahead of any recurrence. A targeted follow-up could extend the slot rule to the `canonical is None` branch (`EXISTS row in group WHERE jiraStatus IN ('pending','failed') AND jiraIssueKey IS NULL`) to prevent duplicate first-cycle writes; exact follower status/backfill semantics are deferred.
