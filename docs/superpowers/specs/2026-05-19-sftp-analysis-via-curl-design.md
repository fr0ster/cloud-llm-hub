# Design — Codebase Analysis Run via curl-to-SmartAgent (2026-05-19)

## TL;DR

Replicate, end-to-end via `curl` to a local auth-proxy, the same five-stage SFTP analysis a human would do over 4–12h in the cloud-llm-hub UI. Produce: per-stage markdown artifacts, a UI-style session log, a manager-facing pptx, and a retrospective with split token accounting. Treat this run as the first calibrated tutorial example for the `codebase-analysis` skill.

## Goal

Show that the methodology in `docs/tutorials/codebase-analysis/README.md` collapses a 4–12h manual SAP-codebase analysis into a ~30-minute scripted run, while leaving artifacts a reviewer can audit (curl scripts, per-stage markdown, evidence-backed verdicts).

## Non-goals

- Designing or building the SFTP replacement (Stage 5 only hands off).
- Refactoring `cloud-llm-hub`, the proxy, or the tutorial skills.
- Reproducing the UI's HTML chrome — only its markdown export format.

## Transport architecture

```text
Claude Code (here)
  -> curl -> 127.0.0.1:3001  (mcp-abap-adt-proxy, run by user, browser-auth)
  -> https://...cloud-llm-hub-srv.../v1/chat/completions
  -> SmartAgent pipeline (RAG + tool calls into MCP layer)
  -> https://...S4HANA_E19...                         (header injected by proxy)
```

The proxy injects `x-sap-destination: S4HANA_E19` and the BTP JWT. Validated 2026-05-19: `pong` round-trip works with `usage.models` returning per-model token counts (`gpt-5.2`, `embedder`).

## Five stages, mapped to existing tutorial

| Stage | Driver | Input | Output | Tool channel |
|---|---|---|---|---|
| 1 — formalize | Claude (this session) | informal ask + 13 seeds | `01-task.md` | none |
| 2 — methods | subagent #1, fresh context | `01-task.md`, one seed per turn | `02-methods.md` | curl → SearchSource, ReadProgram, ReadClass |
| 3 — usage map | subagent #2 | confirmed methods from Stage 2 | `03-usage-map.md` | curl → SearchSource (AND-query), GetWhereUsed |
| 4 — analyze | subagent #3 | each usage site from Stage 3 | `04-analysis.md` | curl → ReadProgram, ReadInclude |
| 5 — result | Claude (this session) | all prior artifacts | `05-result.md` + `report.pptx` | none |

Per-stage isolation matches the tutorial rule "one stage per session, fresh chat — carry the artifact, not the history".

## Curl recipe (per request)

```bash
curl -sS -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d @stage-N/request-MM.json
```

`request-MM.json` shape:

```json
{
  "model": "anthropic--claude-4.5-sonnet",
  "messages": [{"role": "user", "content": "<stage-specific prompt>"}],
  "stream": true
}
```

Stream mode is required to capture tool-call events the UI shows as `[SmartAgent: Executing X...]`.

## Session-log fidelity

Goal: the `session-log.md` artifact is indistinguishable from what the cloud-llm-hub UI export produces.

Source of `[SmartAgent: Executing <Tool>...]` markers: the streaming SSE event stream returned by `/v1/chat/completions`. To verify, Stage 2's first invocation runs with `stream:true` and we inspect the raw SSE for tool-call deltas. If present → write a tiny SSE-to-markdown formatter. If absent → synthesize markers from per-request `usage.models` and known tool-call order.

## Token accounting (RETRO)

Two ledgers, both summed at the end:

- **Claude side (this CLI session):** harness `/cost` total at run end minus baseline at run start.
- **cloud-llm-hub side:** sum of `usage.models.*.totalTokens` across all curl responses, broken down per model (`gpt-5.2`, `embedder`). Tracked by tee-ing every response into `runs/2026-05-19-sftp/curl/responses/MM.json` and a final `tokens.py` reducer.

## Lessons-learned discipline

Every grabbed-grab during the run goes into `docs/tutorials/codebase-analysis/skills/lessons/<short-kebab>.md` — one skill per pitfall, not a single mega-skill. Format: trigger, why it bites, mitigation. Append to the `skills/` tree so future runs of the tutorial pick them up automatically.

## Artifact layout

```
docs/tutorials/codebase-analysis/runs/2026-05-19-sftp/
  01-task.md
  02-methods.md
  03-usage-map.md
  04-analysis.md
  05-result.md
  session-log.md          # UI-style markdown imitation
  report.pptx             # manager handoff (python-pptx or LibreOffice)
  RETRO.md                # problems, fixes, token accounting
  curl/
    stage-2/request-01.json … request-13.json
    stage-2/response-01.json … response-13.json
    stage-3/...
    stage-4/...
    run.sh                # idempotent replay
docs/tutorials/codebase-analysis/skills/lessons/
  <new-skills-from-this-run>.md
```

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Proxy buffers SSE → no tool markers | Verify on first Stage-2 call; fallback to synthesized markers from response metadata. |
| SmartAgent timeout on heavyweight search | Use `SearchSource` (10-min timeout already shipped in v6.8.4) over `GetWhereUsed` where AND-search suffices. |
| Seed list has a typo / duplicate (#10/#11 both `ZEDI_835_JPM`) | Stage 2 first action: confirm seed list with `SearchObject`, treat duplicate as one. |
| `S4HANA_E19` destination unreachable | Stage 2 first call doubles as reachability probe; abort and re-auth proxy if 502/504. |
| Code-review deadline (4h) slips while running this | sFTP is the warm-up; if Stage 2 fan-out >30 min, pause, switch to code-review, resume after manager handoff. |

## Success criteria

- All 13 seeds get a Stage-2 verdict with source evidence.
- Stage 5 result file answers the original goal yes/no and includes a migration-handoff section.
- `session-log.md` looks like a UI export when opened in a markdown viewer.
- `report.pptx` opens cleanly in LibreOffice / PowerPoint and tells the story in ≤10 slides.
- `RETRO.md` has both token ledgers and at least 1 new lessons-skill committed.

## Out of scope for this design

- Anonymization for external publication (do post-run if needed).
- Doing the remaining manager tasks (code review, code documentation, RAP). Their tutorial folders will be scaffolded *after* this run validates the approach.
