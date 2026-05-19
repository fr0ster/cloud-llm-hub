#!/usr/bin/env bash
set -u
SEEDS=("ZEDI_835" "ZFI_BANK_STMT_LOAD" "ZDMS_UPLOAD_FILES" "ZSD_MEDICARE_PDF_PROCESS")
OUT=$(dirname "$0")
for i in "${!SEEDS[@]}"; do
  NN=$(printf "%02d" $((i+1)))
  SEED="${SEEDS[$i]}"
  echo ">>> [$NN/${#SEEDS[@]}] $SEED"
  python3 - "$SEED" > "$OUT/request-$NN.json" <<'PY'
import json, sys
seed = sys.argv[1]
prompt = f"""Повний аналіз `{seed}` на предмет SFTP. У попередньому проході відповідь була unclear, бо include-код не читався. Тепер зроби глибокий read:

1. `SearchObject('{seed}')` — підтвердити тип і пакет.
2. `ReadProgram('{seed}')` — головний sorce.
3. `GetIncludesList('{seed}')` — перелік усіх includes.
4. Для **КОЖНОГО** include з кроку 3: `GetInclude(<include_name>)` — повний sorce інклюда.
5. `SearchSource` в пакеті обʼєкта по ключових словах SXPG_COMMAND_EXECUTE, SFTP, FTP, SSH — щоб не пропустити wrapper-и поза головною програмою.

Після цього дай висновок ОДНОЗНАЧНО — yes або no. unclear допускається тільки якщо який-небудь GetInclude теж повернув null (тоді скажи, який саме).

**Verdict:** yes / no / unclear  
**Тип:** PROG / CLAS / FUGR / ...  
**SFTP-методи / механізми:** список FM / класів / SM69-команд із доказами.  
**Докази (program_or_include:line — snippet):** ...  
**Замітки:** direction (push/pull), endpoint/host hints, payload role — якшо джерело каже.

Правила:
- `SXPG_COMMAND_EXECUTE` + FTP_*/SSH_*/HOST_KEY/PRIVATE_KEY_PATH/PASSPHRASE = **yes** (legacy OS-shell SFTP).
- `PERFORM f_*_sftp` без реалізації — не доказ. Дивись у include, де ця форма реалізована.
- Без читання усіх includes — не виголошувати yes/no."""
print(json.dumps({"model":"anthropic--claude-4.5-sonnet","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY
  START=$(date +%s)
  curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
    -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" \
    -d @"$OUT/request-$NN.json" --max-time 900 > "$OUT/response-$NN.sse"
  echo "    $SEED done in $(($(date +%s)-START))s, $(wc -c < $OUT/response-$NN.sse) bytes"
done
echo "ALL DONE"
