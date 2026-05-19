# ZDMS_UPLOAD_FILES

Tools: ReadProgram, GetIncludesList, GetInclude, GetInclude

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
