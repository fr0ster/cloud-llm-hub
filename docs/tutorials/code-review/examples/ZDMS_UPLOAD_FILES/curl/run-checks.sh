#!/usr/bin/env bash
set -u
OUT=$(dirname "$0")

# Build per-check prompts. Same target source-read, different rule set.
build_prompt() {
  local CATEGORY="$1" RULES="$2"
  python3 - "$CATEGORY" "$RULES" <<'PY'
import json, sys
category = sys.argv[1]
rules = sys.argv[2]
prompt = f"""You have the tools ReadProgram, GetIncludesList, GetInclude. They are available. Call them.

Target: ABAP program `ZDMS_UPLOAD_FILES` in package Z001, destination DS4_CLH.

Procedure (each step exactly ONCE):
1. ReadProgram('ZDMS_UPLOAD_FILES') — main source.
2. GetIncludesList('ZDMS_UPLOAD_FILES') — list of includes.
3. For EACH include returned, call GetInclude(<include_name>) exactly once.

Then perform a **{category}** code review against the read source. ONLY this category — do not include findings from other categories.

{rules}

Output format (strict):

## {category} findings

For each finding:

### N. <SEVERITY> — <short finding title>
- **Location:** <program_or_include>:<line>
- **Snippet:**
  ```abap
  <verbatim 1-5 lines from source>
  ```
- **Why:** <1-2 sentence rule violation explanation>
- **Recommendation:** <concrete fix or replacement API>

If there are NO findings in this category, write `(no findings)` instead of the list.

End with:

**Severity summary for this category:**
- CRITICAL: <N>
- HIGH: <N>
- MEDIUM: <N>
- LOW: <N>
- INFO: <N>

Rules:
- Cite source for every finding. No source = no finding.
- Each finding is one specific instance. Do not lump multiple instances into one bullet.
- Severity must be one of CRITICAL / HIGH / MEDIUM / LOW / INFO.
- If you observe something praiseworthy in this category, you may include it as an INFO finding with severity INFO.
- Do not call tools more than once with the same arguments."""
print(json.dumps({"model":"x","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY
}

# Per-category rule sets
SEC_RULES="Rules for this category — security:
- Hardcoded credentials, secrets, hosts, file paths that should be configurable. CRITICAL if a real secret leaks; HIGH if a host or path is hardcoded.
- Missing or weak AUTHORITY-CHECK before sensitive operations (file write, transport, SXPG_COMMAND_EXECUTE).
- Dynamic SQL via concatenation (CONCATENATE into a string used in EXEC SQL or NATIVE SQL or for ABAP-side LIKE/WHERE construction) — SQL/ABAP injection risk.
- Shell-injection risk from SXPG additional_parameters built via concatenation without escaping.
- Sensitive data written to dev_w/syslog or returned as plain WRITE output.
- Credential leakage in error logs (PASSPHRASE, PRIVATE_KEY_PATH content concatenated into a message).
- Unencrypted password storage in zfi_constants (FTP_PSWD as plaintext) — note as HIGH if the source reveals it."

PERF_RULES="Rules for this category — performance:
- SELECT * without specific field list on a wide table — MEDIUM unless table is known-small.
- SELECT inside LOOP (especially LOOP AT itab + nested SELECT) — HIGH.
- Nested LOOP AT itab without binary search key.
- Missing WHERE clause on SELECT against a large transactional table.
- SELECT SINGLE without all key fields specified — MEDIUM.
- READ TABLE without BINARY SEARCH on a sorted big table.
- Repeated calls to the same DB / function inside a loop (memoization opportunity).
- Unnecessary FOR ALL ENTRIES with empty driver table (no IS NOT INITIAL guard).
- DELETE/MODIFY/INSERT inside LOOP without proper safeguard."

CLEAN_RULES="Rules for this category — S/4HANA CleanCore compliance:
- Use of `SXPG_COMMAND_EXECUTE` — not allowed in CleanCore (OS shell access). HIGH.
- Direct DDIC access to standard SAP tables that have a released API alternative.
- Modifications to SAP standard objects (any *_MODI marker).
- Calls to function modules / classes not in the SAP Cloud-released allow-list.
- File operations via `OPEN DATASET` against AL11 paths — not allowed in S/4HANA Cloud.
- Use of `CALL TRANSACTION` to non-released transactions.
- Direct table buffer access, COMMIT WORK in user-exits, etc.
- Note any pattern that's fine on-premise but blocks future S/4HANA Cloud migration.
- All findings here are HIGH severity (blocks CleanCore) unless the object will demonstrably never run in a Cloud context."

MAINT_RULES="Rules for this category — maintainability and modern ABAP:
- Obsolete syntax: CONCATENATE/SPLIT vs string templates; OCCURS 0 vs TYPE TABLE; HEADER LINE itabs.
- Magic numbers / literals that should be constants or zfi_constants entries.
- FORM longer than 100 lines without clear sub-structure.
- Dead code: variables declared and never assigned/read; FORMs called by no one in the read source.
- Commented-out code blocks.
- Missing or wrong types on PARAMETERS (TYPE C with explicit length when a domain exists).
- Mixed inline/explicit data declarations (DATA: lv_x. then DATA(lv_y) = ...).
- Missing or stale ABAP Doc comments on public FMs / FORMs.
- No type-safe alternative used where one exists (e.g. RTTS, ABAP CDS, exception classes).
- All findings here are MEDIUM or LOW unless they actively block reading."

# Build 4 requests
build_prompt "security" "$SEC_RULES" > $OUT/req-security.json
build_prompt "performance" "$PERF_RULES" > $OUT/req-performance.json
build_prompt "cleancore" "$CLEAN_RULES" > $OUT/req-cleancore.json
build_prompt "maintainability" "$MAINT_RULES" > $OUT/req-maintainability.json

# Launch 4 in parallel (light tools only — safe per backend-overload rule)
for CHECK in security performance cleancore maintainability; do
  ( echo ">>> ZDMS_UPLOAD_FILES check: $CHECK"
    START=$(date +%s)
    curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
      -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" \
      -d @"$OUT/req-$CHECK.json" --max-time 600 > "$OUT/resp-$CHECK.sse"
    echo "    $CHECK done in $(($(date +%s)-START))s, $(wc -c < $OUT/resp-$CHECK.sse) bytes"
  ) &
done
wait
echo "ALL CHECKS DONE"
