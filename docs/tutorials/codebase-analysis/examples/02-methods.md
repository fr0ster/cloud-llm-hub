# 02-methods — SFTP verdicts (run 2026-05-19)

> Streaming `/v1/chat/completions` via `ai-applications` proxy → cloud-llm-hub-srv (provider OpenAI, model `gpt-5.2`) → destination `DS4_CLH`. Stage-2 reads object + all includes; package-wide wrapper search deferred to Stage 3.

## Summary

| # | Seed | Verdict | Tools fired |
|---|------|---------|-------------|
| 1 | `/VERTEX/SPOT_VAT_OUTPUT_COMPL` | **no** | SearchObject, ReadProgram, GetIncludesList, SearchSource×4, GetInclude×3 |
| 2 | `/VERTEX/SPOT_VAT_INPUT_COMPL` | **no** | SearchObject, ReadProgram, SearchSource×4 |
| 3 | `ZEDI_835` | **no** | SearchObject, ReadProgram, GetIncludesList, GetInclude×4, SearchSource×4 |
| 4 | `ZSFTP_CAPARIO_PULL` | **yes** | SearchObject, ReadProgram |
| 5 | `ZFI_BANK_STMT_LOAD` | **no** | ReadProgram, GetIncludesList, GetInclude×2 |
| 6 | `ZSFTP_BNP_PARIBAS_PULL` | **yes** | GetProgram, ReadProgram, GetIncludesList |
| 7 | `ZSFTP_PATIENTCO_PULL` | **yes** | ReadProgram, GetIncludesList |
| 8 | `ZSFTP_CAPARIO` | **yes** | GetProgram, GetIncludesList |
| 9 | `ZFFIU_ACC_POST` | **yes** | ReadProgram, GetIncludesList, GetInclude×3 |
| 10 | `ZEDI_835_JPM` | **no** | ReadProgram, GetIncludesList, GetInclude×4 |
| 11 | `ZDMS_UPLOAD_FILES` | **yes** | ReadProgram, GetIncludesList, GetInclude×2 |
| 12 | `ZSD_MEDICARE_PDF_PROCESS` | **yes** | GetProgram, GetIncludesList, GetInclude×2 |
| 13 | `ZSFTP_CITI_PULL` | **yes** | ReadProgram, GetIncludesList |

## Token usage (cloud-llm-hub side, Stage 2)

| Model | prompt | completion | total | requests |
|---|---|---|---|---|
| `gpt-5.2` | 384,532 | 12,246 | 396,778 | 58 |
| `embedder` | 4,204 | 0 | 4,204 | 13 |
| **GRAND** |  |  | **400,982** |  |

## Verdict tally

- **yes**: 8
- **no**: 5

## Per-seed verdicts

### 1. `/VERTEX/SPOT_VAT_OUTPUT_COMPL` — **no**

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
**Verdict:** no  
**Type:** PROG  
**SFTP methods / mechanisms:**
- None found (no evidence of SFTP/FTP/SSH usage; no `SXPG_COMMAND_EXECUTE`; no SFTP/FTP/SSH wrappers detected in package search)

**Evidence (program_or_include:line — snippet):**
- /VERTEX/SPOT_VAT_OUTPUT_COMPL:1 — `REPORT  /vertex/spot_vat_output_report ...`
- /VERTEX/SPOT_VAT_OUTPUT_COMPL:~70 — `PERFORM download_selected_data.`
- /VERTEX/SPOT_VAT_OUTPUT_COMPL:~430 — `CALL METHOD /vertex/cl_spot=>create_file_new ... iv_gui_download = p_pc ... iv_filename = lv_filename`
- /VERTEX/SPOT_VAT_OUTPUT_COMPL:~455 — `CALL METHOD /vertex/cl_spot=>validate_file_name ...`
- /VERTEX/SPOT_ALV_FORMS:~1 — (ALV fieldcatalog handling only; no network/file transfer APIs)
- /VERTEX/SPOT_EVENTS:~1 — (ALV event handling only; no network/file transfer APIs)
- /VERTEX/SPOT_OUTPUTVATCOMPLTOP:~1 — (selection screen + data declarations only; no network/file transfer APIs)
- Package /VERTEX/SPOT search results — `SXPG_COMMAND_EXECUTE`: 0 hits; `SFTP`: 0 hits; `FTP`: 0 hits; `SSH`: 0 hits (per `SearchSource` scans)

