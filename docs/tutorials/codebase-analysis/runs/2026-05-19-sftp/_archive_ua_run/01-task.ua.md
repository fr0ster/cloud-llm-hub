# 01-task — SFTP usage analysis (run 2026-05-19)

> Real run, not an example. Identifiers used as-is here; anonymize before any external share.

## Goal

For the 13 seed reports below, determine how each interacts with SFTP — what methods it uses, where it reads/writes, and what it reads/writes when the source proves it. Output supports a migration handoff; we do **not** design the replacement here.

## Measurement method

Goal is met when `05-result.md` answers, with evidence from stages 2–4:

- Every seed has an SFTP-verdict (yes / no / unclear) with source citation.
- For each "yes" seed: methods used, direction (push/pull), endpoint/system identifier, payload role (what business artifact).
- Blind spots and tooling gaps are recorded explicitly.

## Scope

- **In:** customer namespace `Z*` and `/VERTEX/*` in destination `S4HANA_E19` (system E19 client 100).
- **In:** the 13 seed objects below.
- **In:** objects discovered by where-used / source-search traversal from confirmed SFTP methods.
- **Out:** SAP standard namespace, other systems, replacement design, adjacent mechanisms (IDoc / OData / EDI) unless they explain an SFTP usage site.

## Seed list

1. `/VERTEX/SPOT_VAT_OUTPUT_COMPL`
2. `/VERTEX/SPOT_VAT_INPUT_COMPL`
3. `ZEDI_835`
4. `ZSFTP_CAPARIO_PULL`
5. `ZFI_BANK_STMT_LOAD`
6. `ZSFTP_BNP_PARIBAS_PULL`
7. `ZSFTP_PATIENTCO_PULL`
8. `ZSFTP_CAPARIO`
9. `ZFIU_ACC_POST`
10. `ZEDI_835_JPM`
11. `ZEDI_835_JPM` (duplicate guard — verify Stage 2)
12. `ZDMS_UPLOAD_FILES`
13. `ZSD_MEDICARE_PDF_PROCESS`
14. `ZSFTP_CITI_PULL`

> Stakeholder list contains 13 entries; #10 and the original #11 are both `ZEDI_835_JPM` per source — treat as one seed and confirm at Stage 2. Real items renumbered above for clarity.

## Tooling decisions

Transport: cloud-llm-hub via local MCP proxy at `http://127.0.0.1:3001/v1/chat/completions`, header `x-sap-destination: S4HANA_E19` is auto-injected.

- Object lookup: `SearchObject`.
- Source-text search (AND-matched query/query2 across package): `SearchSource`.
- Source read: `ReadProgram`, `ReadClass`, `ReadFunction`, `GetIncludesList`, `GetInclude`.
- Dependency / where-used: `GetWhereUsed`.
- Model: `anthropic--claude-4.5-sonnet`.
- Per-stage session isolation: fresh chat per stage, artifact carried, history not.

## Success criteria

- Stage 2: every seed has yes/no/unclear with source evidence → `02-methods.md`.
- Stage 3: where-used + source-search traversal complete within declared scope; two passes (forward from methods, reverse cross-check of new objects); blind spots stated → `03-usage-map.md`.
- Stage 4: each usage site has where/how/why with evidence; recurring patterns noted only after ≥2 sites → `04-analysis.md`.
- Stage 5: original goal answered yes/no; migration handoff captured without designing the replacement → `05-result.md`.

## Out of scope

- Designing or building the SFTP replacement.
- Selecting target APIs (e.g., `CL_FS_PATH`, `CL_BCS`, BTP IS).
- Pulling adjacent mechanisms (IDoc, OData, EDI envelopes) unless they directly explain an SFTP usage site.

## Run artifacts

- `runs/2026-05-19-sftp/01-task.md` (this file)
- `runs/2026-05-19-sftp/02-methods.md`
- `runs/2026-05-19-sftp/03-usage-map.md`
- `runs/2026-05-19-sftp/04-analysis.md`
- `runs/2026-05-19-sftp/05-result.md`
- `runs/2026-05-19-sftp/session-log.md` — imitation transcript for the manager-facing demo
- `runs/2026-05-19-sftp/report.pptx` — manager handoff (LibreOffice)
- `runs/2026-05-19-sftp/RETRO.md` — problems, fixes, token accounting
- `runs/2026-05-19-sftp/curl/*.sh` — replayable curl invocations per stage
