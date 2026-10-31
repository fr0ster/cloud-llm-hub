# Unified RAG tools: stage 3 migration report

No commit or version bump. Shipped seeds remain missing-only; administrators must migrate existing profile/preset text explicitly. Stored allow/deny policies are checked during profile listing/resolution and before worker construction, with an actionable error. No stored text or record IDs are rewritten.

## Restore mechanism

`HubDialogueState.toolContractVersion = 1` is retained by both store encodings. The dialogue session migrates old or unmarked states before handing them to `DialogueSession.open`. All unfinished work is conservatively affected because task goals and old plans can contain instructions without a serialized call: queued/running tasks become the installed library's `interrupted` state, pending/running plan steps become `blocked`, and a plan/task note requires replanning with the canonical catalogue and existing physical record IDs. Completed tasks and transcripts are copied intact. No arguments are renamed and no worker is enqueued by migration. The library TaskBoard typings and implementation accept interrupted records without dispatch; the restore/send tests verify this.

Tool-RAG query adapters already invalidate legacy/canonical cached candidate hits and rebuild canonical candidates from current schemas on every query (stage 1). Stage 3 adds stale legacy-index coverage; SAP-only embedding bundles and intent caches contain none of the removed names and need no rewrite.

## Validation

- Both TypeScript configs: passed.
- Review-fix touched Jest suites with `--maxWorkers=1`: passed: 8 suites, 172 tests (`agent-profile-runner`, `agent-profile-source`, `cross-user-isolation`, `dialogue-rag-tools`, `dialogue-store`, `dialogue-sessions`, `dialogue-store.pg`, `shipped-rag-contract`).
- `npm run lint:check`: passed with 23 existing warnings and 24 informational findings.
- `git diff --check`: passed. Changed/new text uses LF.
- Earlier stage-3 `npm run docs:check` (not rerun during review fixes): ran and failed on three existing references to the uninstalled legacy core package: `docs/architecture/EXTENSION_GUIDE.md:267`, `docs/superpowers/plans/2026-08-31-abap-cloud-session-lifecycle.md:57`, `docs/usage/GETTING_STARTED.md:375`. None are modified by this stage.

## Review fixes

Shared tutorial and preset examples now defer to the current task or phase's collection and stable artifact ID, reuse existing collections, and prohibit updating another phase's artifact. The overview format defaults to its program-specific overview ID. Both tutorials describe persistent user collections and recovery through explicit record IDs instead of file uploads.

The shipped contract test scans all tutorial Markdown, preset text, and profile seed files. It extracts snake_case identifiers inside inline code and snake_case call names anywhere, rejects every RAG-looking reference absent from the registered catalogue, and validates literal JSON call arguments and fenced JSON tool envelopes against the catalogue schemas. TypeScript parses calls to balance nested objects and quoted braces; symbolic variable/shorthand examples are not executable JSON. Regression cases cover invented names and invalid argument keys.

Real hub restore tests cover queued and running legacy tasks, no worker replay, blocked legacy steps, preserved completed evidence, normal persistence of the marker, and reopen. Current-version unfinished plans stay pending. Current-version queued/running tasks are passed unchanged through the hub migration boundary: the installed library independently interrupts active tasks on every restart, so the tests distinguish that existing library behavior from catalogue migration. The provider store test uses a fresh store instance to verify the marker survives persistent envelope encoding/decoding and migration remains idempotent.

Initial review checks exposed test-fixture/parser issues; those were corrected before the successful runs above. No production migration policy changed.

## Remaining removed-name occurrences

Every occurrence is accounted for below, Line numbers identify each matching line; the count includes repeated names on the same line. No shipped profile, preset or tutorial contains a removed name. Historical plans and verification evidence are retained under the design's explicit history-preservation instruction.