**Notes:**  
- Proven behavior is **file creation/download** via `/vertex/cl_spot=>create_file_new` with user choice **PC vs server** (push to local frontend or write to app server), but **no SFTP mechanism is evidenced** anywhere in the program or its includes, and no SFTP/FTP/SSH-related wrappers were found in package `/VERTEX/SPOT` by source search.

---

### 2. `/VERTEX/SPOT_VAT_INPUT_COMPL` — **no**

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
**Verdict:** no  
**Type:** PROG  
**SFTP methods / mechanisms:**
- none found (no `SXPG_COMMAND_EXECUTE`, `SFTP`, `FTP`, or `SSH` usage in the analyzed scope)

**Evidence (program_or_include:line — snippet):**
- /VERTEX/SPOT_VAT_INPUT_COMPL:(download_selected_data) — `CALL METHOD /vertex/cl_spot=>create_file_new ... iv_gui_download = p_pc iv_filename = lv_filename ...` (file creation/download is handled via `/vertex/cl_spot=>create_file_new`, not via SFTP/FTP/SSH in this program)
- /VERTEX/SPOT_VAT_INPUT_COMPL:(includes) — `INCLUDE: /vertex/spot_events.` / `INCLUDE: /vertex/spot_alv_forms.` / `INCLUDE: /vertex/spotforms.` (includes exist, but were **not** read because the required `GetIncludesList` / `GetInclude` tooling is not available here)

**Notes:**  
- This program is an “Input VAT Compliance Report” and appears to **export/download** report data to PC or application server (selection screen has `p_pc` / `p_server`; file name `INP_VAT_...TXT`), but **no SFTP/FTP/SSH mechanism is proven** in the main program source.  
- Package-wide search (restricted by `object_filter="*SPOT_VAT_INPUT_COMPL*"`) found **no** hits for `SXPG_COMMAND_EXECUTE`, `SFTP`, `FTP`, or `SSH`, so there is no evidence of legacy SM69 shell-based SFTP either.

---

### 3. `ZEDI_835` — **no**

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
**Verdict:** no  
**Type:** PROG  
**SFTP methods / mechanisms:**
- None found in `ZEDI_835` or its includes (no SFTP/SSH/FTP transfer logic; only local frontend upload and app-server filesystem dataset operations).

**Evidence (program_or_include:line — snippet):**
- `ZEDI_835:1` — `REPORT  ZEDI_835`
- `ZEDI_835:8-9` — `INCLUDE zedi_edi_top.` / `INCLUDE zedi_835_top.`
- `ZEDI_835:14` — `PERFORM read_file_data.`
- `ZEDI_835_F01` (read/app-server directory) — `CALL FUNCTION 'EPS2_GET_DIRECTORY_LISTING'`
- `ZEDI_835_F01` (read app-server files) — `OPEN DATASET gv_file  FOR INPUT IN TEXT MODE ENCODING DEFAULT .`
- `ZEDI_835_F01` (frontend upload when not `p_app`) — `CALL FUNCTION 'GUI_UPLOAD'`
- `ZEDI_835_F01` (archive/move implemented as file copy on app server) — `OPEN DATASET gv_arc_file FOR OUTPUT...` and `TRANSFER wa_final_data TO gv_arc_file.`
- `ZEDI_835_F01` (error/log writing on app server) — `OPEN DATASET gv_log_file  FOR OUTPUT...` and `TRANSFER wa_log TO gv_log_file.`
- `ZEDI_835_TOP` (selection screen default path hints “FTP” folder name but not a transfer mechanism) — path building like `...\\data\\FTP\\...` appears only in concatenated filesystem paths.

