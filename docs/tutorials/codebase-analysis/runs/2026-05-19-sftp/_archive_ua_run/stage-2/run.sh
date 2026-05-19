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
  "ZFIU_ACC_POST"
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
import json,sys
seed=sys.argv[1]
prompt=f"""Я аналізую як ABAP-об'єкт `{seed}` працює зі SFTP — це один із 13 сідів міграційного аналізу.

Зроби це так:
1. SearchObject щоб підтвердити, що об'єкт існує і який його тип.
2. ReadProgram / ReadClass / ReadFunction (за типом) щоб прочитати джерело.
3. SearchSource по пакету об'єкта, якшо треба підтвердити патерн.

Дай висновок з доказами зі сорсу:

**Verdict:** yes / no / unclear
**Тип:** PROG / CLAS / FUGR / FUNC / ...
**SFTP-методи / механізми:**
- список FM, класів, або SM69-команд, що реально працюють зі SFTP

**Докази (file:line — snippet):**
- ...

**Замітки:** напрямок (push/pull), endpoint/host hints, що читається/пишеться — якшо джерело каже.

Правила:
- Якшо `SXPG_COMMAND_EXECUTE` асемблює FTP_USER / SSH_* / HOST_KEY / PRIVATE_KEY_PATH / PASSPHRASE — це **yes**, legacy OS-shell SFTP через SM69 (запиши SM69-команду як метод).
- Без доказів зі сорсу → unclear. Ім'я об'єкта не доказ.
- Звітуй стисло, але кожне твердження — джерело."""
print(json.dumps({
  "model":"anthropic--claude-4.5-sonnet",
  "stream":True,
  "stream_options":{"include_usage":True},
  "messages":[{"role":"user","content":prompt}]
}, ensure_ascii=False))
PY
  START=$(date +%s)
  curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "x-sap-destination: DS4_CLH" \
    -d @"$OUT/request-$NN.json" \
    --max-time 900 > "$OUT/response-$NN.sse"
  END=$(date +%s)
  echo "    ${SEED} done in $((END-START))s, $(wc -c < $OUT/response-$NN.sse) bytes"
done
echo "ALL DONE"
