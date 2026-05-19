# 06-summary — Code-review aggregate (ZDMS_UPLOAD_FILES)

> Aggregation of stages 2-5. Severity-ranked, owner-prioritized.

## Severity histogram

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 10 |
| MEDIUM | 3 |
| LOW | 17 |
| INFO | 0 |

## Per-category breakdown

| Category | CRITICAL | HIGH | MEDIUM | LOW | INFO | Total |
|---|---|---|---|---|---|---|
| security | 0 | 2 | 1 | 1 | 0 | 4 |
| performance | 0 | 2 | 2 | 0 | 0 | 4 |
| cleancore | 0 | 6 | 0 | 0 | 0 | 6 |
| maintainability | 0 | 0 | 0 | 16 | 0 | 16 |
| **TOTAL** |0|10|3|17|0| **30** |

## Top findings (CRITICAL + HIGH)

### [HIGH] [cleancore] OS command execution via `SXPG_COMMAND_EXECUTE` (shell access)
- **Location:** ZDMS_UPLOAD_FILES_F01:~325
- **Why:** Executing external OS commands is not allowed for S/4HANA Clean Core / Cloud (shell access via SM69 commands).
- **Recommendation:** Replace OS-command-based SFTP with a released integration approach (e.g., SAP Integration Suite / Cloud Connector, or an HTTP-based API using released ABAP HTTP clients to a managed endpoint). Avoid SM69/SXPG completely.

### [HIGH] [cleancore] OS command execution via `SXPG_COMMAND_EXECUTE` (shell access)
- **Location:** ZDMS_UPLOAD_FILES_F01:~388
- **Why:** Executing external OS commands is not allowed for S/4HANA Clean Core / Cloud (shell access via SM69 commands).
- **Recommendation:** Same as above—move file transfer out of the ABAP app server OS layer and use a released connectivity/integration mechanism.

### [HIGH] [cleancore] File operations on application server via `OPEN DATASET` / `READ DATASET` / `TRANSFER` / `DELETE DATASET` (AL11-style)
- **Location:** ZDMS_UPLOAD_FILES_F01:~468
- **Why:** Direct application-server filesystem access is not allowed in S/4HANA Cloud / Clean Core (depends on AL11 paths / app server file system).
- **Recommendation:** Store and process files using released services instead (e.g., attachment APIs/Document Management APIs where released, or externalize file handling to BTP/integration and pass content via HTTP/OData/Inbound APIs).

### [HIGH] [cleancore] File deletion on application server via `DELETE DATASET` (AL11-style)
- **Location:** ZDMS_UPLOAD_FILES_F01:~494
- **Why:** Direct manipulation of application-server files is not allowed in S/4HANA Cloud / Clean Core.
- **Recommendation:** Avoid app-server file persistence; manage lifecycle in an external content store/service with released APIs, or handle deletion in the external integration layer.

### [HIGH] [cleancore] File deletion on application server via `DELETE DATASET` (AL11-style)
- **Location:** ZDMS_UPLOAD_FILES_F01:~656
- **Why:** Direct manipulation of application-server files is not allowed in S/4HANA Cloud / Clean Core.
- **Recommendation:** Same as above—use released content/attachment/document APIs or external content storage instead of AL11/app-server paths.

### [HIGH] [cleancore] Direct read of standard table `TVARVC` (released API alternative expected)
- **Location:** ZDMS_UPLOAD_FILES_F01:~164
- **Why:** Direct DDIC access to certain standard configuration tables can be considered non-Clean-Core when a released API/framework should be used (and is a common blocker for cloud readiness).
- **Recommendation:** Replace with a released variant/configuration access mechanism (e.g., use a released configuration API/service or encapsulate configuration in your own Z-table with a stable API; avoid direct dependency on TVARVC for cloud-targeted apps).

### [HIGH] [performance] Repeated function/module calls inside loop (FORMAT_MESSAGE)
- **Location:** ZDMS_UPLOAD_FILES_F01:~235
- **Why:** Repeated calls to the same function inside a loop can add significant runtime overhead (rule: repeated calls to the same DB / function inside a loop).
- **Recommendation:** Avoid calling `FORMAT_MESSAGE` for every row when possible—e.g., use `rs_return-message` directly if already filled, or collect unique `(id, number, v1..v4)` combinations and format once per unique key (cache result in a hashed table), then reuse.

### [HIGH] [performance] Repeated function/module calls inside loop (ZDMS_UPLOAD_DOCUMENTS)
- **Location:** ZDMS_UPLOAD_FILES_F01:~205
- **Why:** Calling an upload/FM per row can be a major performance bottleneck (rule: repeated calls to the same DB / function inside a loop).
- **Recommendation:** If the FM supports it, switch to a mass-processing API (table parameter) to upload multiple files per call. If not available, consider parallelization via background tasks (aRFC) / batch jobs, or at least minimize per-iteration overhead (e.g., avoid repeated formatting, reduce DB lookups inside the FM, etc.).

### [HIGH] [security] Missing explicit authorization check before OS command execution (SFTP GET)
- **Location:** ZDMS_UPLOAD_FILES_F01:~250
- **Why:** `SXPG_COMMAND_EXECUTE` triggers execution of an external OS command; there is no explicit `AUTHORITY-CHECK` (e.g., `S_LOG_COM` / `S_RZL_ADM` depending on setup) before this sensitive operation.
- **Recommendation:** Add an explicit `AUTHORITY-CHECK` before calling `SXPG_COMMAND_EXECUTE` (and fail closed). Also restrict allowed commands in SM69 and ensure the command is defined with “Additional parameters not allowed” where possible.