**Notes:**  
- Direction: file **pull/read** from application server directory when `p_app = 'X'` (directory listing + `OPEN DATASET ... FOR INPUT`), otherwise **pull/read** from user PC via `GUI_UPLOAD`.  
- Payload role (proven by source): reads EDI 835 `.era` content and posts/updates EOB-related Z-tables (e.g., `MODIFY zzsinpm_mceob_hd`, `..._it`, `..._amnt`, `..._plb`).  
- Package-wide wrapper scan for `SXPG_COMMAND_EXECUTE` / `SFTP` / `FTP` / `SSH` in package `Z001` could not be completed because all `SearchSource` calls **timed out** in this run, so only direct-object/includes evidence is reflected above.

---

### 4. `ZSFTP_CAPARIO_PULL` — **yes**

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]
**Verdict:** yes  
**Type:** PROG  
**SFTP methods / mechanisms:**
- `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` executing an SM69 external command (`p_comm`, default `ZFTP_EOB_PULL`) with `additional_parameters` constructed from `FTP_USER`, `FTP_PSWD`, `FTP_DOMAIN`, `FOLDER_PATH`, `FILE_EXT`, `HOST_KEY` (meets your rule: SXPG + FTP_USER/FTP_DOMAIN/HOST_KEY ⇒ **yes**)

**Evidence (program_or_include:line — snippet):**
- `ZSFTP_CAPARIO_PULL:27 — PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_EOB_PULL'.`
- `ZSFTP_CAPARIO_PULL:33 — SELECT * FROM zfi_constants ... WHERE pname = 'ZSFTP_835_PULL'.`
- `ZSFTP_CAPARIO_PULL:38 — READ TABLE ... WITH KEY fnam = 'FTP_USER'. ... g_path = wa_constants-fval.`
- `ZSFTP_CAPARIO_PULL:60 — READ TABLE ... WITH KEY fnam = 'FTP_PSWD'. ... CONCATENATE g_path ':' wa_constants-fval INTO g_path.`
- `ZSFTP_CAPARIO_PULL:76 — READ TABLE ... WITH KEY fnam = 'FTP_DOMAIN'. ... CONCATENATE g_path '@' wa_constants-fval INTO g_path.`
- `ZSFTP_CAPARIO_PULL:95 — READ TABLE ... WITH KEY fnam = 'FOLDER_PATH'. ... CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY space.`
- `ZSFTP_CAPARIO_PULL:106 — READ TABLE ... WITH KEY fnam = 'FILE_EXT'. ... CONCATENATE g_path wa_constants-fval INTO g_path.`
- `ZSFTP_CAPARIO_PULL:126 — READ TABLE ... WITH KEY fnam = 'HOST_KEY'. ... CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY space.`
- `ZSFTP_CAPARIO_PULL:152 — CALL FUNCTION 'SXPG_COMMAND_EXECUTE' EXPORTING commandname = p_comm additional_parameters = g_path ...`

**Notes:** direction appears to be **pull** (report name `*_PULL`, default command `ZFTP_EOB_PULL`, description “Capario Pull SFTP”). Host/endpoint is not explicitly shown as `FTP_HOST`; instead parameters include `FTP_DOMAIN` and `HOST_KEY`, implying the external command likely performs SFTP using those values. Payload looks like remote file selection via `FOLDER_PATH` + `FILE_EXT` (and optional `p_date` wildcard).

---

### 5. `ZFI_BANK_STMT_LOAD` — **no**

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
**Verdict:** no  
**Type:** PROG  

**SFTP methods / mechanisms:**
- None found in `ZFI_BANK_STMT_LOAD` or its includes (no `SXPG_COMMAND_EXECUTE`, no SFTP/SSH credential assembly, no known SFTP client classes/FMs).

