# /VERTEX/SPOT_VAT_OUTPUT_COMPL

Tools: SearchObject, ReadProgram, GetIncludesList, SearchSource, SearchSource, SearchSource, SearchSource, GetInclude, GetInclude, GetInclude

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
**Verdict:** no  
**Type:** PROG  
**SFTP methods / mechanisms:**
- None found (no evidence of SFTP/FTP/SSH usage; no `SXPG_COMMAND_EXECUTE`; no SFTP/FTP/SSH wrappers detected in package search)

**Evidence (program_or_include:line — snippet):**
- /VERTEX/SPOT_VAT_OUTPUT_COMPL:1 — `REPORT  /vertex/spot_vat_output_report ...`
- /VERTEX/SPOT_VAT_OUTPUT_COMPL:~70 — `PERFORM download_selected_data.`
- /VERTEX/SPOT_VAT_OUTPUT_COMPL:~430 — `CALL METHOD /vertex/cl_spot=>create_file_new ... iv_gui_download = p_pc ... iv_filename = lv_filename`
- /VERTEX/SPOT_VAT_OUTPUT_COMPL:~455 — `CALL METHOD /vertex/cl_spot=>validate_file_name ...`
- /VERTEX/SPOT_ALV_FORMS:~1 — (ALV fieldcatalog handling only; no network/file transfer APIs)
- /VERTEX/SPOT_EVENTS:~1 — (ALV event handling only; no network/file transfer APIs)
- /VERTEX/SPOT_OUTPUTVATCOMPLTOP:~1 — (selection screen + data declarations only; no network/file transfer APIs)
- Package /VERTEX/SPOT search results — `SXPG_COMMAND_EXECUTE`: 0 hits; `SFTP`: 0 hits; `FTP`: 0 hits; `SSH`: 0 hits (per `SearchSource` scans)

**Notes:**  
- Proven behavior is **file creation/download** via `/vertex/cl_spot=>create_file_new` with user choice **PC vs server** (push to local frontend or write to app server), but **no SFTP mechanism is evidenced** anywhere in the program or its includes, and no SFTP/FTP/SSH-related wrappers were found in package `/VERTEX/SPOT` by source search.
