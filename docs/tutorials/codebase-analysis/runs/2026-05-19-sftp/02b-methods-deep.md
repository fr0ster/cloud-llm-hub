# 02b-methods-deep — Exhaustive SFTP-method enumeration (run 2026-05-19)

> Open-ended enumeration on the 8 Stage-2 'yes' seeds. Prompt deliberately avoids mentioning SXPG to surface any non-SXPG mechanisms.

## Per-seed method summary

| # | Seed | Mechanisms (Summary line from agent) | Tools fired |
|---|------|--------------------------------------|-------------|
| 1 | `ZSFTP_CAPARIO_PULL` | `SXPG[SXPG_COMMAND_EXECUTE commandname=p_comm default=ZFTP_EOB_PULL]` | ReadProgram, GetIncludesList |
| 2 | `ZSFTP_BNP_PARIBAS_PULL` | SXPG[`ZFTP_BNPP_PULL`] | GetProgram, GetIncludesList |
| 3 | `ZSFTP_PATIENTCO_PULL` | SXPG[ZSFTP_PATCO_PULL] | ReadProgram, GetIncludesList |
| 4 | `ZSFTP_CAPARIO` | `SXPG_COMMAND_EXECUTE[p_comm default ZFTP_837]` | GetProgram, GetIncludesList |
| 5 | `ZFFIU_ACC_POST` | `SXPG[ZSFTP_CERIDIAN_GET]` | ReadProgram, GetIncludesList, GetInclude×3 |
| 6 | `ZDMS_UPLOAD_FILES` | SXPG[ZSFTP_DMS_GET], SXPG[ZSFTP_DMS_PUT] | ReadProgram, GetIncludesList, GetInclude×2 |
| 7 | `ZSD_MEDICARE_PDF_PROCESS` | ZMEDI_GET_FROM_SFTP, ZMEDI_PUT_FROM_SFTP | ReadProgram, GetIncludesList, GetInclude×2 |
| 8 | `ZSFTP_CITI_PULL` | `SXPG[SXPG_COMMAND_EXECUTE commandname=ZSFTP_CITI_PULL]` | ReadProgram, GetIncludesList |

## Distinct mechanism artifacts found

These are the SM69 commands, function modules, and other artifacts that move data over SFTP. **Stage 3 will SearchSource for each of these names across Z* to find every caller.**

- `ZFTP_837` — found in: ZSFTP_CAPARIO
- `ZFTP_BNPP_PULL` — found in: ZSFTP_BNP_PARIBAS_PULL
- `ZFTP_EOB_PULL` — found in: ZSFTP_CAPARIO_PULL
- `ZMEDI_GET_FROM_SFTP` — found in: ZSD_MEDICARE_PDF_PROCESS
- `ZMEDI_PUT_FROM_SFTP` — found in: ZSD_MEDICARE_PDF_PROCESS
- `ZSFTP_CERIDIAN_GET` — found in: ZFFIU_ACC_POST
- `ZSFTP_CITI_PULL` — found in: ZSFTP_CITI_PULL
- `ZSFTP_DMS_GET` — found in: ZDMS_UPLOAD_FILES
- `ZSFTP_DMS_PUT` — found in: ZDMS_UPLOAD_FILES
- `ZSFTP_PATCO_PULL` — found in: ZSFTP_PATIENTCO_PULL

## Token usage (cloud-llm-hub side, Stage 2b)

| Model | prompt | completion | total | requests |
|---|---|---|---|---|
| `gpt-5.2` | 204,701 | 13,523 | 218,224 | 36 |
| `embedder` | 3,670 | 0 | 3,670 | 8 |
| **GRAND** |  |  | **221,894** |  |

## Full per-seed analyses

### 1. `ZSFTP_CAPARIO_PULL`

_Summary: `SXPG[SXPG_COMMAND_EXECUTE commandname=p_comm default=ZFTP_EOB_PULL]`_

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]
After reading **(1)** the main report `ZSFTP_CAPARIO_PULL` source and **(2)** running `GetIncludesList` recursively, there are **no includes** to read for this program.

Blind spots: **none** (no include artifacts returned by `GetIncludesList`).

---

### SXPG_COMMAND_EXECUTE
- **kind:** shell-out (SM69 external command execution via SAP standard FM)
- **direction:** unknown *(the ABAP passes credentials/host/path to an external command; whether it pulls or pushes depends on the SM69 command/script implementation, which is not present in ABAP source)*
- **artifact:** SM69 command name = parameter `p_comm` (default **`ZFTP_EOB_PULL`**)
- **call sites:** `ZSFTP_CAPARIO_PULL:~116` — snippet
  ```abap
  CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
    EXPORTING
      commandname           = p_comm
      additional_parameters = g_path
    IMPORTING
      exitcode              = g_ret_code
    TABLES
      exec_protocol         = i_return[].
  ```
