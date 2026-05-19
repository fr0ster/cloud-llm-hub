# 05-maintainability — Maintainability & Modern ABAP Review

> Target: `ZDMS_UPLOAD_FILES` (PROG, package Z001, destination DS4_CLH).
> Generated from `curl/resp-maintainability.sse` via SmartAgent.

> tokens: gpt-5.2 = 120,383 (20 requests)
> tokens: embedder = 884 (4 requests)
[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
## maintainability findings

### 1. LOW — Obsolete string building with CONCATENATE
- **Location:** ZDMS_UPLOAD_FILES_F01:33
- **Snippet:**
  ```abap
  CONCATENATE lv_path lv_folder INTO gv_dir_in.
  ```
- **Why:** `CONCATENATE` is older style and harder to read/maintain than modern string templates for simple concatenations.
- **Recommendation:** Use string templates, e.g. `gv_dir_in = |{ lv_path }{ lv_folder }|.`

### 2. LOW — Magic value for “color” control (unclear semantics)
- **Location:** ZDMS_UPLOAD_FILES_F01:54
- **Snippet:**
  ```abap
  FORM f_log  USING    rv_text
                       rv_val
                       rv_color.
  ```
- **Why:** `rv_color` is passed around as raw literals (`'6'`, `'4'`, `'3'`, `' '`) which obscures intent and makes future changes error-prone.
- **Recommendation:** Replace with named constants (e.g. `CONSTANTS c_color_error TYPE ... VALUE '6'.`) or an enumerated type pattern (constants + CASE).

### 3. LOW — Magic literals for color codes
- **Location:** ZDMS_UPLOAD_FILES_F01:61
- **Snippet:**
  ```abap
  WHEN '6'.
    FORMAT COLOR 6 INTENSIFIED OFF.
  ```
- **Why:** Hard-coded `'6'` / `COLOR 6` is non-obvious and duplicates knowledge in multiple places.
- **Recommendation:** Introduce constants (e.g. `c_log_color_error`) and use them in both the `CASE` and `FORMAT COLOR`.

### 4. LOW — Obsolete internal table declaration with HEADER LINE
- **Location:** ZDMS_UPLOAD_FILES_F01:332
- **Snippet:**
  ```abap
  lt_return   TYPE TABLE OF btcxpm WITH HEADER LINE.
  ```
- **Why:** `WITH HEADER LINE` is obsolete and makes code less explicit (implicit work area).
- **Recommendation:** Use `TYPE STANDARD TABLE OF btcxpm WITH EMPTY KEY` plus an explicit work area, or inline declarations in loops.

### 5. LOW — Obsolete internal table declaration with HEADER LINE (second instance)
- **Location:** ZDMS_UPLOAD_FILES_F01:411
- **Snippet:**
  ```abap
  lt_return   TYPE TABLE OF btcxpm WITH HEADER LINE,
  ```
- **Why:** Same obsolete pattern; also encourages implicit header usage.
- **Recommendation:** Replace with a headerless table and explicit work area.

### 6. LOW — Commented-out code left in place
- **Location:** ZDMS_UPLOAD_FILES_F01:103
- **Snippet:**
  ```abap
  *        lv_doc      TYPE char8,  "tkt INC0064531 svc_mgari
          lv_doc      TYPE char10, "tkt INC0064531 svc_mgari
  ```
- **Why:** Commented-out code blocks add noise and ambiguity about the intended type/length.
- **Recommendation:** Remove the commented line; capture rationale in a short comment or in change history (or use ABAP Doc on the type/field if appropriate).

### 7. LOW — Obsolete string parsing with SPLIT
- **Location:** ZDMS_UPLOAD_FILES_F01:137
- **Snippet:**
  ```abap
  SPLIT lw_files-name AT '_' INTO lv_kunnr lv_doc lv_name.
  ```
- **Why:** `SPLIT` is older style; for maintainability, modern ABAP often favors expressions/regex classes for stricter parsing and clearer validation.
- **Recommendation:** Consider `FIND REGEX ... SUBMATCHES ...` (with explicit format validation), or at least centralize parsing into a dedicated routine/method.

### 8. LOW — Dead code: variable declared but never used
- **Location:** ZDMS_UPLOAD_FILES_F01:90
- **Snippet:**
  ```abap
  DATA: lv_userid   TYPE sy-uname,
        lv_kunnr    TYPE kna1-kunnr,
  ```
- **Why:** `lv_userid` is cleared and assigned into `lw_data-userid`, but never set from the filename or elsewhere in this FORM, reducing readability and suggesting incomplete logic.
- **Recommendation:** Either populate `lv_userid` from the filename (if intended) or remove the variable and the assignment to `lw_data-userid` to avoid misleading future maintainers.

### 9. LOW — Mixed inline and explicit DATA declarations in same routine
- **Location:** ZDMS_UPLOAD_FILES_F01:237
- **Snippet:**
  ```abap
  IF <fs_docs>-dokar = 'AU1' AND <fs_data>-file_name IS NOT INITIAL.
    DATA lv_len TYPE i.
  ```
- **Why:** Declaring `DATA lv_len` inside a block while the FORM otherwise uses a top `DATA:` section mixes styles and makes scanning variables harder.
- **Recommendation:** Prefer one consistent style per routine: either move `lv_len` to the main `DATA:` block, or convert the routine to predominantly inline declarations.

### 10. LOW — Magic literals used for business rules / messages
- **Location:** ZDMS_UPLOAD_FILES_F01:171
- **Snippet:**
  ```abap
  CONCATENATE 'INVALID PATIENT ID' <fs_data>-kunnr INTO lv_message SEPARATED BY space.
  ```
- **Why:** Hard-coded texts scattered through code are harder to maintain/translate and invite inconsistencies.
- **Recommendation:** Use message class entries (`MESSAGE e...`) or centralize texts in constants/text symbols (e.g. `TEXT-...`) and build with string templates.

### 11. LOW — Obsolete string building with CONCATENATE (message construction)
- **Location:** ZDMS_UPLOAD_FILES_F01:171
- **Snippet:**
  ```abap
  CONCATENATE 'INVALID PATIENT ID' <fs_data>-kunnr INTO lv_message SEPARATED BY space.
  ```
- **Why:** `CONCATENATE ... SEPARATED BY` is less readable than string templates for simple messages.
- **Recommendation:** `lv_message = |INVALID PATIENT ID { <fs_data>-kunnr }|.` (preferably with a message class/text symbol).

### 12. LOW — Magic constants for document type
- **Location:** ZDMS_UPLOAD_FILES_F01:237
- **Snippet:**
  ```abap
  IF <fs_docs>-dokar = 'AU1' AND <fs_data>-file_name IS NOT INITIAL.
  ```
- **Why:** `'AU1'` is a business constant embedded in logic; future changes require hunting occurrences.
- **Recommendation:** Define a constant (e.g. `CONSTANTS c_dokar_au1 TYPE dokar VALUE 'AU1'.`) or read from customizing if it’s configuration.

### 13. LOW — Commented-out ENDIF left behind
- **Location:** ZDMS_UPLOAD_FILES_F01:192
- **Snippet:**
  ```abap
  *    ENDIF.
  ```
- **Why:** Stray commented control-flow statements harm readability and can confuse maintainers about intended nesting.
- **Recommendation:** Remove the commented line; rely on proper indentation and (if needed) short explanatory comments.

### 14. LOW — Hard-coded “allowed characters” string (magic literal)
- **Location:** ZDMS_UPLOAD_FILES_F01:260
- **Snippet:**
  ```abap
  lv_text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.
  CONCATENATE lv_text '/!@#$%&*-_+=~|\[{]}()' INTO lv_text.
  ```
- **Why:** Large hard-coded character sets are difficult to verify and maintain; intent (what is being validated) is not self-evident.
- **Recommendation:** Replace with a clearer validation approach (e.g. `FIND REGEX` for date format) or encapsulate the character set as a named constant with comment.

### 15. LOW — Obsolete string building with CONCATENATE (path construction)
- **Location:** ZDMS_UPLOAD_FILES_F01:509
- **Snippet:**
  ```abap
  CONCATENATE lv_error_dir_in '\\' p_file INTO lv_error_dir_in.
  ```
- **Why:** `CONCATENATE` for path assembly is less readable; also the path separator is a magic literal.
- **Recommendation:** Use string templates and centralize the separator as a constant, e.g. `CONSTANTS c_sep TYPE c VALUE '\'.` and `lv_error_dir_in = |{ lv_error_dir_in }{ c_sep }{ p_file }|.`

### 16. LOW — Missing typing for FORM parameters (implicit ANY)
- **Location:** ZDMS_UPLOAD_FILES_F01:579
- **Snippet:**
  ```abap
  FORM f_fill_log USING p_kunnr p_vkorg p_file p_message p_error.
  ```
- **Why:** Untyped FORM parameters reduce readability and type safety; it’s unclear what each parameter should be.
- **Recommendation:** Type parameters explicitly, e.g. `USING p_kunnr TYPE kna1-kunnr ... p_error TYPE c LENGTH 1` (or better, refactor to methods where signatures are clearer).

### 17.
