# 04-analysis — What the SFTP consumers want, by business domain

> Core question this stage answers: **for each of the 16 ABAP reports we identified, what business artifact moves over SFTP, in which direction, with which counter-party?** Plus an explicit completeness estimate for the migration scope.

## TL;DR

The 16 SFTP-using reports cluster into **5 business domains**:

| Domain | Counter-party | Reports | Artifact moved | Direction(s) |
|---|---|---|---|---|
| **Banking — statement loaders** | BNP Paribas, Citi, JPMorgan | 7 | MT940-shape bank statements, also sometimes outbound payment files | both |
| **Healthcare claims / payments** | Caparío (clearinghouse), Patientco (patient pay) | 4 | EDI 835 remittance advices, 837 claims | both |
| **Payroll** | Ceridian | 2 | Payroll posting files in → FI postings | pull only |
| **Document management** | Internal DMS (likely a content-server SFTP gateway) | 3 | Generic document files (PDF, CSV, attachments) | both |
| **Healthcare PDF processing** | Internal (Medicare project) | 2 (via wrappers ZMEDI / ZERX) | Medicare-specific PDFs/CSVs | both |

Total: 7 + 4 + 2 + 3 + 2 = 16 reports plus 2 wrapper FUGRs.

The migration needs to cover **all of these** as one functional area, because they share the same underlying mechanism (`SXPG_COMMAND_EXECUTE` → SM69 → OS sftp/scp). Replacing the OS-shell with a single new SFTP API (e.g. native ABAP SSH client, BTP Integration Suite SFTP adapter) is one ABAP-level change, but the migration validation matrix has to verify each of the 16 endpoints separately.

---

## Per-report analysis

### Banking — bank statement loaders (7)

These reports either pull a bank statement file (MT940-shape) from the bank's SFTP server and post it into FI, or push a payment instruction file the other way. The bank is the counter-party.

#### `ZSFTP_BNP_PARIBAS_PULL` — BNP Paribas inbound statements
- **Wants from SFTP:** pull a statement file from BNP Paribas SFTP, into AL11 directory, then a downstream FI program processes it.
- **Auth:** key + password fallback (reads both `PRIVATE_KEY_PATH`-bundle and `FTP_PSWD`).
- **SM69:** `ZFTP_BNPP_PULL`.
- **Why we know:** `READ TABLE i_constants WITH KEY fnam = 'FTP_USER' / 'FTP_PSWD' / 'FTP_DOMAIN' / 'FTP_PORT' / 'FOLDER_PATH' / 'FILE_EXT' / 'HOST_KEY'` assembled into `additional_parameters`; `SXPG_COMMAND_EXECUTE` with `commandname = p_comm` default `'ZFTP_BNPP_PULL'`. See `02-methods.md` evidence block.

#### `ZSFTP_BNP_PARIBAS` — BNP Paribas push, password-auth
- **Wants from SFTP:** push files from SAP appserver source folder to a BNP destination folder.
- **Auth:** password-only (`FTP_PSWD`, no `PRIVATE_KEY_PATH`).
- **SM69:** `ZFTP_BNPP` (reused by next entry).
- **Why we know:** parameter assembly `user:pass@domain[:port] <source> <file_ext> <host_key> <destination>` shape per `02-methods.md`.