- **credentials/host source:** from table `ZFI_CONSTANTS`, filtered by `pname = 'ZSFTP_835_PULL'`, then specific keys concatenated into `g_path`:
  - `FTP_USER` → `g_path = wa_constants-fval` (user)
    ```abap
    SELECT * FROM zfi_constants INTO TABLE i_constants
                                WHERE pname = 'ZSFTP_835_PULL'.
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_USER'.
    g_path = wa_constants-fval.
    ```
  - `FTP_PSWD` → concatenated as `user:password`
    ```abap
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_PSWD'.
    CONCATENATE g_path ':' wa_constants-fval INTO g_path.
    ```
  - `FTP_DOMAIN` → concatenated as `user:password@domain`
    ```abap
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_DOMAIN'.
    CONCATENATE g_path '@' wa_constants-fval INTO g_path.
    ```
  - `FOLDER_PATH` → appended as a separate parameter (space-separated)
    ```abap
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FOLDER_PATH'.
    CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY space.
    ```
  - `FILE_EXT` (+ optional `p_date` wildcard) → appended
    ```abap
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FILE_EXT'.
    IF p_date IS NOT INITIAL.
      CONCATENATE '*' p_date INTO l_date.
      CONCATENATE g_path l_date INTO g_path SEPARATED BY space.
      CONCATENATE g_path wa_constants-fval INTO g_path.
    ELSE.
      CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY space.
    ENDIF.
    ```
  - `HOST_KEY` → appended (space-separated)
    ```abap
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'HOST_KEY'.
    CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY space.
    ```
  Net effect: the ABAP builds a single `additional_parameters` string that contains **user, password, domain/host, remote folder path, filename pattern/ext (optionally date-filtered), and host key**, and passes it to the external command.
- **payload role:** unknown from ABAP source. The program description says “Capario Pull SFTP” and the default command is `ZFTP_EOB_PULL`, but the ABAP source does not prove which business file(s) move—only that a file pattern is constructed using `FILE_EXT` and optional `p_date`.

---

## Mechanisms explicitly *not* present in the ABAP source (after reading all artifacts)
No evidence in `ZSFTP_CAPARIO_PULL` of:
- `CALL 'SYSTEM' ID 'COMMAND' ...`
- Any `FTP_*` / `SFTP_*` function module calls (standard or custom)
- Any ABAP class-based SSH/SFTP/FTP client usage (`CL_*SSH*`, `CL_*SFTP*`, `CL_*FTP*`, etc.)
- `CL_GUI_FRONTEND_SERVICES` usage
- `OPEN DATASET` usage
- Background job submission to run scripts (e.g., `JOB_OPEN` / `JOB_SUBMIT` / `SUBMIT ... VIA JOB`)
- HTTP/REST/SOAP calls (e.g., `CL_HTTP_CLIENT`, `CALL TRANSFORMATION`, proxy calls)

(These are absent from the only source artifact: the main report; `GetIncludesList` returned none.)

---

**Summary:** `SXPG[SXPG_COMMAND_EXECUTE commandname=p_comm default=ZFTP_EOB_PULL]`

---

### 2. `ZSFTP_BNP_PARIBAS_PULL`

_Summary: SXPG[`ZFTP_BNPP_PULL`]_

[SmartAgent: Executing GetProgram...]


[SmartAgent: Executing GetIncludesList...]
### SXPG_COMMAND_EXECUTE
- **kind:** shell-out (SM69 external command execution)
- **direction:** pull *(inferred only from report name `..._PULL` / default command `ZFTP_BNPP_PULL`; source does not prove transfer direction)* → **unknown from source**
- **artifact:** SM69 command name = `p_comm` (default `'ZFTP_BNPP_PULL'`)
- **call sites:** `ZSFTP_BNP_PARIBAS_PULL` (main program; no includes exist)
  - `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' EXPORTING commandname = p_comm additional_parameters = g_path ...`
- **credentials/host source:** built from table `ZFI_CONSTANTS` (rows where `pname = 'ZSFTP_BNP_PARIBAS'`) into `g_path`:
  - `FTP_USER` → `g_path = wa_constants-fval`
  - `FTP_PSWD` → `CONCATENATE g_path ':' wa_constants-fval INTO g_path`
  - `FTP_DOMAIN` → `CONCATENATE g_path '@' wa_constants-fval INTO g_path`
  - `FTP_PORT` (optional) → `CONCATENATE g_path ':' wa_constants-fval INTO g_path`
  - Then appended (space-separated) to the parameter string:
    - `FOLDER_PATH`
    - `FILE_EXT`
    - `HOST_KEY`
  - **Source citations (main program):**
    - `SELECT * FROM zfi_constants ... WHERE pname = 'ZSFTP_BNP_PARIBAS'.`
    - `READ TABLE ... fnam = 'FTP_USER'/'FTP_PSWD'/'FTP_DOMAIN'/'FTP_PORT'/'FOLDER_PATH'/'FILE_EXT'/'HOST_KEY'`
    - `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' ... additional_parameters = g_path`
- **payload role:** **unknown** (no file name(s) or business object(s) are handled in ABAP; the external command likely performs the SFTP work, but the report source does not show what is transferred)

### Blind spots / not found
- **Includes:** none. `GetIncludesList` returned: *“No includes found in PROG/P 'ZSFTP_BNP_PARIBAS_PULL'.”*
- **Not present in source (no call sites found):**
  - `CALL 'SYSTEM' ID 'COMMAND' ...`
  - Any `FTP_*` / `SFTP_*` function modules
  - Any ABAP SFTP/SSH/FTP client classes (`CL_*SSH*`, `CL_*SFTP*`, `CL_*FTP*`, etc.)
  - `CL_GUI_FRONTEND_SERVICES`-based transfer chains
  - `OPEN DATASET` network-path based transfer logic
  - Background job submissions to run external scripts (beyond the direct SXPG execution)
  - HTTP/REST/SOAP calls to an SFTP gateway

