# ZSD_MEDICARE_PDF_PROCESS

Tools: GetProgram, GetIncludesList, GetInclude, GetInclude

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