| File | Lines | Occurrences | Justification |
| --- | --- | --- | --- |
| `CHANGELOG.md` | 13, 14, 15, 16, 172, 274, 294, 341, 342, 343, 582, 1437, 1659, 1683, 1684 | 25 | Breaking migration table and release history. |
| `docs/superpowers/plans/2026-10-19-persistent-rag-collections.md` | 147 | 2 | Historical implementation/verification evidence retained as required by the design. |
| `docs/superpowers/specs/2026-09-29-configurable-providers-design.md` | 190, 191, 237, 467 | 6 | Historical decisions or authoritative migration mappings; conflicting profile/planner/exclusion decisions carry supersession notes. |
| `docs/superpowers/specs/2026-10-19-persistent-rag-collections-design.md` | 51, 74 | 5 | Historical decisions or authoritative migration mappings; conflicting profile/planner/exclusion decisions carry supersession notes. |
| `docs/superpowers/specs/2026-10-20-long-sessions-design.md` | 57 | 1 | Historical decisions or authoritative migration mappings; conflicting profile/planner/exclusion decisions carry supersession notes. |
| `docs/superpowers/specs/2026-10-24-planner-prompt-design.md` | 174, 369, 370 | 4 | Historical decisions or authoritative migration mappings; conflicting profile/planner/exclusion decisions carry supersession notes. |
| `docs/superpowers/specs/2026-10-30-agent-mcp-rag-write-design.md` | 219 | 3 | Historical decisions or authoritative migration mappings; conflicting profile/planner/exclusion decisions carry supersession notes. |
| `docs/superpowers/specs/2026-10-30-agent-profiles-design.md` | 235, 236 | 4 | Historical decisions or authoritative migration mappings; conflicting profile/planner/exclusion decisions carry supersession notes. |
| `docs/superpowers/specs/2026-10-31-unified-rag-tools-design.md` | 13, 59, 60, 61, 62, 63, 64, 66, 68, 112 | 13 | Historical decisions or authoritative migration mappings; conflicting profile/planner/exclusion decisions carry supersession notes. |
| `docs/superpowers/verification/2026-10-19-persistent-rag-hana.md` | 27, 28, 29 | 3 | Historical implementation/verification evidence retained as required by the design. |
| `srv/anthropic-handler.ts` | 163, 166, 168, 172 | 4 | Explicit removed-name rejection/filtering; never aliases or executable catalogue entries. |
| `srv/lib/dialogue-rag-tools.ts` | 33, 34, 35, 36 | 4 | Explicit removed-name rejection/filtering; never aliases or executable catalogue entries. |
| `srv/openai-handler.ts` | 351, 354, 356, 360 | 4 | Explicit removed-name rejection/filtering; never aliases or executable catalogue entries. |
| `test/unit/agent-mcp-rag.test.ts` | 1535 | 4 | Explicit rejection, stale-index invalidation, migration/no-replay tests, or shipped-content regression pattern. |
| `test/unit/agent-profile-runner.test.ts` | 203 | 4 | Explicit rejection, stale-index invalidation, migration/no-replay tests, or shipped-content regression pattern. |
| `test/unit/agent-profile-source.test.ts` | 265, 266, 267, 268 | 4 | Explicit rejection, stale-index invalidation, migration/no-replay tests, or shipped-content regression pattern. |
| `test/unit/anthropic-channel.test.ts` | 808 | 4 | Explicit rejection, stale-index invalidation, migration/no-replay tests, or shipped-content regression pattern. |
| `test/unit/dialogue-rag-tools.test.ts` | 212, 233 | 8 | Explicit rejection, stale-index invalidation, migration/no-replay tests, or shipped-content regression pattern. |
| `test/unit/dialogue-store.test.ts` | 638 | 4 | Explicit rejection, stale-index invalidation, migration/no-replay tests, or shipped-content regression pattern. |
| `test/unit/openai-channel.test.ts` | 720 | 4 | Explicit rejection, stale-index invalidation, migration/no-replay tests, or shipped-content regression pattern. |

## Files changed

- `CHANGELOG.md`
- `docs/architecture/API_REFERENCE.md`
- `docs/architecture/ARCHITECTURE.md`
- `docs/llm-agent/CONFIG_USAGE.md`
- `docs/superpowers/specs/2026-10-24-planner-prompt-design.md`
- `docs/superpowers/specs/2026-10-30-agent-mcp-rag-write-design.md`
- `docs/superpowers/specs/2026-10-30-agent-profiles-design.md`
- `docs/superpowers/specs/2026-10-31-unified-rag-tools-design.md`
- `docs/superpowers/verification/2026-10-31-unified-rag-tools-stage3.md`
- `docs/tutorials/code-doc-generation/README.md`
- `docs/tutorials/code-doc-generation/overview-skills/skill-format.md`
- `docs/tutorials/code-doc-generation/skills/rag-artifact-ids.md`
- `docs/tutorials/rap-bo-book-catalog/README.md`
- `docs/tutorials/rap-bo-book-catalog/context/phase-procedure.md`
- `docs/tutorials/rap-bo-book-catalog/kickoff-autonomous.md`
- `docs/tutorials/rap-bo-book-catalog/kickoff-review.md`
- `docs/tutorials/rap-bo-book-catalog/skills/README.md`
- `docs/tutorials/rap-bo-book-catalog/skills/managing-rag-artifacts.md`
- `docs/tutorials/rap-bo-book-catalog/video-prompts-simplest-bo.md`
- `srv/agent-manager.ts`
- `srv/agent-profiles/executor.md`
- `srv/agent-profiles/planner.md`
- `srv/lib/agent-profile-runner.ts`
- `srv/lib/agent-profile-source.ts`
- `srv/lib/agent-profile-tools.ts`
- `srv/lib/dialogue-sessions.ts`
- `srv/lib/dialogue-store.ts`
- `srv/presets/rap-context/phase-procedure.md`
- `srv/presets/rap-skills/managing-rag-artifacts.md`
- `test/unit/agent-profile-runner.test.ts`
- `test/unit/agent-profile-source.test.ts`
- `test/unit/cross-user-isolation.test.ts`
- `test/unit/dialogue-rag-tools.test.ts`
- `test/unit/dialogue-sessions.test.ts`
- `test/unit/dialogue-store.pg.test.ts`
- `test/unit/dialogue-store.test.ts`
- `test/unit/shipped-rag-contract.test.ts`