**Summary:** SXPG[`ZFTP_BNPP_PULL`]

---

### 3. `ZSFTP_PATIENTCO_PULL`

_Summary: SXPG[ZSFTP_PATCO_PULL]_

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]
After executing the required procedure (read main program, then recursively list includes, then read each include), **the report uses exactly one SFTP-touching mechanism** in its ABAP source.

There are **no includes** for `ZSFTP_PATIENTCO_PULL` (per `GetIncludesList`), so there are no additional artifacts to inspect.

---

### SXPG_COMMAND_EXECUTE (SM69 external command)
- **kind:** shell-out (external OS command via SM69 / external commands)
- **direction:** pull (from source intent + parameter naming; ABAP itself only executes a command and prints its protocol)
- **artifact:** SM69 command name passed in parameter `p_comm` (default **`ZSFTP_PATCO_PULL`**)
- **call sites:** `ZSFTP_PATIENTCO_PULL` (end-of-selection; exact line numbers not available from tool output)
  - Snippet:
    ```abap
    PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZSFTP_PATCO_PULL' .

    ...

    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = p_comm
        additional_parameters = g_path
      IMPORTING
        exitcode              = g_ret_code
      TABLES
        exec_protocol         = i_return[]
      EXCEPTIONS ...
    ```
- **credentials/host source:** built entirely from table `ZFI_CONSTANTS` (selected by `pname = 'ZSFTP_835_PATIENTCO'`) and concatenated into `g_path` which is passed to the external command as `additional_parameters`.
  - Snippets proving each element:
    - User:
      ```abap
      READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_USER'.
      ...
      g_path = wa_constants-fval.
      ```
    - Password (concatenated with `:`):
      ```abap
      READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_PSWD'.
      ...
      CONCATENATE g_path ':' wa_constants-fval INTO g_path.
      ```
    - Host / domain (concatenated with `@`):
      ```abap
      READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_DOMAIN'.
      ...
      CONCATENATE g_path '@' wa_constants-fval INTO g_path.
      ```
    - Remote folder/path (appended separated by space):
      ```abap
      READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FOLDER_PATH'.
      ...
      CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.
      ```
    - File extension / file pattern (appended; may include `*<p_date>` prefix):
      ```abap
      READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FILE_EXT'.
      ...
      IF p_date IS NOT INITIAL.
        CONCATENATE '*' p_date INTO l_date.
        ...
        CONCATENATE g_path  l_date INTO g_path SEPARATED BY space.
        CONCATENATE g_path wa_constants-fval INTO g_path.
      ELSE.
        CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.
      ENDIF.
      ```
    - Host key (appended separated by space):
      ```abap
      READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'HOST_KEY'.
      ...
      CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.
      ```
- **payload role:** **unknown from ABAP source alone.** The ABAP report does not itself read/write files over SFTP; it delegates to an external command and only prints `exec_protocol` messages. The report description says “Patientco Pull SFTP”, but the actual transferred business artifact is not proven in ABAP beyond the presence of file pattern inputs (`FOLDER_PATH`, `FILE_EXT`, optional `p_date`).

---

## Mechanisms explicitly NOT found in the inspected source
Cited by absence in the only artifact (main report) and the fact that `GetIncludesList` returned none:

- No `CALL 'SYSTEM' ID 'COMMAND' ...`
- No `FTP_*` / `SFTP_*` function modules called
- No ABAP SSH/SFTP/FTP client classes instantiated/called
- No HTTP/REST/SOAP calls
- No background job submission logic that invokes scripts (beyond the direct SXPG call)
- No `OPEN DATASET` usage in this report (and in any includes—none exist)

---

## Blind spots
- **None from includes**: `GetIncludesList` returned: *“No includes found in PROG/P 'ZSFTP_PATIENTCO_PULL'.”*
- **External command implementation is outside ABAP source**: the actual SFTP implementation is presumably inside the SM69 command **`ZSFTP_PATCO_PULL`** at OS/script level, but that is not readable via the provided ABAP-source tools.

---

**Summary:** SXPG[ZSFTP_PATCO_PULL]

---

### 4. `ZSFTP_CAPARIO`

_Summary: `SXPG_COMMAND_EXECUTE[p_comm default ZFTP_837]`_

[SmartAgent: Executing GetProgram...]


[SmartAgent: Executing GetIncludesList...]
### SXPG_COMMAND_EXECUTE
- **kind:** FM (shell-out via SM69)
- **direction:** unknown (from ABAP source only; depends on the external command behind `p_comm`)
- **artifact:** `SXPG_COMMAND_EXECUTE` with SM69 command name = `p_comm` (default `'ZFTP_837'`)
- **call sites:**
  - `ZSFTP_CAPARIO:<line unknown>` — snippet:
    ```abap
    PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_837' .
    ...
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = p_comm
        additional_parameters = g_path
      IMPORTING
        exitcode              = g_ret_code
      TABLES
        exec_protocol         = i_return[]
    ```
