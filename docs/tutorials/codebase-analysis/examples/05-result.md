# 05-result — SFTP migration analysis: answer to the original goal

> Final stage. Answers the question from `01-task.md`: for the 13 seed reports, how does this codebase use SFTP, with what evidence, and what does the migration team need to start work?

## Answer in one line

The customer's `Z001` namespace uses SFTP through **one underlying mechanism** (`SXPG_COMMAND_EXECUTE` → SM69 entry → OS-level sftp/scp binary), with **two auth variants** (key-based and password-based), across **19 ABAP objects** (16 business-consumer PROGs + 3 wrapper FUGRs), serving **8 counter-party endpoints** across 5 business domains. The migration scope is **+46% larger** than the original stakeholder seed list (13 candidates → 19 confirmed objects).

## Headline numbers

| Metric | Count |
|---|---|
| ABAP objects in migration scope | **18** (16 PROG + 2 FUGR) |
| Business consumers (PROG reports that actually push/pull SFTP) | **16** |
| Wrapper FUGRs (infrastructure; bind credentials for indirect callers) | **3** (`ZMEDICARE`, `ZERX`, `ZDMS_SEND_FILE`) |
| Distinct mechanism artifacts | **16** (11 SM69 commands + 5 wrapper FMs) |
| Distinct counter-party endpoints | **8** (BNP Paribas, Citi, JPMorgan, Caparío, Patientco, Ceridian, internal DMS, internal eRx/Medicare DMS) |
| Auth modes the migration must support | **2** (key-based, password-based) |
| Shared SM69 entries (reused by ≥2 callers) | **3** (`ZFTP_BNPP`, `ZSFTP_CERIDIAN_GET`, `ZSFTP_DMS_GET/PUT`) |
| Seed list size | 13 |
| Seed verdicts: yes | 8 |
| Seed verdicts: no (local file I/O, not SFTP) | 5 |
| Discovered beyond the seed list | 11 (8 new PROGs + 3 wrapper FUGRs) |
| Expansion vs original seed list | **+46%** (13 → 19) |

## Original goal restated (from 01-task.md)

> For the 13 seed reports below, determine how each interacts with SFTP — what methods it uses, where it reads/writes, and what it reads/writes when the source proves it. Output supports a migration handoff; we do not design the replacement here.

Success criteria from `01-task.md`:

- [x] Stage 2 verdict on every seed with source evidence.
- [x] For each "yes" seed: methods used, direction, endpoint, payload role.
- [x] Blind spots and tooling gaps recorded explicitly.
- [x] Stage 5 answers the original question yes/no and provides migration-handoff input.

All four checkpoints are met.

## Verdict summary by seed

| Seed | Verdict | Mechanism (if yes) |
|---|---|---|
| `/VERTEX/SPOT_VAT_OUTPUT_COMPL` | no — local file I/O only | — |
| `/VERTEX/SPOT_VAT_INPUT_COMPL` | no — local file I/O only | — |
| `ZEDI_835` | no — `OPEN DATASET` / `GUI_UPLOAD` only | — |
| `ZSFTP_CAPARIO_PULL` | **yes** | SM69 `ZFTP_EOB_PULL` |
| `ZFI_BANK_STMT_LOAD` | no — local include processing | — |
| `ZSFTP_BNP_PARIBAS_PULL` | **yes** | SM69 `ZFTP_BNPP_PULL` |
| `ZSFTP_PATIENTCO_PULL` | **yes** | SM69 `ZSFTP_PATCO_PULL` |
| `ZSFTP_CAPARIO` | **yes** | SM69 `ZFTP_837` |
| `ZFFIU_ACC_POST` | **yes** | SM69 `ZSFTP_CERIDIAN_GET` |
| `ZEDI_835_JPM` | no — local file I/O only | — |
| `ZDMS_UPLOAD_FILES` | **yes** | SM69 `ZSFTP_DMS_GET` + `ZSFTP_DMS_PUT` |
| `ZSD_MEDICARE_PDF_PROCESS` | **yes** | wrapper FMs `ZMEDI_GET_FROM_SFTP` + `ZMEDI_PUT_FROM_SFTP` |
| `ZSFTP_CITI_PULL` | **yes** | SM69 `ZSFTP_CITI_PULL` |