**Evidence (program_or_include:line — snippet):**
- `ZFI_BANK_STMT_LOAD:1` — `REPORT zfi_bank_stmt_load.`
- `ZFI_BANK_STMT_LOAD:6` — `PERFORM f_upload_ebs.`
- `ZFI_BANK_STMT_LOAD_F01:18` — `CALL FUNCTION 'EPS_GET_DIRECTORY_LISTING' ... dir_name = p_up_fol`
- `ZFI_BANK_STMT_LOAD_F01:44` — `OPEN DATASET upl_file_name FOR INPUT IN TEXT MODE ...`
- `ZFI_BANK_STMT_LOAD_F01:63` — `OPEN DATASET lv_archive_folder FOR OUTPUT IN TEXT MODE ...`
- `ZFI_BANK_STMT_LOAD_F01:74` — `DELETE DATASET upl_file_name.`
- `ZFI_BANK_STMT_LOAD_F01:155` — `SUBMIT rfebka00 WITH SELECTION-TABLE it_rspar AND RETURN.`
- `ZFI_BANK_STMT_TOP:5` — `PARAMETERS : p_up_fol LIKE epsf-epsdirnam.`

**Notes:** Source shows application-server directory listing + dataset read/write/archive (local file I/O on app server). No proven SFTP push/pull, no endpoint/host hints in this object.

---

### 6. `ZSFTP_BNP_PARIBAS_PULL` — **yes**

[SmartAgent: Executing GetProgram...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]
**Verdict:** yes  
**Type:** PROG  
**SFTP methods / mechanisms:**
- SM69 external command via `SXPG_COMMAND_EXECUTE` (command name defaulted to **`ZFTP_BNPP_PULL`**) with assembled parameters including **`FTP_USER`**, **`FTP_PSWD`**, **`FTP_DOMAIN`**, optional **`FTP_PORT`**, **`FOLDER_PATH`**, **`FILE_EXT`**, and **`HOST_KEY`**.

**Evidence (program_or_include:line — snippet):**
- `ZSFTP_BNP_PARIBAS_PULL:19` — `PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_BNPP_PULL' .`
- `ZSFTP_BNP_PARIBAS_PULL:28` — `READ TABLE i_constants ... WITH KEY fnam = 'FTP_USER'.`
- `ZSFTP_BNP_PARIBAS_PULL:46` — `READ TABLE i_constants ... WITH KEY fnam = 'FTP_PSWD'.`
- `ZSFTP_BNP_PARIBAS_PULL:63` — `READ TABLE i_constants ... WITH KEY fnam = 'FTP_DOMAIN'.`
- `ZSFTP_BNP_PARIBAS_PULL:80` — `READ TABLE i_constants ... WITH KEY fnam = 'FTP_PORT'.`
- `ZSFTP_BNP_PARIBAS_PULL:86` — `READ TABLE i_constants ... WITH KEY fnam = 'FOLDER_PATH'.`
- `ZSFTP_BNP_PARIBAS_PULL:100` — `READ TABLE i_constants ... WITH KEY fnam = 'FILE_EXT'.`
- `ZSFTP_BNP_PARIBAS_PULL:114` — `READ TABLE i_constants ... WITH KEY fnam = 'HOST_KEY'.`
- `ZSFTP_BNP_PARIBAS_PULL:150-156` — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' ... commandname = p_comm  additional_parameters = g_path`

**Notes:** pull (implied by report name `..._PULL` and default SM69 command `ZFTP_BNPP_PULL`; description: “SFTP BNP PARIBAS Ack, MT940 pull”). Endpoint/host hint is sourced from constants `FTP_DOMAIN` (and optional `FTP_PORT`); authentication material includes `FTP_USER`/`FTP_PSWD` and `HOST_KEY` (all read from table `ZFI_CONSTANTS` where `pname = 'ZSFTP_BNP_PARIBAS'`).

---

### 7. `ZSFTP_PATIENTCO_PULL` — **yes**

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]
**Verdict:** yes  
**Type:** PROG  
**SFTP methods / mechanisms:**
- SM69 external command via `SXPG_COMMAND_EXECUTE` (command name: `ZSFTP_PATCO_PULL`), with SFTP-style credential/host-key parameter assembly passed in `additional_parameters`

