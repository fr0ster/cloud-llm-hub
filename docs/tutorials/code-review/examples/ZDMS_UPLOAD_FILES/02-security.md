# 02-security — Security Review

> Target: `ZDMS_UPLOAD_FILES` (PROG, package Z001, destination DS4_CLH).
> Generated from `curl/resp-security.sse` via SmartAgent.

> tokens: gpt-5.2 = 85,633 (18 requests)
> tokens: embedder = 884 (4 requests)
[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
## security findings

### 1. HIGH — Missing explicit authorization check before OS command execution (SFTP GET)
- **Location:** ZDMS_UPLOAD_FILES_F01:~250
- **Snippet:**
  ```abap
  CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
    EXPORTING
      commandname           = lv_comm
      additional_parameters = gv_param
  ```
- **Why:** `SXPG_COMMAND_EXECUTE` triggers execution of an external OS command; there is no explicit `AUTHORITY-CHECK` (e.g., `S_LOG_COM` / `S_RZL_ADM` depending on setup) before this sensitive operation.
- **Recommendation:** Add an explicit `AUTHORITY-CHECK` before calling `SXPG_COMMAND_EXECUTE` (and fail closed). Also restrict allowed commands in SM69 and ensure the command is defined with “Additional parameters not allowed” where possible.

### 2. HIGH — Missing explicit authorization check before OS command execution (SFTP PUT)
- **Location:** ZDMS_UPLOAD_FILES_F01:~320
- **Snippet:**
  ```abap
  CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
    EXPORTING
      commandname           = lv_comm
      additional_parameters = gv_param
  ```
- **Why:** Same sensitive external command execution path, again without an explicit `AUTHORITY-CHECK` in the report prior to execution.
- **Recommendation:** Add an explicit `AUTHORITY-CHECK` before this call as well (do not rely solely on the FM exception `no_permission`). Consider centralizing the check in a wrapper FORM/method.

### 3. MEDIUM — Shell-injection risk: building `additional_parameters` via concatenation of configurable values
- **Location:** ZDMS_UPLOAD_FILES_F01:~420
- **Snippet:**
  ```abap
  IF p_sep IS NOT INITIAL.
    CONCATENATE gv_param wa_constants-fval INTO gv_param SEPARATED BY p_sep.
  ELSE.
    CONCATENATE gv_param wa_constants-fval INTO gv_param.
  ENDIF.
  ```
- **Why:** `gv_param` is later passed as `additional_parameters` to `SXPG_COMMAND_EXECUTE`. Values come from `zfi_constants-fval` and are concatenated without escaping/quoting, which can enable command-parameter injection if table maintenance is abused/misconfigured.
- **Recommendation:** Avoid passing a free-form parameter string. Prefer parameterizing the external command in SM69 without “additional parameters”, or strictly validate/escape each parameter (allowlist characters, quote values safely) and separate parameters in a structured way (e.g., generate `gv_param` only from validated tokens).

### 4. LOW — Sensitive operational details may be exposed via plain report output
- **Location:** ZDMS_UPLOAD_FILES_F01:~385
- **Snippet:**
  ```abap
  OPEN DATASET lv_dir_in FOR INPUT IN BINARY MODE MESSAGE msg.
  IF sy-subrc <> 0.
    WRITE:/ msg.
  ```
- **Why:** Dataset error messages can reveal filesystem paths/technical details to the user via `WRITE`, which is information disclosure.
- **Recommendation:** Log technical details to an application log (SLG1) with appropriate authorization, and show users a generic message (or mask paths).

**Severity summary for this category:**
- CRITICAL: 0
- HIGH: 2
- MEDIUM: 1
- LOW: 1
- INFO: 0