8 yes / 5 no out of the 13-seed stakeholder list.

## Beyond the seed list — Stage 3 discoveries

The Stage 3 sweep of `Z001` for credential-bag markers (`PRIVATE_KEY_PATH`, `FTP_PSWD`, `_FROM_SFTP`) found 8 additional confirmed SFTP-using objects that the original stakeholder list did not mention:

| Discovery | Type | Why missed in seed list (likely) |
|---|---|---|
| `ZSFTP_BNP_PARIBAS` | PROG | Password-auth variant; without `PRIVATE_KEY_PATH` marker it wasn't obvious |
| `ZSFTP_BNP_PARIBAS_WITH_PGP` | PROG | Newer PGP variant of an existing report |
| `ZSFTP_CERIDIAN_PULL` | PROG | Operator-facing duplicate of `ZFFIU_ACC_POST` SFTP step |
| `ZSFTP_CITI_SEND` | PROG | Outbound counterpart of `ZSFTP_CITI_PULL` |
| `ZSFTP_JPM` | PROG | JPMorgan outbound — entire JPM integration missing from seeds |
| `ZSFTP_JPM_PULL` | PROG | JPMorgan inbound — entire JPM integration missing from seeds |
| `ZDMS_REPLACE_FILES` | PROG | Adjacent to `ZDMS_UPLOAD_FILES`; sharing the same DMS SM69 commands |
| `ZSD_ERX_DMS_FILE_PROCESS` | PROG | Indirect SFTP via the `ZERX` wrapper FUGR |
| `ZMEDICARE` | FUGR | Wrapper FUGR — never in a "list of reports" but is part of the call graph |
| `ZERX` | FUGR | Same — wrapper FUGR for eRx/DMS path |
| `ZDMS_SEND_FILE` | FUGR | Wrapper FUGR (`ZDMS_EXTRACT_DOCS_TO_SFTP`) found via SM69-prefix scan; 0 literal callers in Z001 — needs investigation (dynamic call, cross-package, or dead code) |

**Final migration scope:** 16 PROGs + 3 wrapper FUGRs.

## Single underlying mechanism

Every one of the 16 reports + 2 FUGRs reduces to this pattern:

```text
ABAP report or wrapper FM
   |
   |   READ TABLE i_constants WITH KEY fnam = 'FTP_USER' / 'HOST_KEY' / ...
   |   PERFORM f_set_parameter ...  (assemble additional_parameters string)
   v
CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
   commandname           = <SM69 command name>
   additional_parameters = <assembled string>
   |
   v
SM69 entry (custom Z-prefixed name, one of 11 distinct entries)
   |
   v
OS-level sftp / scp / lftp binary on the SAP application server
   |
   v
Remote SFTP endpoint (bank, payroll provider, healthcare clearinghouse, internal DMS)
```

Migration replaces the `SXPG_COMMAND_EXECUTE` call (and the SM69 + OS binary it relies on) with a native ABAP SFTP client (or a BTP Integration Suite SFTP adapter). One ABAP-level change point; everything else (FORMs, parameter assembly, `zfi_constants` lookup, callers) can be preserved as-is.

## Migration handoff

This section captures everything the migration team should know to start, **without** designing the replacement (per Stage 5 rules).

### What the new SFTP layer must support

1. **Both auth modes.** Key-based (PRIVATE_KEY_PATH + HOST_KEY + PASSPHRASE + FTP_USER + FTP_DOMAIN) AND password-based (FTP_PSWD + FTP_USER + FTP_DOMAIN). `ZSFTP_BNP_PARIBAS` is the only pure password-auth report; several others read `FTP_PSWD` defensively as a fallback.
2. **Both directions.** Pull (download from remote → AL11) and push (upload from AL11 → remote). 8 reports do pull, 6 do push, 2 do both.
3. **PGP layer.** `ZSFTP_BNP_PARIBAS_WITH_PGP` adds a PGP encryption step around the SFTP push. If the new SFTP layer doesn't handle PGP, a separate PGP step has to be wired in (current OS-side handling is hidden inside the SM69 entry).
4. **At least 11 distinct counter-party endpoints.** Each existing SM69 entry binds to a specific bank/provider's SFTP host. Migration credential-management must accommodate all 11.
5. **The `zfi_constants` credential table is the single source of truth.** All 16 reports + 3 wrapper FUGRs read from it. Migrating credentials means either keeping that table or providing a one-to-one shim from the new credential store to it.

