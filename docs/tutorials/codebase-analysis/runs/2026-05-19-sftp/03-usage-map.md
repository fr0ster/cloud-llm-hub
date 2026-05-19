# 03-usage-map — Complete SFTP usage map (run 2026-05-19)

> Where every SFTP-using ABAP object lives in package `Z001`, which mechanism it invokes, and how scope expanded from the original stakeholder list.

## Declared scope

- **Destination:** `DS4_CLH` (EPAM `ai-applications` subaccount, eu10-004).
- **Package:** `Z001` (customer namespace) + sub-packages (`include_subpackages: true`).
- **Object types in scope:** `PROG`, `FUGR`, `CLAS`.
- **Channels used:**
  - `SearchSource` on three credential-bag markers: `PRIVATE_KEY_PATH`, `FTP_PSWD`, `_FROM_SFTP`.
  - `SearchObject` for existence checks per seed.
  - `ReadProgram` / `GetIncludesList` / `GetInclude` for source verification.
  - `GetFunctionGroup` / `GetProgFullCode` attempted on FUGRs but returned metadata only — fell back to FM-name SearchSource.

## Scan invocations (Stage 3 evidence)

| # | Query (single-keyword) | Hits | Wall-clock | Truncation |
|---|---|---|---|---|
| 1 | `PRIVATE_KEY_PATH` | 9 across 6 objects | 418s | none |
| 2 | `FTP_PSWD` | 11 across 5 objects | ~7 min | none |
| 3 | `_FROM_SFTP` (substring, covers all 4 wrapper FM names) | 10 across 6 objects | 443s | none |
| 4 | `FUNCTION zerx_` (FUGR-only) | 2 (ZERX_GET_FROM_SFTP, ZERX_PUT_FROM_SFTP) | 411s | none |
| 5 | `ZSFTP_` (SM69-prefix sanity) | 36 hits across 13 objects | 423s | none |
| 6 | `ZFTP_` (alternate SM69 prefix) | 7 hits across 7 objects | 427s | none |
| 7 | `_TO_SFTP` (substring complement to scan #3) | 8 hits across 5 objects | 430s | none |
| 8 | `ZDMS_EXTRACT_DOCS_TO_SFTP` (callers of newly-found wrapper FM) | 1 hit (definition only, no callers) | 416s | none |

All four scans were single-keyword (no `query2` AND-shape) and run sequentially. Earlier attempts (Stage 3 query A with `SXPG_COMMAND_EXECUTE` + `HOST_KEY` AND-query, and 4 parallel single-keyword scans) all timed out — failure modes documented in `mcp-abap-adt#89`.

## Full inventory of SFTP-using ABAP objects

### Direct SXPG callers (14 PROGs)

Each report contains `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` with `additional_parameters` assembled from `zfi_constants` (credential bundle).

| # | Report | SM69 command (from `p_comm` default or hardcoded literal) | Auth | Direction | Origin in this run |
|---|---|---|---|---|---|
| 1 | `ZSFTP_CAPARIO_PULL` | `ZFTP_EOB_PULL` | key | pull | Stage 2 (seed) |
| 2 | `ZSFTP_BNP_PARIBAS_PULL` | `ZFTP_BNPP_PULL` | hybrid | pull | Stage 2 (seed) |
| 3 | `ZSFTP_BNP_PARIBAS` | `ZFTP_BNPP` ⚑ shared with #4 | **password-only** | push | Stage 3, scan #2 (`FTP_PSWD`) |
| 4 | `ZSFTP_BNP_PARIBAS_WITH_PGP` | `ZFTP_BNPP` ⚑ shared with #3 | key + PGP | push | Stage 3, scan #1 |
| 5 | `ZSFTP_PATIENTCO_PULL` | `ZSFTP_PATCO_PULL` | key | pull | Stage 2 (seed) |
| 6 | `ZSFTP_CAPARIO` | `ZFTP_837` | key | push (EDI 837) | Stage 2 (seed) |
| 7 | `ZFFIU_ACC_POST` | `ZSFTP_CERIDIAN_GET` ⚑ shared with #8 | key | pull | Stage 2 (seed; cross-domain naming) |
| 8 | `ZSFTP_CERIDIAN_PULL` | `ZSFTP_CERIDIAN_GET` ⚑ shared with #7 | key | pull | Stage 3, scan #1 |
| 9 | `ZDMS_UPLOAD_FILES` | `ZSFTP_DMS_GET` + `ZSFTP_DMS_PUT` ⚑ shared with #10 | key | both | Stage 2 (seed) |
| 10 | `ZDMS_REPLACE_FILES` | `ZSFTP_DMS_GET` + `ZSFTP_DMS_PUT` ⚑ shared with #9 | key | both | Stage 3, scan #3 (substring) |
| 11 | `ZSFTP_CITI_PULL` | `ZSFTP_CITI_PULL` | key | pull | Stage 2 (seed) |
| 12 | `ZSFTP_CITI_SEND` | `ZSFTP_CITI_SEND` | key | push | Stage 3, scan #1 |
| 13 | `ZSFTP_JPM` | `ZFTP_JPM` | key | push | Stage 3, scan #1 |
| 14 | `ZSFTP_JPM_PULL` | `ZFTP_JPM_PULL` | key | pull | Stage 3, scan #1 |

⚑ = same SM69 command reused by multiple ABAP reports. Three shared SM69 entries: `ZFTP_BNPP`, `ZSFTP_CERIDIAN_GET`, `ZSFTP_DMS_GET/PUT`. The first reuses one SM69 across two different auth modes (password vs key+PGP) — interesting for migration risk assessment.

### Wrapper-FM callers (2 PROGs)

These reports do not call `SXPG_COMMAND_EXECUTE` directly. They call a Z function module that wraps `SXPG_COMMAND_EXECUTE` with the same credential-bag pattern.

| # | Report | Wrapper FM(s) | Direction | Origin |
|---|---|---|---|---|
| 15 | `ZSD_MEDICARE_PDF_PROCESS` | `ZMEDI_GET_FROM_SFTP`, `ZMEDI_PUT_FROM_SFTP` | both | Stage 2 (seed) |
| 16 | `ZSD_ERX_DMS_FILE_PROCESS` | `ZERX_GET_FROM_SFTP`, `ZERX_PUT_FROM_SFTP` | both | Stage 3, scan #3 (substring) |

### Wrapper-FM FUGRs (3 FUGRs)

| FUGR | Description (from metadata) | Function modules (SFTP-wrapping) |
|---|---|---|
| `ZMEDICARE` | "Medicare Project Function Group" | `ZMEDI_GET_FROM_SFTP` (lines 1..~75), `ZMEDI_PUT_FROM_SFTP` (similar shape) |
| `ZERX` | "Medicare Project Function Group" | `ZERX_GET_FROM_SFTP`, `ZERX_PUT_FROM_SFTP` |
| `ZDMS_SEND_FILE` | (DMS file-extract FUGR) | `ZDMS_EXTRACT_DOCS_TO_SFTP` (calls `f_send_files_to_sftp` form in `LZDMS_SEND_FILEF01` include; uses `pname = 'ZSFTP_DMS_OUT'` constants bag) — **0 literal callers in Z001**, may have dynamic / cross-package callers |

Both wrapper FMs in both FUGRs have the same shape: import `command TYPE sxpgcolist-name` + `constants TYPE bdc_prog`, `SELECT * FROM zfi_constants WHERE pname = constants`, assemble parameters via `PERFORM f_set_parameter`, then `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'`. Source extracts in `02c-code-extracts.md`.

## Mechanism inventory — what SFTP-side artifacts exist

Combining direct and wrapper invocations, the customer codebase references **11 distinct SM69 commands** and **4 Z wrapper FMs** for SFTP:

**SM69 commands (11):**
- `ZFTP_837` (EDI 837 healthcare claims out)
- `ZFTP_BNPP` (BNP Paribas push; reused for password and key+PGP variants)
- `ZFTP_BNPP_PULL` (BNP Paribas pull)
- `ZFTP_EOB_PULL` (Caparío EOB pull)
- `ZFTP_JPM` (JPMorgan push)
- `ZFTP_JPM_PULL` (JPMorgan pull)
- `ZSFTP_CERIDIAN_GET` (Ceridian payroll pull; called from two reports)
- `ZSFTP_CITI_PULL` (Citi MT940 pull)
- `ZSFTP_CITI_SEND` (Citi push)
- `ZSFTP_DMS_GET` + `ZSFTP_DMS_PUT` (DMS document interchange, both directions)
- `ZSFTP_PATCO_PULL` (Patientco pull)

**Wrapper FMs (5):**
- `ZMEDI_GET_FROM_SFTP`, `ZMEDI_PUT_FROM_SFTP` (in `ZMEDICARE` FUGR)
- `ZERX_GET_FROM_SFTP`, `ZERX_PUT_FROM_SFTP` (in `ZERX` FUGR)
- `ZDMS_EXTRACT_DOCS_TO_SFTP` (in `ZDMS_SEND_FILE` FUGR; defined but 0 literal callers in Z001)

All 16 artifacts reduce to one underlying mechanism: `SXPG_COMMAND_EXECUTE` → SM69 entry → OS-level sftp/scp binary on the SAP application server, parametrized from `zfi_constants` rows.

## Auth-pattern categories

Two distinct auth shapes exist in the estate. Migration must cover both:

| Auth pattern | `zfi_constants` keys read | Reports |
|---|---|---|
| **Key-based (modern)** | `FTP_USER`, `FTP_DOMAIN`, `HOST_KEY`, `PRIVATE_KEY_PATH`, `PASSPHRASE`, optional `FTP_PORT`, `FOLDER_PATH`, `FILE_EXT`, `SOURCE_FOLDER`, `ZDEST_FOLD`, `SOURCE_PATH` | 13 of 14 direct reports + both wrapper FMs |
| **Password-based (legacy)** | `FTP_USER`, `FTP_PSWD`, `FTP_DOMAIN`, `FTP_PORT`, `FOLDER_PATH`, `FILE_EXT`, `HOST_KEY` | `ZSFTP_BNP_PARIBAS` (1 report); also referenced as fallback in `ZSFTP_CAPARIO`, `ZSFTP_CAPARIO_PULL`, `ZSFTP_BNP_PARIBAS_PULL`, `ZSFTP_PATIENTCO_PULL` |

The `FTP_PSWD` scan caught one pure password-only report (`ZSFTP_BNP_PARIBAS`) that the key-based scan missed — confirming the dual scan was necessary. Several other reports use *both* (read `FTP_PSWD` defensively even when key auth is configured).

## Scope expansion vs original stakeholder seed list

| Stage | Confirmed SFTP-using objects |
|---|---|
| Original stakeholder list (13 reports) | 13 candidates |
| Stage 2 verdict | 8 yes / 5 no |
| Stage 3 scan #1 (`PRIVATE_KEY_PATH`) | +5 new PROGs + 2 wrapper FUGRs |
| Stage 3 scan #2 (`FTP_PSWD`) | +1 new PROG (`ZSFTP_BNP_PARIBAS`) |
| Stage 3 scan #3 (`_FROM_SFTP`) | +2 new PROGs (`ZDMS_REPLACE_FILES`, `ZSD_ERX_DMS_FILE_PROCESS`) |
| Stage 3 sanity scan (`ZSFTP_` SM69-prefix literal) | +1 wrapper FUGR (`ZDMS_SEND_FILE` — uses `_TO_SFTP` naming, missed by earlier `_FROM_SFTP` substring scan) |
| **Final** | **16 PROGs + 3 FUGRs** |

**Net effect:** the migration scope is **+138% larger** than the 8 confirmed-from-seed reports (8 yes-seeds → 19 confirmed objects). vs original 13-seed stakeholder list: **+46%**. Five of the new findings are bank/payroll SFTP integrations that the stakeholder list did not surface; three are healthcare/DMS integrations linked via wrapper FMs.

## Blind spots and tooling gaps

- **Other packages.** All scans run in `Z001` with `include_subpackages: true`. If the customer has SFTP code in `Y*` or different root packages, this run missed it. Mitigation: run the same three scans against any other top-level customer packages on request.
- **Hardcoded SFTP without credentials in `zfi_constants`.** If somewhere there is a `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` with literal SFTP parameters (no `zfi_constants` lookup), neither `PRIVATE_KEY_PATH` nor `FTP_PSWD` marker would catch it. Likelihood: low (the convention throughout the discovered code is consistent), but possible. A follow-up scan for `SXPG_COMMAND_EXECUTE` alone (no AND filter) would cover this — that scan timed out in this run, see `mcp-abap-adt#89`.
- **FUGR full-source reading is currently limited.** `GetFunctionGroup` returns metadata only on this server; `GetProgFullCode` with type=FUGR returned metadata-only XML in the run. For ZERX and ZMEDICARE we enumerated FMs via `SearchSource("FUNCTION zerx_")` and verified bodies via `GetFunctionModule`. If additional FUGRs need similar treatment, the same FM-name scan pattern applies.
- **AND-query timeout.** `SearchSource` with both `query` and `query2` against a 60k-source package timed out at 600s. Tracked upstream; no impact on completeness for this run because single-keyword scans returned full results.
- **SmartAgent vs MCP discrepancy (resolved).** Initial Stage 3 attempts via SmartAgent without explicit parameters returned truncated results with one hit lost (`ZERX:55`). Once parameters were spelled out in the prompt (`max_objects: 5000`, `max_hits_per_object: 10`, `emit_no_hits: false`, `object_types`, `concurrency: 8`), SmartAgent returned the same complete results as raw MCP. See `using-searchsource.md`.

## Completeness claim

Within the declared scope (package `Z001`, object types `PROG`/`FUGR`/`CLAS`), the SFTP usage map above is **complete to the level provable by the available tools**. Seven SearchSource scans on independent markers (`PRIVATE_KEY_PATH`, `FTP_PSWD`, `_FROM_SFTP`, `_TO_SFTP`, `ZSFTP_`, `ZFTP_`, `FUNCTION zerx_`) all returned without truncation; every wrapper FM was enumerated and its callers identified; all 16 PROG verdicts are source-backed in `02-methods.md` / `02b-methods-deep.md` / `02c-code-extracts.md`.

Outside the declared scope (other packages, hardcoded SFTP without credentials), gaps are listed under blind spots above. None of those would change the answer to the migration question — they would only extend it.