- **credentials/host source:** built from table `ZFI_CONSTANTS` rows where `pname = 'EDI837_OUTBOUND'` and `fnam` keys:
  - `FTP_USER` → starts `g_path`
    ```abap
    READ TABLE i_constants ... WITH KEY fnam = 'FTP_USER'.
    g_path = wa_constants-fval.
    ```
  - `FTP_PSWD` → concatenated as `user:password`
    ```abap
    READ TABLE i_constants ... WITH KEY fnam = 'FTP_PSWD'.
    CONCATENATE g_path ':' wa_constants-fval INTO g_path.
    ```
  - `FTP_DOMAIN` → concatenated as `user:password@domain`
    ```abap
    READ TABLE i_constants ... WITH KEY fnam = 'FTP_DOMAIN'.
    CONCATENATE g_path '@' wa_constants-fval INTO g_path.
    ```
  - Then appended (space-separated) as additional parameters:
    - `FOLDER_PATH`
    - `FILE_EXT`
    - `HOST_KEY`
    - `DESTINATION_FOLDER`
    Example pattern:
    ```abap
    READ TABLE i_constants ... WITH KEY fnam = 'FOLDER_PATH'.
    CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY space.
    ```
  **Net effect (proven by concatenations):** the report passes a single argument string to the external command that contains `user:password@domain` plus several other tokens (folder path, file extension, host key, destination folder).
- **payload role:** unknown (the report does not name a specific file being transferred; it passes folder/path/ext parameters to the external command, but the actual transferred artifact is determined by that command, not shown in ABAP source).

---

## Mechanisms explicitly *not* found in the ABAP source read
(“Not found” means: no such call/text exists in the main program source that was retrieved, and there are no includes to inspect.)
- `CALL 'SYSTEM' ID 'COMMAND' ...` — **not found**
- Any `FTP_*` / `SFTP_*` function module calls — **not found**
- Any ABAP SSH/SFTP/FTP client classes (e.g. `CL_*SSH*`, `CL_*SFTP*`, `CL_*FTP*`) — **not found**
- `CL_GUI_FRONTEND_SERVICES` usage — **not found**
- `OPEN DATASET` — **not found**
- Background job submission (`JOB_*`, `SUBMIT ... VIA JOB`) — **not found**
- HTTP/REST/SOAP calls (e.g. `CL_HTTP_CLIENT=>...`, `CALL TRANSFORMATION`, proxy calls) — **not found**

---

## Include coverage / blind spots
- `GetIncludesList('ZSFTP_CAPARIO')` returned: **No includes found**.  
  Therefore there are **no include artifacts to read** and **no include blind spots**.

---

**Summary:** `SXPG_COMMAND_EXECUTE[p_comm default ZFTP_837]`

---

### 5. `ZFFIU_ACC_POST`

_Summary: `SXPG[ZSFTP_CERIDIAN_GET]`_

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
After reading the **main program** `ZFFIU_ACC_POST` plus **all recursive includes** returned by `GetIncludesList` (`ZFFIU_ACC_POST_TOP`, `ZFFIU_ACC_POST_FILE_SELECTF01`, `ZFFIU_ACC_POST_SENDFILE_DAF01`), there is **exactly one concrete SFTP-touching mechanism implemented in source**: an **SM69 shell command execution via `SXPG_COMMAND_EXECUTE`**. Everything else that resembles “SFTP” is either **commentary**, **local/app-server file I/O**, or **GUI upload/download**, which (per your rules) is **not SFTP** unless paired with host/credentials/external step.

No `GetInclude()` blind spots occurred (all includes returned source).

---

### SXPG_COMMAND_EXECUTE
- **kind:** shell-out (SM69 external command)
- **direction:** pull (from source only)
- **artifact:** SM69 command name `ZSFTP_CERIDIAN_GET`
- **call sites:**
  - `ZFFIU_ACC_POST_SENDFILE_DAF01:~170` — snippet:
    ```abap
    lv_comm = 'ZSFTP_CERIDIAN_GET'.
    ...
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = lv_comm
        additional_parameters = gv_param
    ```
    (inside `FORM f_get_sftp_file_data`)

- **credentials/host source:** from table `ZFI_CONSTANTS` rows for `PNAME = 'ZSFTP_CERIDIAN'`, assembled into `gv_param` by `FORM f_set_parameter`
  - `ZFFIU_ACC_POST_SENDFILE_DAF01:~160`:
    ```abap
    SELECT * FROM zfi_constants INTO TABLE gt_constants
                                WHERE pname = 'ZSFTP_CERIDIAN'.
    ```
  - Parameters required/used (all read from `ZFI_CONSTANTS-FVAL` by `READ TABLE gt_constants ... WITH KEY fnam = p_key` in `f_set_parameter`):
    - `FTP_USER`
    - `PASSPHRASE`
    - `HOST_KEY`
    - `FTP_DOMAIN`
    - `PRIVATE_KEY_PATH`
    - `SFTP_FILE_EXT`
    - `SOURCE_PATH`
    - `SOURCE_FOLDER`
    - `ECS_FILE_EXT`
    - `ZDEST_FOLD`
    Call-site evidence (same include, `FORM f_get_sftp_file_data`):
    ```abap
    PERFORM f_set_parameter USING 'FTP_USER'          'M' ''.
    PERFORM f_set_parameter USING 'PASSPHRASE'        'M' ':'.
    PERFORM f_set_parameter USING 'HOST_KEY'          'M' ';'.
    PERFORM f_set_parameter USING 'FTP_DOMAIN'        'M' ';'.
    PERFORM f_set_parameter USING 'PRIVATE_KEY_PATH'  'M' ';'.
    ...
    ```
  - How they are passed: concatenated into `gv_param` with separators (`:` / `;` / none), then passed as `additional_parameters` to the SM69 command:
    ```abap
    additional_parameters = gv_param
    ```

