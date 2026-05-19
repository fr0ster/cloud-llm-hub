# ZSFTP_CAPARIO_PULL

Tools: SearchObject, ReadProgram

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
