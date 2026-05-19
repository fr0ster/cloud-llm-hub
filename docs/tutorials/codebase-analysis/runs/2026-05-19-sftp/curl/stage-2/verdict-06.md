# ZSFTP_BNP_PARIBAS_PULL

Tools: GetProgram, ReadProgram, GetIncludesList

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
