#!/usr/bin/env bash
# -e  — abort on any unhandled non-zero (the Stage 0 validator depends on this
#       to actually stop the batch when source.txt fails its shape checks).
# -u  — abort on unset variables.
# -o pipefail — abort if any stage of a pipeline fails (matters for the curl |
#       parse pattern in Stage 0).
# Background curls in the per-category fan-out run in subshells, so a single
# failed check there exits the subshell only and `wait` is left to its default
# (non-propagating) behaviour — that's intentional for the batch.
set -euo pipefail
OUT=$(dirname "$0")

# Why this script is structured the way it is.
#
# In the chat-UI flow the user uploads the abap-read-source RAG skill to a
# collection and that skill rides into every turn's context. Stage 0 reads the
# source; later per-category turns re-trigger the read because the skill is
# still in context. The server's chat history (which only stores assistant text
# and aggressively trims it — older turns -> 200 chars, latest -> 500 chars,
# 6 kB total budget, see srv/openai-handler.ts:trimHistoryForContext +
# appendToSession) is therefore not load-bearing for the source in the UI.
#
# The curl batch has no RAG-skill mechanism, so we cannot rely on the model to
# re-read on each per-category turn. We also cannot stash the source in a prior
# turn's assistant text and expect it to survive — the trim policy guarantees
# the source would be cut to a few hundred chars by the time the per-category
# turn runs. Instead:
#
#   Stage 0: one stateless SmartAgent call asks the agent to dump every loaded
#            file VERBATIM (no commentary, no analysis). We parse the SSE
#            content stream into a local source.txt.
#   Stage 2-5: four stateless calls, run in parallel. Each request inlines
#              source.txt as a fenced block in the user message. User messages
#              are kept intact server-side, so the agent sees the full source
#              without depending on session history or stored tool outputs.
#
# Each category therefore stays in its own isolated chat ("fresh chat per
# check" — README's existing rule). No session id is needed since nothing
# crosses turns.

PROXY="${CLH_PROXY:-http://127.0.0.1:3001}"
DEST="${CLH_DEST:-DS4_CLH}"
OBJECT="${CLH_OBJECT:-ZDMS_UPLOAD_FILES}"
PACKAGE="${CLH_PACKAGE:-Z001}"