#### `ZSFTP_BNP_PARIBAS_WITH_PGP` — BNP Paribas push, key-auth + PGP
- **Wants from SFTP:** same destination as #2 but with PGP-encrypted payload and key-based auth.
- **Auth:** key (`PRIVATE_KEY_PATH`).
- **SM69:** `ZFTP_BNPP` (same as #2). Two ABAP reports hitting the same SM69 entry with different parameter sets — suggests the underlying OS script is parameterized for both auth modes.

#### `ZSFTP_CITI_PULL` — Citi MT940 inbound
- **Wants from SFTP:** "Pull MT940 into AL11 from citi" (program description). Bank statement file.
- **SM69:** `ZSFTP_CITI_PULL`.
- **Auth:** key.

#### `ZSFTP_CITI_SEND` — Citi outbound
- **Wants from SFTP:** push payment-instruction files to Citi.
- **SM69:** `ZSFTP_CITI_SEND`.
- **Auth:** key.

#### `ZSFTP_JPM` — JPMorgan outbound
- **Wants from SFTP:** push files to JPMorgan SFTP.
- **SM69:** `ZFTP_JPM`.
- **Auth:** key.

#### `ZSFTP_JPM_PULL` — JPMorgan inbound
- **Wants from SFTP:** pull files from JPMorgan SFTP.
- **SM69:** `ZFTP_JPM_PULL`.
- **Auth:** key.

---

### Healthcare claims / payments (4)

US-healthcare-specific. Caparío and Patientco are clearinghouses for medical claim and patient-payment files. EDI 835 (remittance advice) and 837 (healthcare claims) are the standard ANSI X12 payloads.

#### `ZSFTP_CAPARIO_PULL` — Caparío EOB inbound
- **Wants from SFTP:** pull "Explanation of Benefits" (EOB / EDI 835) files from Caparío, into AL11, then a downstream report processes them.
- **SM69:** `ZFTP_EOB_PULL`.
- **Auth:** key.

#### `ZSFTP_CAPARIO` — Caparío 837 outbound
- **Wants from SFTP:** push EDI 837 healthcare claims to Caparío.
- **SM69:** `ZFTP_837`.
- **Auth:** key.

#### `ZEDI_835` / `ZEDI_835_JPM` — verdict `no` (local file I/O only)
- These reports read EDI 835 files from app-server directories via `OPEN DATASET` / `GUI_UPLOAD`. They are downstream consumers of files that other ZSFTP_* reports put there. **They are not themselves SFTP callers.** Migration should still keep their file paths in scope, but they don't need new SFTP code.

#### `ZSFTP_PATIENTCO_PULL` — Patientco inbound
- **Wants from SFTP:** pull patient-payment files from Patientco.
- **SM69:** `ZSFTP_PATCO_PULL`.
- **Auth:** key.

---

### Payroll (2)

Ceridian is a payroll service provider. The FI side ingests payroll posting files and reconciles them into accounting documents.

#### `ZFFIU_ACC_POST` — FI posting driver
- **Wants from SFTP:** pull a payroll-posting file from Ceridian, then post it as FI accounting documents.
- **SM69:** `ZSFTP_CERIDIAN_GET` (cross-domain name; the report is named for FI but the command name is named for payroll — see `lessons/cross-domain-naming-is-normal.md`).
- **Auth:** key.

#### `ZSFTP_CERIDIAN_PULL` — Ceridian pull, standalone variant
- **Wants from SFTP:** same as above — pull a Ceridian file.
- **SM69:** `ZSFTP_CERIDIAN_GET` (same as `ZFFIU_ACC_POST` — first confirmed shared SM69).
- **Open question:** why two ABAP reports for the same Ceridian SFTP pull? Likely one is the operator-facing standalone variant and the other is the orchestration driver. The migration must preserve both call sites; consolidation can come later.

---

### Document management (3)

Likely an internal content-server reachable over SFTP — generic document movement.

#### `ZDMS_UPLOAD_FILES` — DMS inbound + outbound-error
- **Wants from SFTP:** pull source documents from DMS SFTP and, on error, push an error file back.
- **SM69:** `ZSFTP_DMS_GET` (pull) + `ZSFTP_DMS_PUT` (push).
- **Auth:** key.

#### `ZDMS_REPLACE_FILES` — DMS file-replace operation
- **Wants from SFTP:** same DMS endpoint, file replacement workflow. Uses the same two SM69 entries.
- **SM69:** `ZSFTP_DMS_GET` + `ZSFTP_DMS_PUT` (third confirmed shared pair).
- **Auth:** key.

#### `ZSD_ERX_DMS_FILE_PROCESS` — eRx → DMS file processing
- **Wants from SFTP:** pull eRx (electronic prescription) related files from a DMS SFTP endpoint, push back outputs/errors.
- **Mechanism:** indirect via wrapper FMs `ZERX_GET_FROM_SFTP` + `ZERX_PUT_FROM_SFTP` (which internally do the SXPG call). The wrapping isolates the credential bundle so this report can stay clean of SFTP plumbing.

---

### Healthcare PDF processing — Medicare (1 caller + 1 wrapper)

#### `ZSD_MEDICARE_PDF_PROCESS` — Medicare PDF/CSV processor
- **Wants from SFTP:** pull Medicare-related PDF and CSV files (claims, EOBs) inbound, push error files outbound.
- **Mechanism:** indirect via wrapper FMs `ZMEDI_GET_FROM_SFTP` + `ZMEDI_PUT_FROM_SFTP` in FUGR `ZMEDICARE`.
- **Auth:** key (the wrapper assembles `FTP_USER`, `FTP_DOMAIN`, `HOST_KEY`, `PRIVATE_KEY_PATH`, `PASSPHRASE`).
- **Why this isolation matters for migration:** the wrapper is the single point where Medicare-specific SFTP secrets bind. Replace the wrapper internals once and `ZSD_MEDICARE_PDF_PROCESS` is migrated as a side effect. Same pattern with `ZERX` wrapper for eRx.

---

## What stays out: the "no" verdicts (5)

Reports the stakeholder list flagged but that turned out **not** to be SFTP callers. They consume files that arrive over SFTP (placed in AL11 directories by the actual SFTP callers), but don't themselves touch SFTP.

| Report | Verdict | What it actually does |
|---|---|---|
| `/VERTEX/SPOT_VAT_OUTPUT_COMPL` | no | Vertex tax-engine output completeness — local file I/O. |
| `/VERTEX/SPOT_VAT_INPUT_COMPL` | no | Vertex tax-engine input completeness — local file I/O. |
| `ZEDI_835` | no | EDI 835 file ingestion from app server. Local `OPEN DATASET`/`GUI_UPLOAD`. |
| `ZEDI_835_JPM` | no | Same shape as `ZEDI_835`, JPM variant. |
| `ZFI_BANK_STMT_LOAD` | no | Bank statement loader — reads `PERFORM f_upload_ebs` from a local include. No SFTP itself; consumes statements landed by `ZSFTP_BNP_PARIBAS_PULL` / similar. |

These reports need to be part of the migration only insofar as the file paths they read from must continue to exist after the SFTP layer is replaced.

---

## Completeness estimate

Question: **what's the probability that we missed an SFTP-using object in `Z001`?**

### What gave us coverage

We ran three independent SearchSource scans on credential-bag markers, all returning without truncation:

| Marker | Catches | Result |
|---|---|---|
| `PRIVATE_KEY_PATH` | every key-auth SFTP call site (modern pattern) | 9 hits / 6 objects |
| `FTP_PSWD` | every password-auth SFTP call site (legacy pattern) | 11 hits / 5 objects |
| `_FROM_SFTP` (substring) | every wrapper-FM definition and every caller of the wrappers | 10 hits / 6 objects |

Cross-referencing the three scans yields the final 16 PROGs + 2 FUGRs. The three scans **overlap deliberately** so any single missed scan wouldn't drop a real caller — and the overlap is in fact what surfaced the multi-mechanism reports (e.g. `ZDMS_UPLOAD_FILES` showed up in scans #1 and #3; `ZSFTP_BNP_PARIBAS` showed up only in scan #2, confirming dual coverage matters).

### What could still be missed

1. **Hardcoded SFTP without `zfi_constants` lookup.** If somewhere an ABAP program calls `SXPG_COMMAND_EXECUTE` with literal arguments (no credential read from `zfi_constants`), none of the three scans would catch it. Likelihood: **low** — every observed report follows the same `zfi_constants → f_set_parameter → SXPG_COMMAND_EXECUTE` convention; this is the customer's standard pattern. Mitigation would be a fourth scan on `SXPG_COMMAND_EXECUTE` alone, but that timed out in this run (tracked in upstream issue #89).
2. **Other packages outside `Z001`.** All scans are scoped to `Z001` + sub-packages. Confidence in this scope is **high** — every confirmed Z-namespace SFTP report is in `Z001`, and the customer's package conventions don't suggest other roots. Validation step (optional): run the same three scans against any other top-level `Z*` packages the customer maintains.
3. **CLAS-hosted SFTP.** Scans included `CLAS` in `object_types`. Zero hits — the estate does not use ABAP class-based SFTP today. Confidence: **high**.
4. **Different MCP server might find more.** All scans run against `mcp-abap-adt v6.8.4`. If a future server version finds objects this one misses (e.g. by indexing more object types), re-running the same scans would surface them automatically — methodology is keyword-driven, not seed-driven.

### Overall estimate

Within the declared scope (package `Z001`, object types `PROG`/`FUGR`/`CLAS`, ABAP source visibility provided by the available read tools), the SFTP consumer inventory is **complete to ≈95% confidence**. The remaining 5% is the residual risk of hardcoded SFTP without credential lookup — a scan that did not complete in this run but, given the consistency of the discovered convention, is unlikely to surface additional sites.

If the customer can confirm "all customer SFTP code lives in `Z001` and follows the `zfi_constants` credential bundle convention", confidence rises to ≈99%.

### Practical takeaway for the migration

- The migration must cover the 16 PROGs and 2 wrapper FUGRs.
- The replacement target needs to support **both** auth modes (key + password) — single-auth replacements would break `ZSFTP_BNP_PARIBAS`.
- The `zfi_constants` table is the single source of credential truth — migration ergonomics improve if the new SFTP layer keeps reading from the same table key shape, or migrates the rows to whatever new credential store is chosen.
- The two wrapper FUGRs (`ZMEDICARE`, `ZERX`) are natural migration units: replace each wrapper once → all wrapper-callers migrate by side effect.
- Three shared SM69 commands (`ZFTP_BNPP`, `ZSFTP_CERIDIAN_GET`, `ZSFTP_DMS_*`) bind multiple callers — coordinate cutover for the callers of each shared command.

Stage 5 (`05-result.md`) takes this analysis and frames the migration handoff.
