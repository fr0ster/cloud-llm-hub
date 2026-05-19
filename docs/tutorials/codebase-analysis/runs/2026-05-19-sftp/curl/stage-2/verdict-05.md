# ZFI_BANK_STMT_LOAD

Tools: ReadProgram, GetIncludesList, GetInclude, GetInclude

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
