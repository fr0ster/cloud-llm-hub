#!/usr/bin/env bash
set -u
SEEDS=(
  "ZSFTP_CAPARIO_PULL"
  "ZSFTP_BNP_PARIBAS_PULL"
  "ZSFTP_PATIENTCO_PULL"
  "ZSFTP_CAPARIO"
  "ZFFIU_ACC_POST"
  "ZDMS_UPLOAD_FILES"
  "ZSD_MEDICARE_PDF_PROCESS"
  "ZSFTP_CITI_PULL"
)
OUT=$(dirname "$0")
for i in "${!SEEDS[@]}"; do
  NN=$(printf "%02d" $((i+1)))
  SEED="${SEEDS[$i]}"
  echo ">>> [$NN/8] $SEED"
  python3 - "$SEED" > "$OUT/request-$NN.json" <<'PY'
import json, sys
seed = sys.argv[1]
prompt = f"""Object `{seed}` is an ABAP program in package Z001 on destination DS4_CLH. It is known to interact with SFTP. I need an exhaustive enumeration of EVERY mechanism this report uses to read from or write to SFTP. Assume nothing. Do not pre-filter by any specific pattern (no preference for SXPG, no preference for any class, no preference for any function module).

Procedure:
1. `ReadProgram('{seed}')` — main source.
2. `GetIncludesList('{seed}')` — recursive include list (this tool IS available; call it).
3. For EACH include name returned, call `GetInclude(<include_name>)` and read it.

After reading every artifact (main + all includes), enumerate every distinct mechanism that touches SFTP. Treat ALL of the following as candidate mechanisms — list whichever ones the source actually uses, plus anything else you see:

- `SXPG_COMMAND_EXECUTE` (legacy shell-out via SM69)
- `CALL 'SYSTEM' ID 'COMMAND' ...` (kernel-level shell-out)
- Any FTP_* / SFTP_* function module of any name (`Z*`, `Y*`, custom)
- ABAP class-based SSH/SFTP clients (e.g. `CL_*SSH*`, `CL_*SFTP*`, `CL_*FTP*` — list whatever name appears)
- `CL_GUI_FRONTEND_SERVICES` file operations followed by an external step
- `OPEN DATASET` to a network-mounted path (note as candidate but flag as not-necessarily-SFTP unless paired with credentials/host)
- Background job submissions that invoke external scripts
- HTTP/REST/SOAP calls to an SFTP-gateway service
- Anything else

For each mechanism found, output:

### <mechanism-name>
- **kind:** shell-out / native ABAP class / FM / HTTP-gateway / other
- **direction:** push / pull / both / unknown (from source only)
- **artifact:** the SM69 command name / FM name / class name / URL path
- **call sites:** program_or_include:line — snippet
- **credentials/host source:** where in source the credentials and host come from (e.g. `zfi_constants` rows, hardcoded literal, environment, RFC destination)
- **payload role:** what business artifact is moved (only if source proves it; otherwise "unknown")

End with a one-line **Summary:** listing all mechanism artifacts as a comma-separated set, e.g. `Summary: SXPG[ZSFTP_CITI_PULL], SXPG[ZFTP_EOB_PULL]`.

Rules:
- Cite source for every claim.
- A `PERFORM` with an SFTP-suggestive name whose body you have NOT read is NOT a mechanism — read the include first.
- `OPEN DATASET` / `GUI_UPLOAD` / `GUI_DOWNLOAD` alone (no host/credentials/external step) is NOT SFTP — exclude.
- If `GetInclude(X)` returns null, list X as a blind spot."""
print(json.dumps({"model":"anthropic--claude-4.5-sonnet","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY
  START=$(date +%s)
  curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
    -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" \
    -d @"$OUT/request-$NN.json" --max-time 600 > "$OUT/response-$NN.sse"
  echo "    $SEED done in $(($(date +%s)-START))s, $(wc -c < $OUT/response-$NN.sse) bytes"
done
echo "ALL DONE"
