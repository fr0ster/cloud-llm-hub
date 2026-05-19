#!/usr/bin/env bash
set -u
SEEDS=(
  "ZSFTP_BNP_PARIBAS_WITH_PGP"
  "ZSFTP_CERIDIAN_PULL"
  "ZSFTP_CITI_SEND"
  "ZSFTP_JPM"
  "ZSFTP_JPM_PULL"
)
OUT=$(dirname "$0")
for i in "${!SEEDS[@]}"; do
  NN=$(printf "%02d" $((i+1)))
  SEED="${SEEDS[$i]}"
  echo ">>> [$NN/${#SEEDS[@]}] $SEED"
  python3 - "$SEED" > "$OUT/request-$NN.json" <<'PY'
import json, sys
seed = sys.argv[1]
prompt = f"""You have the tools `ReadProgram`, `GetIncludesList`, `GetInclude`. They are all available — call them.

Verify that ABAP report `{seed}` is an SFTP usage site, with code evidence. Procedure (each step exactly ONCE):

1. ReadProgram('{seed}') — main source.
2. GetIncludesList('{seed}') — list of includes (call exactly once).
3. For EACH include name returned, call GetInclude(<include_name>) exactly once. Do not re-call GetIncludesList. Do not call any tool more than once with the same arguments.

Then output:

**Verdict:** yes / no / unclear
**Type:** PROG
**SM69 command / FM mechanism used:** <name from p_comm default or hardcoded literal>
**Evidence (program_or_include:line — snippet):**
- the SXPG_COMMAND_EXECUTE call site (or wrapper FM call)
- the parameter assembly (zfi_constants reads for FTP_USER, FTP_DOMAIN, HOST_KEY, etc.)
- the PARAMETERS p_comm DEFAULT line if present
**Notes:** direction (push/pull), business artifact moved — only when source proves it.

Rules:
- SXPG_COMMAND_EXECUTE with FTP_USER/HOST_KEY/PRIVATE_KEY_PATH credential parameters = yes.
- A call to a Z function module like `ZMEDI_GET_FROM_SFTP` or `ZERX_GET_FROM_SFTP` counts as yes (those FMs are SXPG wrappers).
- A PERFORM with an SFTP-suggestive name whose body you have NOT read is NOT evidence.
- Stop tool calling once steps 1-3 are done."""
print(json.dumps({"model":"x","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY
  START=$(date +%s)
  curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
    -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" \
    -d @"$OUT/request-$NN.json" --max-time 600 > "$OUT/response-$NN.sse"
  echo "    $SEED done in $(($(date +%s)-START))s, $(wc -c < $OUT/response-$NN.sse) bytes"
done
echo "ALL DONE"