# ---------------------------------------------------------------------------
# Stage 0 — extract source.txt
# ---------------------------------------------------------------------------
python3 - "$OBJECT" "$PACKAGE" "$DEST" <<'PY' > "$OUT/req-read-source.json"
import json, sys
obj, pkg, dest = sys.argv[1], sys.argv[2], sys.argv[3]
prompt = (
    f"Load the full source of ABAP program `{obj}` (package {pkg}, destination "
    f"{dest}) via MCP. Call ReadProgram, GetIncludesList, and GetInclude exactly "
    "once per artifact.\n\n"
    "Output shape (no other text, no commentary, no summary):\n\n"
    "1. ONE manifest line, FIRST, before any fenced block, of the exact form:\n"
    "   `INVENTORY: <main_name>; <include_1>; <include_2>; ...`\n"
    "   The list of include names MUST match what GetIncludesList returned. If "
    "   GetIncludesList returned zero includes the manifest ends after "
    f"   `INVENTORY: {obj}` (no trailing semicolon, no placeholder).\n"
    "2. THEN one fenced block per artifact listed in the manifest, in the same "
    "   order, each labelled as:\n\n"
    "   ### <file_name> (<type>)\n"
    "   ```abap\n"
    "   <full source as returned by the MCP tool>\n"
    "   ```\n\n"
    "If any read fails, do NOT emit the manifest or any fenced block. Reply with "
    "a single line starting with `STAGE0_ERROR:` followed by the failing tool, "
    "argument and error. The downstream validator refuses to proceed when no "
    "manifest is present, so a partial dump cannot leak into the per-category "
    "prompts."
)
print(json.dumps({"model":"x","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY

echo ">>> Stage 0: extracting source for $OBJECT"
START=$(date +%s)
curl -sN -X POST "$PROXY/v1/chat/completions" \
  -H "Content-Type: application/json" -H "x-sap-destination: $DEST" \
  -d @"$OUT/req-read-source.json" --max-time 900 > "$OUT/resp-read-source.sse"

# Parse SSE: each "data: {...}" line carries an OpenAI delta. Concatenate
# choices[0].delta.content fragments into source.txt.
python3 - "$OUT/resp-read-source.sse" "$OUT/source.txt" <<'PY'
import json, sys
sse, dest = sys.argv[1], sys.argv[2]
out = []
with open(sse, encoding="utf-8", errors="replace") as f:
    for raw in f:
        if not raw.startswith("data:"):
            continue
        payload = raw[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            ev = json.loads(payload)
        except json.JSONDecodeError:
            continue
        for ch in ev.get("choices") or []:
            piece = (ch.get("delta") or {}).get("content")
            if piece:
                out.append(piece)
with open(dest, "w", encoding="utf-8") as f:
    f.write("".join(out))
print(f"    source.txt: {sum(len(p) for p in out)} chars")
PY
echo "    Stage 0 done in $(($(date +%s)-START))s"

# Validate Stage 0 output completely before any per-category call sees it.
# The Stage-0 prompt makes the dump self-describing: the FIRST line is a
# `INVENTORY: main; inc1; inc2; ...` manifest that lists every artifact the
# subsequent fenced blocks must contain. The validator parses the manifest
# and confirms each listed name has a corresponding `### <name> (<type>)`
# heading. Refuse to continue if:
#   - the manifest line is missing
#   - the response starts with `STAGE0_ERROR:` (per-prompt failure marker)
#   - any name from the manifest has no fenced block (partial/truncated dump)
#   - framing text outside fences contains an unmistakable read-error marker.
python3 - "$OUT/source.txt" <<'PY'
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")

problems = []

# 1. Explicit Stage-0 error marker shortcut.
if src.lstrip().startswith("STAGE0_ERROR:"):
    line = src.lstrip().splitlines()[0]
    problems.append(f"Stage 0 reported a tool failure: {line}")

# 2. Manifest line.
m = re.search(r"^\s*INVENTORY:\s*(.+?)\s*$", src, flags=re.MULTILINE)
if not m and not problems:
    problems.append("no `INVENTORY: <main>; <inc>; …` manifest line found")
inventory = []
if m:
    inventory = [n.strip() for n in m.group(1).split(";") if n.strip()]
    if not inventory:
        problems.append("manifest line is empty after `INVENTORY:`")

# 3. Each manifest name must have a CLOSED `### name (type)\n```abap\n…\n``` `
#    block. A bare heading is not enough — Stage 0 output can be truncated
#    after a heading or mid-source by context, token-budget or stream-cut
#    limits, leaving an open fence that a heading-only check would accept.
no_block = []
empty_block = []
for name in inventory:
    pat = re.compile(
        r"^###\s+" + re.escape(name) + r"\s+\([^)]*\)\s*\n```abap\n(.*?)\n```\s*$",
        flags=re.MULTILINE | re.DOTALL,
    )
    m_block = pat.search(src)
    if not m_block:
        no_block.append(name)
    elif not m_block.group(1).strip():
        empty_block.append(name)
if no_block:
    problems.append(f"manifest names without a closed ```abap fence: {no_block}")
if empty_block:
    problems.append(f"manifest names whose fence is empty: {empty_block}")

# 4. Error markers in framing text (outside fences).
framing = re.sub(r"```abap\n.*?```", "", src, flags=re.DOTALL)
err_hits = re.findall(
    r"(?i)\b(error|failed|nicht\s+autorisiert|unauthori[sz]ed|http\s*4\d\d|http\s*5\d\d|forbidden|not\s+found)\b",
    framing,
)
if err_hits:
    problems.append(f"error markers in Stage 0 framing text: {sorted(set(h.lower() for h in err_hits))}")

if problems:
    print("Stage 0 source.txt failed structural validation:", file=sys.stderr)
    for p in problems:
        print(f"  - {p}", file=sys.stderr)
    print(f"  (manifest: {inventory!r}; {len(src)} chars)", file=sys.stderr)
    print("  Inspect resp-read-source.sse and source.txt before re-running.", file=sys.stderr)
    sys.exit(1)

print(f"    source.txt validated: {len(inventory)} artifact(s) — {', '.join(inventory)}")
PY

# ---------------------------------------------------------------------------
# Stage 2-5 — per-category checks, source.txt inlined
# ---------------------------------------------------------------------------
# Per-category rule sets (kept identical to previous iterations — content is
# the part that matters, only the orchestration around them changed).

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
- Use of \`SXPG_COMMAND_EXECUTE\` — not allowed in CleanCore (OS shell access). HIGH.
- Direct DDIC access to standard SAP tables that have a released API alternative.
- Modifications to SAP standard objects (any *_MODI marker).
- Calls to function modules / classes not in the SAP Cloud-released allow-list.
- File operations via \`OPEN DATASET\` against AL11 paths — not allowed in S/4HANA Cloud.
- Use of \`CALL TRANSACTION\` to non-released transactions.
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
- All findings here default to MEDIUM or LOW. CRITICAL / HIGH belong in the other three categories — route there instead."

# Build per-category req-*.json with source.txt inlined as a fenced block.
build_req() {
  local CATEGORY="$1" RULES="$2"
  python3 - "$CATEGORY" "$RULES" "$OUT/source.txt" "$OBJECT" "$PACKAGE" "$DEST" <<'PY' > "$OUT/req-$CATEGORY.json"
import json, sys, pathlib
category, rules, src_path, obj, pkg, dest = sys.argv[1:7]
src = pathlib.Path(src_path).read_text(encoding="utf-8", errors="replace")
prompt = f"""Target: ABAP program `{obj}` in package {pkg}, destination {dest}.

The full source (main + every include) is inlined verbatim at the end of this prompt under the heading "FULL SOURCE BELOW". Cite line numbers and snippets from that block only — do NOT call any MCP read tools, the source is already here.

Perform a **{category}** code review against the inlined source. ONLY this category — do not include findings from other categories.

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

FULL SOURCE BELOW
=================

{src}
"""
print(json.dumps({"model":"x","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY
}

build_req security      "$SEC_RULES"
build_req performance   "$PERF_RULES"
build_req cleancore     "$CLEAN_RULES"
build_req maintainability "$MAINT_RULES"

# Launch 4 in parallel — stateless per call (no x-session-id). Each request
# carries its own copy of the source in the user message.
for CHECK in security performance cleancore maintainability; do
  ( echo ">>> $OBJECT check: $CHECK"
    START=$(date +%s)
    curl -sN -X POST "$PROXY/v1/chat/completions" \
      -H "Content-Type: application/json" -H "x-sap-destination: $DEST" \
      -d @"$OUT/req-$CHECK.json" --max-time 600 > "$OUT/resp-$CHECK.sse"
    echo "    $CHECK done in $(($(date +%s)-START))s, $(wc -c < $OUT/resp-$CHECK.sse) bytes"
  ) &
done
wait
echo "ALL CHECKS DONE"