**Evidence (program_or_include:line — snippet):**
- `ZSFTP_PATIENTCO_PULL:22 — PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZSFTP_PATCO_PULL' .`
- `ZSFTP_PATIENTCO_PULL:90 — READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_USER'.`
- `ZSFTP_PATIENTCO_PULL:111 — READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_PSWD'.`
- `ZSFTP_PATIENTCO_PULL:131 — READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_DOMAIN'.`
- `ZSFTP_PATIENTCO_PULL:195 — READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'HOST_KEY'.`
- `ZSFTP_PATIENTCO_PULL:232-236 — CALL FUNCTION 'SXPG_COMMAND_EXECUTE' ... commandname = p_comm ... additional_parameters = g_path`

**Notes:** pull (proven by object name/description + default SM69 command `ZSFTP_PATCO_PULL`; the ABAP itself only constructs parameters and executes the OS command). Endpoint/host hints are limited to constants keys `FTP_DOMAIN` and `HOST_KEY`; no literal host is present in source. Payload appears to be remote file selection by `FOLDER_PATH`, `FILE_EXT`, and optional `p_date`-driven wildcard (`'*' && p_date`).

---

### 8. `ZSFTP_CAPARIO` — **yes**

[SmartAgent: Executing GetProgram...]


[SmartAgent: Executing GetIncludesList...]
**Verdict:** yes  
**Type:** PROG  

**SFTP methods / mechanisms:**
- **SM69 external command via `SXPG_COMMAND_EXECUTE`** (command name **`ZFTP_837`** by default; parameter `p_comm` is user-selectable)

**Evidence (program_or_include:line — snippet):**
- **ZSFTP_CAPARIO:~15** — `PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_837' .`
- **ZSFTP_CAPARIO:~140** — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'`
- **ZSFTP_CAPARIO:~142-144** — `commandname = p_comm` / `additional_parameters = g_path`
- **ZSFTP_CAPARIO:~30-125** — `READ TABLE ... WITH KEY fnam = 'FTP_USER' ... 'FTP_PSWD' ... 'FTP_DOMAIN' ... 'HOST_KEY' ...` and `CONCATENATE g_path ...` (builds the command parameters from SFTP/SSH-related constants)

**Notes:** push/pull, endpoint/host, and payload role are **not proven** in this object’s source (only that it assembles credentials/host-key-related parameters and executes an SM69 command).

---

### 9. `ZFFIU_ACC_POST` — **yes**

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
**Verdict:** yes  
**Type:** PROG  
**SFTP methods / mechanisms:**
- SM69 / OS-shell SFTP via `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` using command **`ZSFTP_CERIDIAN_GET`** (parameters assembled include `FTP_USER`, `PASSPHRASE`, `HOST_KEY`, `FTP_DOMAIN`, `PRIVATE_KEY_PATH`, etc.)

**Evidence (program_or_include:line — snippet):**
- ZFFIU_ACC_POST_SENDFILE_DAF01:~170 — `lv_comm = 'ZSFTP_CERIDIAN_GET'.`
- ZFFIU_ACC_POST_SENDFILE_DAF01:~176-186 — `PERFORM f_set_parameter USING 'FTP_USER' ...` / `'PASSPHRASE'` / `'HOST_KEY'` / `'FTP_DOMAIN'` / `'PRIVATE_KEY_PATH'` / ...
- ZFFIU_ACC_POST_SENDFILE_DAF01:~190-214 — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' EXPORTING commandname = lv_comm additional_parameters = gv_param ...`

**Notes:** pull (GET) from SFTP into SAP/app-server processing flow is implied by command name `..._GET` and comment “Get the files from SFTP”, but the actual transfer currently occurs via the SM69 command call in `f_get_sftp_file_data`; in `process_sftp_files` the call is commented out and the program instead reads from application server directories (`EPS2_GET_DIRECTORY_LISTING`, `OPEN DATASET`).

---

### 10. `ZEDI_835_JPM` — **no**

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
**Verdict:** no  
**Type:** PROG  
**SFTP methods / mechanisms:**
- None found. No `SXPG_COMMAND_EXECUTE`, no SFTP/SSH libraries/classes, and no SM69-driven SFTP command execution in the program+includes read.

