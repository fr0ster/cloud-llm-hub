# ZSFTP_PATIENTCO_PULL

Tools: ReadProgram, GetIncludesList

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