- **payload role:** **unknown** from source alone  
  The code indicates Ceridian payroll inbound processing and references “file from SFTP to SAP” in notification text, but the actual moved artifact (exact filename(s), remote path, local landing path) is not proven beyond the parameter keys and later app-server directory processing. Evidence of the “SFTP to SAP” statement is in email text:
  ```abap
  lv_text = 'An error has occurred while reading/transferring file &1 from SFTP To SAP'.
  ```

**Important nuance (source-proven):** the report’s *runtime path* that processes “SFTP files” (`FORM process_sftp_files`) currently does **not** invoke the SFTP pull form—the call is commented out:
```abap
* Get the files from SFTP
*  PERFORM f_get_sftp_file_data.
* Get files from Application server
  PERFORM f_get_files_app_server.
```
So the SFTP mechanism exists in code, but in the shown execution flow it is not executed unless that PERFORM is re-enabled or called elsewhere.

---

## Excluded as “not SFTP” per your rules (but relevant candidates observed)

### OPEN DATASET (application server file I/O; network-mounted path possible but not proven as SFTP)
- **kind:** other (app server filesystem I/O)
- **direction:** both (read + write local/app-server files)
- **artifact:** `OPEN DATASET ...` paths built from `ZFI_CONSTANTS` keys like `SOURCE_PATH`, `SOURCE_FOLDER`, `SOURCE_FOLDER_ARCHIVE`, `SOURCE_FOLDER_ERROR`
- **call sites (examples):**
  - Read inbound file content:
    ```abap
    OPEN DATASET lv_dir_in FOR INPUT IN TEXT MODE ...
    READ DATASET lv_dir_in INTO lv_string.
    ```
    (`FORM f_get_files_data`)
  - Move file to archive/error folder:
    ```abap
    OPEN DATASET lv_dir_in FOR INPUT IN BINARY MODE ...
    OPEN DATASET lv_path  FOR OUTPUT IN BINARY MODE ...
    TRANSFER lv_string TO lv_path.
    DELETE DATASET lv_dir_in.
    ```
    (`FORM f_send_process_file`)
- **Why excluded:** no host/credentials/external transfer step tied to SFTP in these call sites; they operate on app-server directories only.

### CL_GUI_FRONTEND_SERVICES upload/download (local PC; not SFTP)
- `cl_gui_frontend_services=>gui_upload` in `FORM getfile_data`
- `cl_gui_frontend_services=>gui_download` in `FORM sendfile_data`
- **Why excluded:** purely frontend file transfer; no SFTP host/credentials/external step.

---

## Not found (explicitly checked across main + includes)
- `CALL 'SYSTEM' ID 'COMMAND' ...` — **not found**
- Any `FTP_*` / `SFTP_*` function modules — **not found**
- ABAP SSH/SFTP/FTP client classes (`CL_*SSH*`, `CL_*SFTP*`, `CL_*FTP*`) — **not found**
- HTTP/REST/SOAP calls to an SFTP gateway — **not found**
- Background job submission invoking scripts (e.g., `JOB_OPEN`, `JOB_SUBMIT`, `SUBMIT ... VIA JOB`) — **not found** in the read artifacts

---

**Summary:** `SXPG[ZSFTP_CERIDIAN_GET]`

---

### 6. `ZDMS_UPLOAD_FILES`

_Summary: SXPG[ZSFTP_DMS_GET], SXPG[ZSFTP_DMS_PUT]_

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
After reading **main program `ZDMS_UPLOAD_FILES`** plus **all recursive includes** (`ZDMS_UPLOAD_FILES_TOP`, `ZDMS_UPLOAD_FILES_F01`), the report uses the following SFTP-touching mechanisms.

---

### SXPG_COMMAND_EXECUTE (SM69 external command) — **GET**
- **kind:** shell-out
- **direction:** pull
- **artifact:** SM69 command name `ZSFTP_DMS_GET`
- **call sites:**
  - `ZDMS_UPLOAD_FILES_F01:~260` — snippet:
    ```abap
    lv_comm = 'ZSFTP_DMS_GET'.
    ...
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = lv_comm
        additional_parameters = gv_param
    ```