**Evidence (program_or_include:line — snippet):**
- ZEDI_835_JPM:1 — `INCLUDE ZEDI_EDI_JPM_TOP.`
- ZEDI_835_JPM:2 — `INCLUDE ZEDI_835_JPM_TOP.`
- ZEDI_835_JPM:8 — `PERFORM read_file_data.`
- ZEDI_835_JPM_F01:~40 — `CALL FUNCTION 'EPS2_GET_DIRECTORY_LISTING'` (directory listing on app server)
- ZEDI_835_JPM_F01:~70 — `OPEN DATASET gv_file FOR INPUT IN TEXT MODE ...` (app-server file read)
- ZEDI_835_JPM_F01:~95 — `CONCATENATE 'E:\usr\sap\' sy-sysid '\DVEBMGS00\data\FTP\JPMorgan\Inbound\Lockbox\Archive_File' ... INTO gv_arc_file.`
- ZEDI_835_JPM_F01:~110 — `CONCATENATE 'E:\usr\sap\' sy-sysid '\DVEBMGS00\data\FTP\JPMorgan\Inbound\Lockbox\Error_File' ... INTO gv_err_file.`
- ZEDI_835_JPM_F01:~145 — `CALL FUNCTION 'GUI_UPLOAD'` (frontend upload when not `p_app`)
- ZEDI_835_JPM_F01:~310 — `CALL 'SYSTEM' ID 'COMMAND' FIELD lv_parcom` with `lv_parcom` built as `MOVE <src> <tgt>` (OS move, not SFTP)

**Notes:**  
- Direction: local file **pull** from app-server directory (`EPS2_GET_DIRECTORY_LISTING` + `OPEN DATASET ... FOR INPUT`) and then local OS **move/archive** (`CALL 'SYSTEM' ... 'MOVE'`) into app-server paths containing `...\data\FTP\JPMorgan\Inbound\Lockbox\...`. The “FTP” in the path looks like a folder naming convention; no source evidence of any network SFTP transfer.

---

### 11. `ZDMS_UPLOAD_FILES` — **yes**

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
**Verdict:** yes  
**Type:** PROG  
**SFTP methods / mechanisms:**
- SM69 external command via `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` using command **`ZSFTP_DMS_GET`** (SFTP pull/get)
- SM69 external command via `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` using command **`ZSFTP_DMS_PUT`** (SFTP push/put of error files)

**Evidence (program_or_include:line — snippet):**
- `ZDMS_UPLOAD_FILES:~26` — `PERFORM f_get_files_from_sftp.`
- `ZDMS_UPLOAD_FILES:~34` — `PERFORM f_send_error_file_to_sftp.`
- `ZDMS_UPLOAD_FILES_F01:~210` — `lv_comm = 'ZSFTP_DMS_GET'.`
- `ZDMS_UPLOAD_FILES_F01:~217-226` — `PERFORM f_set_parameter USING gv_pname_in 'FTP_USER' ...` / `'PASSPHRASE'` / `'HOST_KEY'` / `'FTP_DOMAIN'` / `'PRIVATE_KEY_PATH'` ...
- `ZDMS_UPLOAD_FILES_F01:~230-252` — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' EXPORTING commandname = lv_comm additional_parameters = gv_param ...`
- `ZDMS_UPLOAD_FILES_F01:~276` — `lv_comm = 'ZSFTP_DMS_PUT'.`
- `ZDMS_UPLOAD_FILES_F01:~281-286` — `PERFORM f_set_parameter_out USING gv_pname_out 'FTP_USER' ...` / `'PASSPHRASE'` / `'HOST_KEY'` / `'FTP_DOMAIN'` ...
- `ZDMS_UPLOAD_FILES_F01:~288-312` — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' EXPORTING commandname = lv_comm additional_parameters = gv_param ...`

