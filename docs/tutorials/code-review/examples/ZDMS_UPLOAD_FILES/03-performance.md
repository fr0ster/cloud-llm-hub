# 03-performance — Performance Review

> Target: `ZDMS_UPLOAD_FILES` (PROG, package Z001, destination DS4_CLH).
> Generated from `curl/resp-performance.sse` via SmartAgent.

> tokens: gpt-5.2 = 68,713 (17 requests)
> tokens: embedder = 884 (4 requests)
[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
## performance findings

### 1. MEDIUM — `SELECT *` from TVARVC (unnecessary wide fetch)
- **Location:** ZDMS_UPLOAD_FILES_F01:~120
- **Snippet:**
  ```abap
  SELECT * FROM tvarvc INTO TABLE @DATA(lt_tvarvc)
    WHERE name = @gv_name AND type = 'S'.
  ```
- **Why:** `SELECT *` can read more columns than needed, increasing DB load and network/memory usage (rule: `SELECT *` on a wide table → MEDIUM unless known-small).
- **Recommendation:** Select only required fields, e.g.:
  ```abap
  SELECT sign, opti, low, high
    FROM tvarvc
    INTO TABLE @DATA(lt_tvarvc)
    WHERE name = @gv_name AND type = 'S'.
  ```

### 2. MEDIUM — `SELECT *` from DMS_DOC_FILES (potentially wide table)
- **Location:** ZDMS_UPLOAD_FILES_F01:~150
- **Snippet:**
  ```abap
  SELECT * FROM dms_doc_files INTO TABLE @DATA(lt_doc_files)
    FOR ALL ENTRIES IN @pt_data
    WHERE filename = @pt_data-file_name_up.
  ```
- **Why:** `SELECT *` can be expensive if the table has many columns; only `filename` is used later for existence check (rule: `SELECT *` on a wide table → MEDIUM).
- **Recommendation:** Fetch only needed columns (likely just `filename`, or key fields used later), e.g.:
  ```abap
  SELECT filename
    FROM dms_doc_files
    INTO TABLE @DATA(lt_doc_files)
    FOR ALL ENTRIES IN @pt_data
    WHERE filename = @pt_data-file_name_up.
  ```

### 3. HIGH — Repeated function/module calls inside loop (FORMAT_MESSAGE)
- **Location:** ZDMS_UPLOAD_FILES_F01:~235
- **Snippet:**
  ```abap
  LOOP AT pt_data ASSIGNING FIELD-SYMBOL(<fs_data>).
    ...
    CALL FUNCTION 'FORMAT_MESSAGE'
      EXPORTING
        id        = rs_return-id
  ```
- **Why:** Repeated calls to the same function inside a loop can add significant runtime overhead (rule: repeated calls to the same DB / function inside a loop).
- **Recommendation:** Avoid calling `FORMAT_MESSAGE` for every row when possible—e.g., use `rs_return-message` directly if already filled, or collect unique `(id, number, v1..v4)` combinations and format once per unique key (cache result in a hashed table), then reuse.

### 4. HIGH — Repeated function/module calls inside loop (ZDMS_UPLOAD_DOCUMENTS)
- **Location:** ZDMS_UPLOAD_FILES_F01:~205
- **Snippet:**
  ```abap
  LOOP AT pt_data ASSIGNING FIELD-SYMBOL(<fs_data>).
    ...
    CALL FUNCTION 'ZDMS_UPLOAD_DOCUMENTS'
      EXPORTING
        kunnr          = <fs_data>-kunnr
  ```
- **Why:** Calling an upload/FM per row can be a major performance bottleneck (rule: repeated calls to the same DB / function inside a loop).
- **Recommendation:** If the FM supports it, switch to a mass-processing API (table parameter) to upload multiple files per call. If not available, consider parallelization via background tasks (aRFC) / batch jobs, or at least minimize per-iteration overhead (e.g., avoid repeated formatting, reduce DB lookups inside the FM, etc.).

**Severity summary for this category:**
- CRITICAL: 0
- HIGH: 2
- MEDIUM: 2
- LOW: 0
- INFO: 0