- **credentials/host source:** built from table `ZFI_CONSTANTS` into `gv_param` via `PERFORM f_set_parameter`:
  - `ZDMS_UPLOAD_FILES_F01:~236-247`:
    ```abap
    PERFORM f_set_parameter USING gv_pname_in 'FTP_USER'         'M' ''.
    PERFORM f_set_parameter USING gv_pname_in 'PASSPHRASE'       'M' ':'.
    PERFORM f_set_parameter USING gv_pname_in 'HOST_KEY'         'M' ';'.
    PERFORM f_set_parameter USING gv_pname_in 'FTP_DOMAIN'       'M' ';'.
    PERFORM f_set_parameter USING gv_pname_in 'PRIVATE_KEY_PATH' 'M' ';'.
    ...
    PERFORM f_set_parameter USING gv_pname_in 'SOURCE_PATH'      'M' ';'.
    PERFORM f_set_parameter USING gv_pname_in 'SOURCE_FOLDER'    'M' ''.
    ```
  - `ZDMS_UPLOAD_FILES_F01:~430-470` (`FORM f_set_parameter`) shows it reads `gt_constants` (loaded from DB table `ZFI_CONSTANTS`) by `(pname,fnam)` and concatenates values into `gv_param`.
  - `ZDMS_UPLOAD_FILES_F01:~330-360` (`FORM f_get_zfi_constants`) shows which `pname` keys are loaded depending on radio button:
    ```abap
    SELECT * FROM zfi_constants INTO TABLE gt_constants
      WHERE pname IN ('ZSFTP_DMS_US_IN', 'ZSFTP_DMS_US_OUT').
    gv_pname_in  = 'ZSFTP_DMS_US_IN'.
    ...
    ```
    or
    ```abap
    WHERE pname IN ('ZSFTP_DMS_EMEA_IN', 'ZSFTP_DMS_EMEA_OUT').
    gv_pname_in  = 'ZSFTP_DMS_EMEA_IN'.
    ```
- **payload role:** inbound files for DMS upload (source proves “Get files from SFTP” and subsequent local directory listing/processing; exact file types hinted by constants `SFTP_FILE_EXT`, `ECS_FILE_EXT`, but business payload specifics beyond “files for DMS upload” are not explicitly defined in code).

---

### SXPG_COMMAND_EXECUTE (SM69 external command) — **PUT**
- **kind:** shell-out
- **direction:** push
- **artifact:** SM69 command name `ZSFTP_DMS_PUT`
- **call sites:**
  - `ZDMS_UPLOAD_FILES_F01:~290` — snippet:
    ```abap
    lv_comm = 'ZSFTP_DMS_PUT'.
    ...
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = lv_comm
        additional_parameters = gv_param
    ```
- **credentials/host source:** built from `ZFI_CONSTANTS` into `gv_param` via `PERFORM f_set_parameter_out`:
  - `ZDMS_UPLOAD_FILES_F01:~276-286`:
    ```abap
    PERFORM f_set_parameter_out USING gv_pname_out 'FTP_USER'      'M' ''  CHANGING lv_value.
    PERFORM f_set_parameter_out USING gv_pname_out 'PASSPHRASE'    'M' ':' CHANGING lv_value.
    PERFORM f_set_parameter_out USING gv_pname_out 'HOST_KEY'      'M' ';' CHANGING lv_value.
    PERFORM f_set_parameter_out USING gv_pname_out 'FTP_DOMAIN'    'M' ';' CHANGING lv_value.
    PERFORM f_set_parameter_out USING gv_pname_out 'SOURCE_FOLDER' 'M' ';' CHANGING lv_value.
    PERFORM f_set_parameter_out USING gv_pname_out 'ZDEST_FOLD'    'M' ';' CHANGING lv_value.
    ```
  - `ZDMS_UPLOAD_FILES_F01:~480-515` (`FORM f_set_parameter_out`) confirms it reads `gt_constants` (from `ZFI_CONSTANTS`) and concatenates into `gv_param`.
  - `gv_pname_out` is set in `FORM f_get_zfi_constants` to either `ZSFTP_DMS_US_OUT` or `ZSFTP_DMS_EMEA_OUT`.
- **payload role:** “error files” moved to an error directory and then sent out (source proves this flow):
  - Main program: `PERFORM f_send_error_file_to_sftp.`
  - `ZDMS_UPLOAD_FILES_F01:~520+` (`FORM f_check_files`) moves files to error dir then calls `f_send_error_file_to_sftp`:
    ```abap
    PERFORM f_move_file_error_path USING lv_dir_in lv_error_path lw_files-name.
    ...
    PERFORM f_send_error_file_to_sftp.
    ```

---

## Candidate mechanisms checked and NOT found in the read artifacts (no call sites)
- `CALL 'SYSTEM' ID 'COMMAND' ...` — **not present** in main/include sources read.
- Any `FTP_*` / `SFTP_*` function modules — **not present** (other than `SXPG_COMMAND_EXECUTE` and non-SFTP FMs like `EPS2_GET_DIRECTORY_LISTING`).
- ABAP class-based SSH/SFTP clients (`CL_*SSH*`, `CL_*SFTP*`, `CL_*FTP*`) — **not present**.
- `CL_GUI_FRONTEND_SERVICES` — **not present**.
- Background job submission to run scripts — **not present**.
- HTTP/REST/SOAP to an SFTP gateway — **not present**.

---

## Local filesystem mechanisms that are SFTP-adjacent (not SFTP by themselves)
These are **not counted as SFTP mechanisms** per your rules, but they are part of the end-to-end flow around the SFTP shell-outs:

- **Application server directory listing** via `EPS2_GET_DIRECTORY_LISTING`
  - `ZDMS_UPLOAD_FILES_F01:~30` and `~550`:
    ```abap
    CALL FUNCTION 'EPS2_GET_DIRECTORY_LISTING'
      EXPORTING iv_dir_name = lv_dir_in
    ```
- **Application server file move/copy/delete** via `OPEN DATASET` / `READ DATASET` / `TRANSFER` / `DELETE DATASET`
  - `ZDMS_UPLOAD_FILES_F01:~370-420` (`FORM f_move_file_error_path`) shows binary read/write and delete.
  - `ZDMS_UPLOAD_FILES_F01:~410+` (`FORM f_delete_file`) deletes processed files.

