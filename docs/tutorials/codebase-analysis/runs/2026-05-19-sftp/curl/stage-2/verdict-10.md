# ZEDI_835_JPM

Tools: ReadProgram, GetIncludesList, GetInclude, GetInclude, GetInclude, GetInclude

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
**Verdict:** no  
**Type:** PROG  
**SFTP methods / mechanisms:**
- None found. No `SXPG_COMMAND_EXECUTE`, no SFTP/SSH libraries/classes, and no SM69-driven SFTP command execution in the program+includes read.

**Evidence (program_or_include:line — snippet):**
- ZEDI_835_JPM:1 — `INCLUDE ZEDI_EDI_JPM_TOP.`
- ZEDI_835_JPM:2 — `INCLUDE ZEDI_835_JPM_TOP.`
- ZEDI_835_JPM:8 — `PERFORM read_file_data.`
- ZEDI_835_JPM_F01:~40 — `CALL FUNCTION 'EPS2_GET_DIRECTORY_LISTING'` (directory listing on app server)
- ZEDI_835_JPM_F01:~70 — `OPEN DATASET gv_file FOR INPUT IN TEXT MODE ...` (app-server file read)
- ZEDI_835_JPM_F01:~95 — `CONCATENATE 'E:\usr\sap\' sy-sysid '\DVEBMGS00\data\FTP\JPMorgan\Inbound\Lockbox\Archive_File' ... INTO gv_arc_file.`
- ZEDI_835_JPM_F01:~110 — `CONCATENATE 'E:\usr\sap\' sy-sysid '\DVEBMGS00\data\FTP\JPMorgan\Inbound\Lockbox\Error_File' ... INTO gv_err_file.`
- ZEDI_835_JPM_F01:~145 — `CALL FUNCTION 'GUI_UPLOAD'` (frontend upload when not `p_app`)
- ZEDI_835_JPM_F01:~310 — `CALL 'SYSTEM' ID 'COMMAND' FIELD lv_parcom` with `lv_parcom` built as `MOVE <src> <tgt>` (OS move, not SFTP)

**Notes:**  
- Direction: local file **pull** from app-server directory (`EPS2_GET_DIRECTORY_LISTING` + `OPEN DATASET ... FOR INPUT`) and then local OS **move/archive** (`CALL 'SYSTEM' ... 'MOVE'`) into app-server paths containing `...\data\FTP\JPMorgan\Inbound\Lockbox\...`. The “FTP” in the path looks like a folder naming convention; no source evidence of any network SFTP transfer.