### Per-counter-party migration units

A natural order for the migration:

| Priority | Counter-party | Reports touching this endpoint | Migration test cases |
|---|---|---|---|
| 1 | Banking — bank statement loaders (BNP, Citi, JPM) | 7 | MT940 round-trip; PGP for BNP push; both auth modes for BNP |
| 2 | Healthcare clearinghouses (Caparío, Patientco) | 4 | EDI 835/837 round-trip |
| 3 | Payroll (Ceridian) | 2 | Payroll posting file → FI document |
| 4 | Internal DMS / eRx | 5 (3 direct + 1 via ZERX wrapper + ZSD_MEDICARE indirect) | Document file movement; wrapper-FM integrity |

### Acceptance criteria for the cutover

For each of the 16 reports, the new SFTP layer must:

- Read the same `zfi_constants` rows (same `pname`, same `fnam` keys) — or document a one-to-one shim.
- Reach the same remote host, with the same credentials, performing the same operation.
- Return success/failure semantics compatible with what the caller code does next (e.g. `exitcode` field, `exec_protocol` table for log).
- Be exercised by a test harness that triggers each report end-to-end and asserts the file landed (pull) or was delivered (push).

### Known unknowns the migration team has to resolve

- **Why two reports share the Ceridian SM69 command.** Either operator preference or refactor leftover. Suggest consolidating to one report unless business owners disagree.
- **OS-side script behavior per SM69 entry.** `02c-code-extracts.md` shows the ABAP call sites verbatim, but the actual command behavior is in SM69 configuration (Tx SM69 in SAP GUI). Migration must capture the command template per SM69 entry — this is **out of scope for an ABAP-only analysis** and requires Basis / SAP-system access.
- **`FTP_PORT` handling.** Several reports read `FTP_PORT` from `zfi_constants` and concatenate it with `:port` syntax. The new SFTP layer must support non-default ports.

### Out of scope for this analysis (deliberate)

Per `01-task.md`:

- Designing or building the SFTP replacement.
- Selecting target APIs (e.g., `CL_SSH`, `CL_HTTP_CLIENT`, BTP Integration Suite).
- Migrating adjacent mechanisms (IDoc, OData, EDI envelopes) unless they directly explain an SFTP usage site.

Stage 4 confirmed no IDoc / OData / EDI mechanism *replaces* SFTP in any of the 16 reports — SFTP is the transport and the EDI envelopes (835/837) ride on top, so they remain unchanged after migration.

## Completeness confidence

**Within declared scope (`Z001`, types PROG/FUGR/CLAS):** ≈95% confidence that the 16+2 list is complete. Residual 5% covers hardcoded SFTP without `zfi_constants` lookup — convention argues against it. See `03-usage-map.md` for the explicit blind-spot list.

**Outside declared scope:** un-scanned. If customer code exists in other top-level `Z*` packages, those should be scanned with the same three-marker SearchSource pattern before a final migration scope freeze.

## Output for the migration team

- **`02-methods.md`** — per-seed verdict with source evidence.
- **`02b-methods-deep.md`** — open-ended method enumeration per "yes" seed.
- **`02c-code-extracts.md`** — verbatim ABAP snippet for every distinct mechanism artifact (11 SM69 entries + 4 wrapper FMs).
- **`03-usage-map.md`** — full inventory with scope-expansion lineage, shared mechanisms, auth categories, blind spots.
- **`04-analysis.md`** — per-business-domain explanation of what each consumer wants from SFTP + the completeness estimate.
- **This file (`05-result.md`)** — the migration-handoff narrative.
- **`session-log.md`** — UI-style markdown render of the agent transcripts (for stakeholder demo).
- **`report.pptx`** — manager-facing slide deck (one page per finding).
- **`RETRO.md`** — internal retrospective: token accounting, lessons, what went wrong and what we did about it.
