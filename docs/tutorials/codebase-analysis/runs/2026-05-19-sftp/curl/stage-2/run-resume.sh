#!/usr/bin/env bash
set -u
# Resume from seed #4 — seeds #1-#3 already complete (response-01..03.sse).
SEEDS_ALL=(
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
for i in 3 4 5 6 7 8 9 10 11 12; do
  NN=$(printf "%02d" $((i+1)))
  SEED="${SEEDS_ALL[$i]}"
  echo ">>> [$NN/13] $SEED"
  python3 - "$SEED" > "$OUT/request-$NN.json" <<'PY'
import json, sys
seed = sys.argv[1]
prompt = f"""I am analyzing how ABAP object `{seed}` interacts with SFTP — one of 13 seeds in a migration analysis. Source destination is DS4_CLH.

Procedure (stay on the object itself; cross-package wrapper hunt is a later stage):
1. `SearchObject('{seed}')` — confirm the object exists and identify its type and package. If 0 results: verdict is `not-found`, show the literal tool output and stop.
2. Read main source by type: `ReadProgram` for PROG, `ReadClass` for CLAS, `ReadFunctionGroup` for FUGR.
3. If PROG: call `GetIncludesList('{seed}')`. For EACH include returned, call `GetInclude(<include_name>)` and read its source. Do not skip any include.
4. Do NOT run package-wide `SearchSource`. The verdict for this stage must be based on the object's own source and its includes only.

Output exactly this shape:

**Verdict:** yes / no / unclear / not-found
**Type:** PROG / CLAS / FUGR / FUNC / ...
**SFTP methods / mechanisms:**
- list of function modules, classes, or SM69 commands that actually move data over SFTP, each backed by source evidence
**Evidence (program_or_include:line — snippet):**
- ...
**Notes:** direction (push/pull), endpoint/host hints, payload role — only when source proves it.

Rules:
- `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` with parameters assembling FTP_USER, FTP_DOMAIN, FTP_HOST, HOST_KEY, PRIVATE_KEY_PATH, PASSPHRASE, or any SSH_* key = **yes** (legacy OS-shell SFTP via SM69; record the SM69 command name as the method).
- A `PERFORM f_*_sftp` whose implementation you have NOT read is NOT evidence. Read the include where the form is defined.
- Emit `unclear` only when a specific `GetInclude(...)` returned null — and name that include.
- `OPEN DATASET`, `GUI_UPLOAD`, `GUI_DOWNLOAD` are local-file I/O, not SFTP — verdict `no` unless paired with an SFTP-credential SXPG call.
- Be concise; every claim cites a source location."""
print(json.dumps({"model":"anthropic--claude-4.5-sonnet","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY
  START=$(date +%s)
  curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
    -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" \
    -d @"$OUT/request-$NN.json" --max-time 600 > "$OUT/response-$NN.sse"
  echo "    $SEED done in $(($(date +%s)-START))s, $(wc -c < $OUT/response-$NN.sse) bytes"
done
echo "ALL DONE"