These indicate the SXPG commands likely deposit/pick up files in these server directories, but the SFTP itself is only evidenced via `SXPG_COMMAND_EXECUTE`.

---

## Blind spots
None. `GetInclude` succeeded for all includes returned by `GetIncludesList` (`ZDMS_UPLOAD_FILES_F01`, `ZDMS_UPLOAD_FILES_TOP`).

---

**Summary:** SXPG[ZSFTP_DMS_GET], SXPG[ZSFTP_DMS_PUT]

---

### 7. `ZSD_MEDICARE_PDF_PROCESS`

_Summary: ZMEDI_GET_FROM_SFTP, ZMEDI_PUT_FROM_SFTP_

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
### ZMEDI_GET_FROM_SFTP (Medicare inbound SFTP wrapper)
- **kind:** FM
- **direction:** pull
- **artifact:** `ZMEDI_GET_FROM_SFTP`
- **call sites:** `ZSD_MEDICARE_PDF_PROCESS_F01:~(in FORM f_get_files_from_sftp)` — snippet  
  ```abap
  FORM f_get_files_from_sftp .
    CALL FUNCTION 'ZMEDI_GET_FROM_SFTP'
      EXPORTING
        command   = 'ZSFTP_MEDICARE_GET'
        constants = 'ZSFTP_MEDICARE_IN'.
  ENDFORM.
  ```
  (Source: include `ZSD_MEDICARE_PDF_PROCESS_F01`, FORM `f_get_files_from_sftp`)
- **credentials/host source:** `zfi_constants` rows (indirect)  
  Evidence: the FM is passed `constants = 'ZSFTP_MEDICARE_IN'`, and this program reads `zfi_constants` for that constants group for paths/folders:  
  ```abap
  SELECT SINGLE fval FROM zfi_constants INTO gv_path
    WHERE pname = 'ZSFTP_MEDICARE_IN' AND fnam = 'SOURCE_PATH'.
  ```
  (Source: include `ZSD_MEDICARE_PDF_PROCESS_F01`, FORM `f_get_files_app_server`)
- **payload role:** business artifact (inbound Medicare PDF/CSV files)  
  Evidence that the inbound directory contains `.csv` and `.pdf` processed by this report:  
  ```abap
  IF ls_files-name CS '.csv'. ... ELSEIF ls_files-name CS '.pdf'.
  ```
  (Source: include `ZSD_MEDICARE_PDF_PROCESS_F01`, FORM `f_get_files_app_server`)

---

### ZMEDI_PUT_FROM_SFTP (Medicare outbound SFTP wrapper)
- **kind:** FM
- **direction:** push
- **artifact:** `ZMEDI_PUT_FROM_SFTP`
- **call sites:** `ZSD_MEDICARE_PDF_PROCESS_F01:~(in FORM f_send_error_file_to_sftp)` — snippet  
  ```abap
  FORM f_send_error_file_to_sftp .
    CALL FUNCTION 'ZMEDI_PUT_FROM_SFTP'
      EXPORTING
        command   = 'ZSFTP_MEDICARE_PUT'
        constants = 'ZSFTP_MEDICARE_OUT'.
  ENDFORM.
  ```
  (Source: include `ZSD_MEDICARE_PDF_PROCESS_F01`, FORM `f_send_error_file_to_sftp`)
- **credentials/host source:** `zfi_constants` rows (indirect)  
  Evidence: the FM is passed `constants = 'ZSFTP_MEDICARE_OUT'` (so host/user/key/etc are expected to be resolved by that FM using that constants group; this program itself does not show the lookup for OUT, only passes the key).
  (Source: include `ZSD_MEDICARE_PDF_PROCESS_F01`, FORM `f_send_error_file_to_sftp`)
- **payload role:** business artifact (error output file)  
  Evidence: the report builds an error file on the app server (in `gv_file_error`) and then calls the SFTP “PUT” step at end-of-selection:  
  - Main program flow:  
    ```abap
    PERFORM f_send_error_file_to_sftp.
    ```
    (Source: main program `ZSD_MEDICARE_PDF_PROCESS`)
  - Error file is created in error folder:  
    ```abap
    CONCATENATE:gv_file_error '\\' rv_file INTO lv_filename.
    OPEN DATASET lv_filename FOR OUTPUT ...
    ```
    (Source: include `ZSD_MEDICARE_PDF_PROCESS_F01`, FORM `f_send_error_file`)

---

### SM69 “shell-out” via `CALL 'SYSTEM'` (file MOVE on app server; not SFTP)
- **kind:** shell-out
- **direction:** unknown (not SFTP)
- **artifact:** OS command execution via `CALL 'SYSTEM' ID 'COMMAND' FIELD lv_parcom` (command text begins with `MOVE`)
- **call sites:**  
  1) `ZSD_MEDICARE_PDF_PROCESS_F01:~(in FORM f_move_files_to_archive)` — snippet  
     ```abap
     CONCATENATE 'MOVE' gv_sourcepath gv_targetpath INTO lv_parcom SEPARATED BY space.
     CALL 'SYSTEM' ID 'COMMAND' FIELD lv_parcom ID 'TAB' FIELD it_tabl.
     ```
  2) `ZSD_MEDICARE_PDF_PROCESS_F01:~(in FORM f_move_files_to_error)` — snippet  
     ```abap
     CONCATENATE 'MOVE' gv_sourcepath gv_targetpath INTO lv_parcom SEPARATED BY space.
     CALL 'SYSTEM' ID 'COMMAND' FIELD lv_parcom ID 'TAB' FIELD it_tabl.
     ```
  (Source: include `ZSD_MEDICARE_PDF_PROCESS_F01`)
