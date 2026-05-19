# ZFFIU_ACC_POST

Tools: ReadProgram, GetIncludesList, GetInclude, GetInclude, GetInclude

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
