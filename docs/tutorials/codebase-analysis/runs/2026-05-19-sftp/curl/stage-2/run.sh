#!/usr/bin/env bash
set -u
SEEDS=(
  "/VERTEX/SPOT_VAT_OUTPUT_COMPL"
  "/VERTEX/SPOT_VAT_INPUT_COMPL"
  "ZEDI_835"
  "ZSFTP_CAPARIO_PULL"
  "ZFI_BANK_STMT_LOAD"
  "ZSFTP_BNP_PARIBAS_PULL"
  "ZSFTP_PATIENTCO_PULL"
  "ZSFTP_CAPARIO"
  "ZFFIU_ACC_POST"
  "ZEDI_835_JPM"
  "ZDMS_UPLOAD_FILES"
  "ZSD_MEDICARE_PDF_PROCESS"
  "ZSFTP_CITI_PULL"
)
OUT=$(dirname "$0")
for i in "${!SEEDS[@]}"; do
  NN=$(printf "%02d" $((i+1)))
  SEED="${SEEDS[$i]}"
  echo ">>> [$NN/13] $SEED"
  python3 - "$SEED" > "$OUT/request-$NN.json" <<'PY'
import json, sys
seed = sys.argv[1]
prompt = f"""I am analyzing how ABAP object `{seed}` interacts with SFTP — one of 13 seeds in a migration analysis. Source destination is DS4_CLH.

Procedure:
1. `SearchObject('{seed}')` — confirm the object exists and identify its type and package. If 0 results: verdict is `not-found`, show the literal tool output and stop.
2. Read the main source by type: `ReadProgram` for PROG, `ReadClass` for CLAS, `ReadFunctionGroup` for FUGR.
3. If it is a PROG: call `GetIncludesList('{seed}')` to list every include, then call `GetInclude(<include_name>)` for EACH entry in that list. Read every include before forming a verdict.
4. `SearchSource` in the object's package with queries `SXPG_COMMAND_EXECUTE`, `SFTP`, `FTP`, `SSH` to catch wrappers outside the main program.

Then output, in this exact shape:

**Verdict:** yes / no / unclear / not-found
**Type:** PROG / CLAS / FUGR / FUNC / ...
**SFTP methods / mechanisms:**
- list of function modules, classes, or SM69 commands that actually move data over SFTP, each backed by source evidence
**Evidence (program_or_include:line — snippet):**
- ...
**Notes:** direction (push/pull), endpoint/host hints, payload role (what business artifact is read/written) — only when source proves it.

Rules:
- `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` with parameters assembling FTP_USER, FTP_DOMAIN, FTP_HOST, HOST_KEY, PRIVATE_KEY_PATH, PASSPHRASE, or any SSH_* key = **yes** (legacy OS-shell SFTP via SM69; record the SM69 command name as the method).
- A `PERFORM f_*_sftp` whose implementation you have NOT read is NOT evidence. Read the include where the form lives.
- Do not emit `unclear` if every include returned source. Only emit `unclear` when a specific `GetInclude(...)` returned null — and in that case name the include.
- Be concise but every claim must cite a source location."""
print(json.dumps({"model":"anthropic--claude-4.5-sonnet","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY
  START=$(date +%s)
  curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
    -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" \
    -d @"$OUT/request-$NN.json" --max-time 900 > "$OUT/response-$NN.sse"
  echo "    $SEED done in $(($(date +%s)-START))s, $(wc -c < $OUT/response-$NN.sse) bytes"
done
echo "ALL DONE"
