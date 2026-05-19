# ZEDI_835

Tools: SearchObject, ReadProgram, GetIncludesList, GetInclude, GetInclude, GetInclude, GetInclude, SearchSource, SearchSource, SearchSource, SearchSource

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
**Verdict:** no  
**Type:** PROG  
**SFTP methods / mechanisms:**
- None found in `ZEDI_835` or its includes (no SFTP/SSH/FTP transfer logic; only local frontend upload and app-server filesystem dataset operations).

**Evidence (program_or_include:line — snippet):**
- `ZEDI_835:1` — `REPORT  ZEDI_835`
- `ZEDI_835:8-9` — `INCLUDE zedi_edi_top.` / `INCLUDE zedi_835_top.`
- `ZEDI_835:14` — `PERFORM read_file_data.`
- `ZEDI_835_F01` (read/app-server directory) — `CALL FUNCTION 'EPS2_GET_DIRECTORY_LISTING'`
- `ZEDI_835_F01` (read app-server files) — `OPEN DATASET gv_file  FOR INPUT IN TEXT MODE ENCODING DEFAULT .`
- `ZEDI_835_F01` (frontend upload when not `p_app`) — `CALL FUNCTION 'GUI_UPLOAD'`
- `ZEDI_835_F01` (archive/move implemented as file copy on app server) — `OPEN DATASET gv_arc_file FOR OUTPUT...` and `TRANSFER wa_final_data TO gv_arc_file.`
- `ZEDI_835_F01` (error/log writing on app server) — `OPEN DATASET gv_log_file  FOR OUTPUT...` and `TRANSFER wa_log TO gv_log_file.`
- `ZEDI_835_TOP` (selection screen default path hints “FTP” folder name but not a transfer mechanism) — path building like `...\\data\\FTP\\...` appears only in concatenated filesystem paths.

**Notes:**  
- Direction: file **pull/read** from application server directory when `p_app = 'X'` (directory listing + `OPEN DATASET ... FOR INPUT`), otherwise **pull/read** from user PC via `GUI_UPLOAD`.  
- Payload role (proven by source): reads EDI 835 `.era` content and posts/updates EOB-related Z-tables (e.g., `MODIFY zzsinpm_mceob_hd`, `..._it`, `..._amnt`, `..._plb`).  
- Package-wide wrapper scan for `SXPG_COMMAND_EXECUTE` / `SFTP` / `FTP` / `SSH` in package `Z001` could not be completed because all `SearchSource` calls **timed out** in this run, so only direct-object/includes evidence is reflected above.