### [HIGH] [security] Missing explicit authorization check before OS command execution (SFTP PUT)
- **Location:** ZDMS_UPLOAD_FILES_F01:~320
- **Why:** Same sensitive external command execution path, again without an explicit `AUTHORITY-CHECK` in the report prior to execution.
- **Recommendation:** Add an explicit `AUTHORITY-CHECK` before this call as well (do not rely solely on the FM exception `no_permission`). Consider centralizing the check in a wrapper FORM/method.

## All findings (full list)

| # | Severity | Category | Title | Location |
|---|---|---|---|---|
| 1 | HIGH | cleancore | OS command execution via `SXPG_COMMAND_EXECUTE` (shell access) | ZDMS_UPLOAD_FILES_F01:~325 |
| 2 | HIGH | cleancore | OS command execution via `SXPG_COMMAND_EXECUTE` (shell access) | ZDMS_UPLOAD_FILES_F01:~388 |
| 3 | HIGH | cleancore | File operations on application server via `OPEN DATASET` / `READ DATASET` / `TRANSFER` / `DELETE DATASET` (AL11-style) | ZDMS_UPLOAD_FILES_F01:~468 |
| 4 | HIGH | cleancore | File deletion on application server via `DELETE DATASET` (AL11-style) | ZDMS_UPLOAD_FILES_F01:~494 |
| 5 | HIGH | cleancore | File deletion on application server via `DELETE DATASET` (AL11-style) | ZDMS_UPLOAD_FILES_F01:~656 |
| 6 | HIGH | cleancore | Direct read of standard table `TVARVC` (released API alternative expected) | ZDMS_UPLOAD_FILES_F01:~164 |
| 7 | HIGH | performance | Repeated function/module calls inside loop (FORMAT_MESSAGE) | ZDMS_UPLOAD_FILES_F01:~235 |
| 8 | HIGH | performance | Repeated function/module calls inside loop (ZDMS_UPLOAD_DOCUMENTS) | ZDMS_UPLOAD_FILES_F01:~205 |
| 9 | HIGH | security | Missing explicit authorization check before OS command execution (SFTP GET) | ZDMS_UPLOAD_FILES_F01:~250 |
| 10 | HIGH | security | Missing explicit authorization check before OS command execution (SFTP PUT) | ZDMS_UPLOAD_FILES_F01:~320 |
| 11 | MEDIUM | performance | `SELECT *` from TVARVC (unnecessary wide fetch) | ZDMS_UPLOAD_FILES_F01:~120 |
| 12 | MEDIUM | performance | `SELECT *` from DMS_DOC_FILES (potentially wide table) | ZDMS_UPLOAD_FILES_F01:~150 |
| 13 | MEDIUM | security | Shell-injection risk: building `additional_parameters` via concatenation of configurable values | ZDMS_UPLOAD_FILES_F01:~420 |
| 14 | LOW | maintainability | Obsolete string building with CONCATENATE | ZDMS_UPLOAD_FILES_F01:33 |
| 15 | LOW | maintainability | Magic value for “color” control (unclear semantics) | ZDMS_UPLOAD_FILES_F01:54 |
| 16 | LOW | maintainability | Magic literals for color codes | ZDMS_UPLOAD_FILES_F01:61 |
| 17 | LOW | maintainability | Obsolete internal table declaration with HEADER LINE | ZDMS_UPLOAD_FILES_F01:332 |
| 18 | LOW | maintainability | Obsolete internal table declaration with HEADER LINE (second instance) | ZDMS_UPLOAD_FILES_F01:411 |
| 19 | LOW | maintainability | Commented-out code left in place | ZDMS_UPLOAD_FILES_F01:103 |
| 20 | LOW | maintainability | Obsolete string parsing with SPLIT | ZDMS_UPLOAD_FILES_F01:137 |
| 21 | LOW | maintainability | Dead code: variable declared but never used | ZDMS_UPLOAD_FILES_F01:90 |
| 22 | LOW | maintainability | Mixed inline and explicit DATA declarations in same routine | ZDMS_UPLOAD_FILES_F01:237 |
| 23 | LOW | maintainability | Magic literals used for business rules / messages | ZDMS_UPLOAD_FILES_F01:171 |
| 24 | LOW | maintainability | Obsolete string building with CONCATENATE (message construction) | ZDMS_UPLOAD_FILES_F01:171 |
| 25 | LOW | maintainability | Magic constants for document type | ZDMS_UPLOAD_FILES_F01:237 |
| 26 | LOW | maintainability | Commented-out ENDIF left behind | ZDMS_UPLOAD_FILES_F01:192 |
| 27 | LOW | maintainability | Hard-coded “allowed characters” string (magic literal) | ZDMS_UPLOAD_FILES_F01:260 |
| 28 | LOW | maintainability | Obsolete string building with CONCATENATE (path construction) | ZDMS_UPLOAD_FILES_F01:509 |
| 29 | LOW | maintainability | Missing typing for FORM parameters (implicit ANY) | ZDMS_UPLOAD_FILES_F01:579 |
| 30 | LOW | security | Sensitive operational details may be exposed via plain report output | ZDMS_UPLOAD_FILES_F01:~385 |

## Verdict

**Significant rework needed.** 10 HIGH-severity issues — schedule a focused fix sprint before next release of this program.

**CleanCore note:** 6 HIGH-severity CleanCore findings — this object would not run in S/4HANA Cloud as-is. If migration to Cloud is planned, this object needs rewrite, not just patching.