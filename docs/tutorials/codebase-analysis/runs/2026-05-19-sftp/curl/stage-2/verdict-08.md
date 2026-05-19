# ZSFTP_CAPARIO

Tools: GetProgram, GetIncludesList

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
