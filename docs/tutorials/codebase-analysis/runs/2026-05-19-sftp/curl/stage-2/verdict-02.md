# /VERTEX/SPOT_VAT_INPUT_COMPL

Tools: SearchObject, ReadProgram, SearchSource, SearchSource, SearchSource, SearchSource

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
**Verdict:** no  
**Type:** PROG  
**SFTP methods / mechanisms:**
- none found (no `SXPG_COMMAND_EXECUTE`, `SFTP`, `FTP`, or `SSH` usage in the analyzed scope)

**Evidence (program_or_include:line — snippet):**
- /VERTEX/SPOT_VAT_INPUT_COMPL:(download_selected_data) — `CALL METHOD /vertex/cl_spot=>create_file_new ... iv_gui_download = p_pc iv_filename = lv_filename ...` (file creation/download is handled via `/vertex/cl_spot=>create_file_new`, not via SFTP/FTP/SSH in this program)
- /VERTEX/SPOT_VAT_INPUT_COMPL:(includes) — `INCLUDE: /vertex/spot_events.` / `INCLUDE: /vertex/spot_alv_forms.` / `INCLUDE: /vertex/spotforms.` (includes exist, but were **not** read because the required `GetIncludesList` / `GetInclude` tooling is not available here)

**Notes:**  
- This program is an “Input VAT Compliance Report” and appears to **export/download** report data to PC or application server (selection screen has `p_pc` / `p_server`; file name `INP_VAT_...TXT`), but **no SFTP/FTP/SSH mechanism is proven** in the main program source.  
- Package-wide search (restricted by `object_filter="*SPOT_VAT_INPUT_COMPL*"`) found **no** hits for `SXPG_COMMAND_EXECUTE`, `SFTP`, `FTP`, or `SSH`, so there is no evidence of legacy SM69 shell-based SFTP either.