**Notes:**
- Direction proven by comments + form names + command names:
  - Pull/get from SFTP: `f_get_files_from_sftp` uses SM69 command `ZSFTP_DMS_GET` (comment: “Get files from SFTP” / “get the file from SFTP”).
  - Push/put to SFTP: `f_send_error_file_to_sftp` uses SM69 command `ZSFTP_DMS_PUT` (comment: “send the error files to SFTP”).
- Endpoint/host hints are parameterized from table `ZFI_CONSTANTS` (proven keys: `FTP_DOMAIN`, `HOST_KEY`, `PRIVATE_KEY_PATH`, `PASSPHRASE`, `FTP_USER`) assembled into `gv_param` and passed as `additional_parameters` to `SXPG_COMMAND_EXECUTE` (no literal host visible in this object’s source).

---

### 12. `ZSD_MEDICARE_PDF_PROCESS` — **yes**

[SmartAgent: Executing GetProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
**Verdict:** yes  
**Type:** PROG  
**SFTP methods / mechanisms:**
- Function module `ZMEDI_GET_FROM_SFTP` (invoked with SM69 command name `ZSFTP_MEDICARE_GET`)
- Function module `ZMEDI_PUT_FROM_SFTP` (invoked with SM69 command name `ZSFTP_MEDICARE_PUT`)

**Evidence (program_or_include:line — snippet):**
- ZSD_MEDICARE_PDF_PROCESS (main):~29 — `PERFORM f_get_files_from_sftp.`
- ZSD_MEDICARE_PDF_PROCESS (main):~41 — `PERFORM f_send_error_file_to_sftp.`
- ZSD_MEDICARE_PDF_PROCESS_F01:~430 — `FORM f_get_files_from_sftp .`
- ZSD_MEDICARE_PDF_PROCESS_F01:~438-441 — `CALL FUNCTION 'ZMEDI_GET_FROM_SFTP' EXPORTING command = 'ZSFTP_MEDICARE_GET' constants = 'ZSFTP_MEDICARE_IN'.`
- ZSD_MEDICARE_PDF_PROCESS_F01:~455 — `FORM f_send_error_file_to_sftp .`
- ZSD_MEDICARE_PDF_PROCESS_F01:~457-460 — `CALL FUNCTION 'ZMEDI_PUT_FROM_SFTP' EXPORTING command = 'ZSFTP_MEDICARE_PUT' constants = 'ZSFTP_MEDICARE_OUT'.`

**Notes:** push/pull is implied by naming only (GET vs PUT), but the actual transfer mechanism (e.g., `SXPG_COMMAND_EXECUTE`, SSH key params, host/user) is not shown in this object’s source; it delegates to `ZMEDI_*` FMs with SM69 command identifiers and constants groups (`ZSFTP_MEDICARE_IN` / `OUT`).

---

### 13. `ZSFTP_CITI_PULL` — **yes**

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]
**Verdict:** yes  
**Type:** PROG  
**SFTP methods / mechanisms:**
- SM69 external command execution via `SXPG_COMMAND_EXECUTE` (command name = parameter `P_COMM`, default `ZSFTP_CITI_PULL`)

**Evidence (program_or_include:line — snippet):**
- `ZSFTP_CITI_PULL:16` — `PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZSFTP_CITI_PULL'.`
- `ZSFTP_CITI_PULL:37-41` — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' EXPORTING commandname = p_comm additional_parameters = g_path ...`
- `ZSFTP_CITI_PULL:23-28` — `PERFORM f_set_parameter USING 'PASSPHRASE' ...` / `'FTP_USER'` / `'FTP_DOMAIN'` / `'HOST_KEY'` / `'PRIVATE_KEY_PATH'`
- `ZSFTP_CITI_PULL:74-78` — `CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY p_sep.` (builds `additional_parameters` passed to the command)

**Notes:** pull. Program description explicitly says **“Pull MT940 into AL11 from citi”** (program metadata). Host/user/key/passphrase values are sourced from table `ZFI_CONSTANTS` where `PNAME = 'ZSFTP_CITI'`, then concatenated into `g_path` and passed as `additional_parameters` to the SM69 command.

---
