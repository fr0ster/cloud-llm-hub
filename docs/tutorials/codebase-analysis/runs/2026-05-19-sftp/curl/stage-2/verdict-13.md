# ZSFTP_CITI_PULL

Tools: ReadProgram, GetIncludesList

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
