# 04-cleancore — S/4HANA CleanCore Compliance Review

> Target: `ZDMS_UPLOAD_FILES` (PROG, package Z001, destination DS4_CLH).
> Generated from `curl/resp-cleancore.sse` via SmartAgent.

> tokens: gpt-5.2 = 102,521 (19 requests)
> tokens: embedder = 884 (4 requests)
[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
## cleancore findings

### 1. HIGH — OS command execution via `SXPG_COMMAND_EXECUTE` (shell access)
- **Location:** ZDMS_UPLOAD_FILES_F01:~325
- **Snippet:**
  ```abap
  CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
    EXPORTING
      commandname                   = lv_comm
      additional_parameters         = gv_param
  ```
- **Why:** Executing external OS commands is not allowed for S/4HANA Clean Core / Cloud (shell access via SM69 commands).
- **Recommendation:** Replace OS-command-based SFTP with a released integration approach (e.g., SAP Integration Suite / Cloud Connector, or an HTTP-based API using released ABAP HTTP clients to a managed endpoint). Avoid SM69/SXPG completely.

### 2. HIGH — OS command execution via `SXPG_COMMAND_EXECUTE` (shell access)
- **Location:** ZDMS_UPLOAD_FILES_F01:~388
- **Snippet:**
  ```abap
  CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
    EXPORTING
      commandname                   = lv_comm
      additional_parameters         = gv_param
  ```
- **Why:** Executing external OS commands is not allowed for S/4HANA Clean Core / Cloud (shell access via SM69 commands).
- **Recommendation:** Same as above—move file transfer out of the ABAP app server OS layer and use a released connectivity/integration mechanism.

### 3. HIGH — File operations on application server via `OPEN DATASET` / `READ DATASET` / `TRANSFER` / `DELETE DATASET` (AL11-style)
- **Location:** ZDMS_UPLOAD_FILES_F01:~468
- **Snippet:**
  ```abap
  OPEN DATASET lv_dir_in FOR INPUT IN BINARY MODE MESSAGE msg.
  ...
  READ DATASET lv_dir_in INTO lv_str.
  ...
  TRANSFER lv_str TO lv_error_dir_in.
  ```
- **Why:** Direct application-server filesystem access is not allowed in S/4HANA Cloud / Clean Core (depends on AL11 paths / app server file system).
- **Recommendation:** Store and process files using released services instead (e.g., attachment APIs/Document Management APIs where released, or externalize file handling to BTP/integration and pass content via HTTP/OData/Inbound APIs).

### 4. HIGH — File deletion on application server via `DELETE DATASET` (AL11-style)
- **Location:** ZDMS_UPLOAD_FILES_F01:~494
- **Snippet:**
  ```abap
  DELETE DATASET lv_dir_in.
  ```
- **Why:** Direct manipulation of application-server files is not allowed in S/4HANA Cloud / Clean Core.
- **Recommendation:** Avoid app-server file persistence; manage lifecycle in an external content store/service with released APIs, or handle deletion in the external integration layer.

### 5. HIGH — File deletion on application server via `DELETE DATASET` (AL11-style)
- **Location:** ZDMS_UPLOAD_FILES_F01:~656
- **Snippet:**
  ```abap
  DELETE DATASET lv_dir_in.
  ```
- **Why:** Direct manipulation of application-server files is not allowed in S/4HANA Cloud / Clean Core.
- **Recommendation:** Same as above—use released content/attachment/document APIs or external content storage instead of AL11/app-server paths.

### 6. HIGH — Direct read of standard table `TVARVC` (released API alternative expected)
- **Location:** ZDMS_UPLOAD_FILES_F01:~164
- **Snippet:**
  ```abap
  SELECT * FROM tvarvc INTO TABLE @DATA(lt_tvarvc)
    WHERE name = @gv_name AND type = 'S'.
  ```
- **Why:** Direct DDIC access to certain standard configuration tables can be considered non-Clean-Core when a released API/framework should be used (and is a common blocker for cloud readiness).
- **Recommendation:** Replace with a released variant/configuration access mechanism (e.g., use a released configuration API/service or encapsulate configuration in your own Z-table with a stable API; avoid direct dependency on TVARVC for cloud-targeted apps).

**Severity summary for this category:**
- CRITICAL: 0
- HIGH: 6
- MEDIUM: 0
- LOW: 0
- INFO: 0
