# 01-task — SFTP usage analysis (run 2026-05-19)

> Real run on destination `DS4_CLH` (ai-applications subaccount, eu10-004). Real object names used as-is. Anonymize before external share.

## Goal

For the 13 seed reports below, determine how each interacts with SFTP — what methods are used, where it reads/writes, and what business artifact moves. Output supports a migration handoff; we do **not** design the replacement here.

## Measurement method

Goal is met when `05-result.md` answers, with evidence from stages 2–4:

- Every seed has an SFTP verdict (yes / no / unclear / not-found) with source citation.
- For each "yes" seed: methods used, direction (push/pull), SM69 command name or class/FM, payload role.
- Blind spots and tooling gaps recorded explicitly.

## Scope

- **In:** customer namespace `Z*` and `/VERTEX/*` in destination `DS4_CLH`.
- **In:** the 13 seed objects below (stakeholder list, corrected 2026-05-19).
- **In:** ABAP objects discovered by where-used / source-search traversal from confirmed SFTP methods.
- **Out:** SAP standard namespace, other systems, replacement design, adjacent mechanisms (IDoc / OData / EDI) unless they directly explain an SFTP usage site.

## Seed list (corrected)

1. `/VERTEX/SPOT_VAT_OUTPUT_COMPL`
2. `/VERTEX/SPOT_VAT_INPUT_COMPL`
3. `ZEDI_835`
4. `ZSFTP_CAPARIO_PULL`
5. `ZFI_BANK_STMT_LOAD`
6. `ZSFTP_BNP_PARIBAS_PULL`
7. `ZSFTP_PATIENTCO_PULL`
8. `ZSFTP_CAPARIO`
9. `ZFFIU_ACC_POST` (corrected from `ZFIU_ACC_POST` after Stage-2 not-found)
10. `ZEDI_835_JPM`
11. `ZDMS_UPLOAD_FILES`
12. `ZSD_MEDICARE_PDF_PROCESS`
13. `ZSFTP_CITI_PULL`

## Tooling decisions

Transport: cloud-llm-hub via local MCP proxy at `http://127.0.0.1:3001/v1/chat/completions`. Headers: `Content-Type: application/json`, `x-sap-destination: DS4_CLH` (overrides the proxy default of `S4HANA_E19`).

Server-side provider: **OpenAI** (`gpt-5.2`, `gpt-5.5-pro-2026-04-23`). Anthropic models are not available in this subaccount; the client-side `model` field is ignored. Embedder usage is reported separately in `usage.models.embedder`.

ABAP tools available to SmartAgent (confirmed by probe):

- `SearchObject` — object lookup by name.
- `ReadProgram` — main program source.
- `ReadClass` — class source.
- `ReadFunctionGroup` — function group source.
- `GetIncludesList(program)` — list of include names (names only, no source).
- `GetInclude(include_name)` — source of a single include.
- `SearchSource` — AND-matched source-text search across a package, 10-min default timeout.

## Run discipline (per-stage)

- One stage per session, fresh chat between stages. Carry the artifact, not the history.
- All prompts and artifacts in English (this run is destined for a manager handoff).
- Streaming responses; SmartAgent emits `[SmartAgent: Executing <Tool>...]` markers inline in the content channel.
- Token accounting: tee every response into `curl/stage-N/response-NN.sse`, sum `usage.models.*` at end of stage.

## Success criteria

- Stage 2: every seed has yes/no/unclear/not-found with source evidence → `02-methods.md`.
- Stage 3: where-used + source-search traversal complete within declared scope; blind spots stated → `03-usage-map.md`.
- Stage 4: each usage site has where/how/why with evidence; recurring patterns noted only after ≥2 sites → `04-analysis.md`.
- Stage 5: original goal answered yes/no; migration handoff captured without designing the replacement → `05-result.md`.

## Out of scope

- Designing or building the SFTP replacement.
- Selecting target APIs.
- Pulling adjacent mechanisms (IDoc, OData, EDI envelopes) unless they directly explain an SFTP usage site.

## Run artifacts

```
docs/tutorials/codebase-analysis/runs/2026-05-19-sftp/
  01-task.md                    (this file)
  02-methods.md
  03-usage-map.md
  04-analysis.md
  05-result.md
  session-log.md
  report.pptx
  RETRO.md
  curl/stage-2/                 (English run, current)
  _archive_ua_run/              (initial Ukrainian-prompt run, archived for retro)
```
