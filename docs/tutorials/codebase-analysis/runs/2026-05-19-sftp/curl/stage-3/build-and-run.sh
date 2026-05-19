#!/usr/bin/env bash
set -u
OUT=$(dirname "$0")

write_req() {
  local file="$1" prompt="$2"
  python3 - "$prompt" > "$file" <<'PY'
import json, sys
print(json.dumps({"model":"x","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":sys.argv[1]}]}, ensure_ascii=False))
PY
}

write_req "$OUT/request-A.json" "You have the tool \`SearchSource\`. Use it ONCE: query=\"SXPG_COMMAND_EXECUTE\", query2=\"HOST_KEY\", package=\"Z001\", include_subpackages=true, max_objects=2000. This AND-match finds every ABAP object in Z001 that both shells out via SXPG and references an SFTP host-key parameter — i.e. SFTP-via-OS code sites specifically, excluding non-SFTP SXPG usage.

Output:
**SearchSource result:** total_hits, objects_scanned, packages_scanned, truncated_flag
**Hits grouped by object name:** for each unique object, list its lines and snippets (one bullet per hit line)

Do not call SearchSource more than once with the same arguments. Stop tool calling after one SearchSource invocation."

write_req "$OUT/request-B.json" "You have the tool \`SearchSource\`. Use it ONCE: query=\"ZMEDI_GET_FROM_SFTP\", package=\"Z001\", include_subpackages=true, max_objects=2000. This finds every ABAP caller of the GET wrapper function module.

Output:
**SearchSource result:** total_hits, objects_scanned
**Callers grouped by object:** for each caller object, list its lines and snippets that invoke ZMEDI_GET_FROM_SFTP

Do not call SearchSource more than once. Stop tool calling after one invocation."

write_req "$OUT/request-C.json" "You have the tool \`SearchSource\`. Use it ONCE: query=\"ZMEDI_PUT_FROM_SFTP\", package=\"Z001\", include_subpackages=true, max_objects=2000. This finds every ABAP caller of the PUT wrapper function module.

Output:
**SearchSource result:** total_hits, objects_scanned
**Callers grouped by object:** for each caller object, list its lines and snippets that invoke ZMEDI_PUT_FROM_SFTP

Do not call SearchSource more than once. Stop tool calling after one invocation."

for letter in A B C; do
  ( echo ">>> Stage 3 query $letter"
    START=$(date +%s)
    curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
      -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" \
      -d @"$OUT/request-$letter.json" --max-time 900 > "$OUT/response-$letter.sse"
    echo "    $letter done in $(($(date +%s)-START))s, $(wc -c < $OUT/response-$letter.sse) bytes"
  ) &
done
wait
echo "ALL QUERIES DONE"