- **credentials/host source:** n/a (no SFTP host/user/keys shown; it’s local OS file move)
- **payload role:** unknown
- **Note:** This is *not* evidenced as SFTP (no `sftp/scp/ssh`, no remote host, no credentials), so it’s listed only as an external execution mechanism observed; it does **not** qualify as “read/write to SFTP” per your rules.

---

**Summary:** ZMEDI_GET_FROM_SFTP, ZMEDI_PUT_FROM_SFTP

---

### 8. `ZSFTP_CITI_PULL`

_Summary: `SXPG[SXPG_COMMAND_EXECUTE commandname=ZSFTP_CITI_PULL]`_

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]
### SXPG_COMMAND_EXECUTE
- **kind:** shell-out (SM69 external command execution)
- **direction:** unknown (the ABAP report itself doesn’t prove whether the external command pushes or pulls; it just executes it)
- **artifact:** SM69 command name = `p_comm` (default `'ZSFTP_CITI_PULL'`)
- **call sites:**
  - `ZSFTP_CITI_PULL:~43` — snippet:
    ```abap
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = p_comm
        additional_parameters = g_path
      IMPORTING
        exitcode              = g_ret_code
      TABLES
        exec_protocol         = i_return[]
    ```
- **credentials/host source:** passed indirectly as command-line parameters built from table `ZFI_CONSTANTS` (no host/user is hardcoded in the report; it reads values and concatenates them into `g_path`)
  - `ZSFTP_CITI_PULL:~21-31` — constants source and keys:
    ```abap
    SELECT * FROM zfi_constants INTO TABLE i_constants
                              WHERE pname = 'ZSFTP_CITI'.
    ...
    PERFORM f_set_parameter USING 'SOURCE_FOLDER'     'M' ''.
    PERFORM f_set_parameter USING 'PASSPHRASE'        'M' ' '.
    PERFORM f_set_parameter USING 'FTP_USER'          'M' ' '.
    PERFORM f_set_parameter USING 'FTP_DOMAIN'        'M' '@'.
    PERFORM f_set_parameter USING 'HOST_KEY'          'M' ' '.
    PERFORM f_set_parameter USING 'PRIVATE_KEY_PATH'  'M' ' '.
    ```
  - `ZSFTP_CITI_PULL:~78-90` — how the parameter string is constructed:
    ```abap
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = p_key.
    ...
    IF g_path IS INITIAL.
      g_path = wa_constants-fval.
    ELSE.
      CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY p_sep.
    ENDIF.
    ```
  - What this proves from source:
    - **User identity** comes from `ZFI_CONSTANTS-FVAL` where `FNAM = 'FTP_USER'` and `FNAM = 'FTP_DOMAIN'` (concatenated with separator `'@'`).
    - **Auth material** comes from `FNAM = 'PASSPHRASE'` and `FNAM = 'PRIVATE_KEY_PATH'`.
    - **Host verification** material comes from `FNAM = 'HOST_KEY'`.
    - **Remote/local folder hint** comes from `FNAM = 'SOURCE_FOLDER'` (name suggests folder, but the ABAP code does not itself prove whether it’s remote or local; it’s just a parameter value passed to the external command).
- **payload role:** unknown from ABAP source (the report description says “Pull MT940 into AL11 from citi”, but the ABAP code shown does not itself identify filenames, file formats, or AL11 datasets; it only executes an external command and prints its protocol)
  - Program metadata description (not a code-level proof of the transferred payload, but a hint): `description = "Pull MT940 into AL11 from citi"` (from the `ReadProgram` metadata)

## Mechanisms explicitly *not* found in the report source (based on the artifacts read)
These are **not used anywhere** in the main program source that was read, and there are **no includes** to inspect:
- `CALL 'SYSTEM' ID 'COMMAND' ...` — not present.
- Any `FTP_*` / `SFTP_*` function module calls — not present.
- Any ABAP SSH/SFTP/FTP client classes (`CL_*SSH*`, `CL_*SFTP*`, `CL_*FTP*`, etc.) — not present.
- `CL_GUI_FRONTEND_SERVICES` usage — not present.
- `OPEN DATASET` — not present.
- Background job submission (`JOB_OPEN`, `JOB_SUBMIT`, `SUBMIT ... VIA JOB`, etc.) — not present.
- HTTP/REST/SOAP calls (e.g., `CL_HTTP_CLIENT`, `IF_HTTP_CLIENT`, `CALL TRANSFORMATION`, proxy calls) — not present.

## Includes / blind spots
- `GetIncludesList('ZSFTP_CITI_PULL')` returned: **“No includes found”**.  
  Therefore there are **no include artifacts** to fetch via `GetInclude`, and **no include blind spots** for this program.

**Summary:** `SXPG[SXPG_COMMAND_EXECUTE commandname=ZSFTP_CITI_PULL]`

---
