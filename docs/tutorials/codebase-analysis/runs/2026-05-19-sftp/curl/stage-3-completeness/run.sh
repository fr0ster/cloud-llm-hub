#!/usr/bin/env bash
set -u
OUT=$(dirname "$0")
for KEYWORD in "ZSFTP_" "ZFTP_"; do
  python3 - "$KEYWORD" > "$OUT/req-$KEYWORD.json" <<'PY'
import json, sys
kw = sys.argv[1]
prompt = f"""You have the tool SearchSource. Use it ONCE with these EXACT arguments:

- query: "{kw}"
- packages: ["Z001"]
- include_subpackages: true
- object_types: ["PROG","FUGR","CLAS"]
- max_objects: 5000
- concurrency: 8
- max_hits_per_object: 30
- emit_no_hits: false
- exclude_comments: true

This is a completeness sanity scan: catch every reference to {kw}* SM69-command-name literals across customer code in Z001.

Output:
**SearchSource result:**
- total_hits: <N>
- scanned: {{ packages, objects, sources }}
- truncated: {{ by_object_cap, by_max_objects }}

**Distinct object_names with hits:**
- <object_name> (<object_type>): <hit_count> hits — sample line:snippet

Do not call SearchSource more than once."""
print(json.dumps({"model":"x","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY
  echo ">>> sanity scan: $KEYWORD"
  START=$(date +%s)
  curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
    -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" \
    -d @"$OUT/req-$KEYWORD.json" --max-time 900 > "$OUT/resp-$KEYWORD.sse"
  echo "    $KEYWORD done in $(($(date +%s)-START))s, $(wc -c < $OUT/resp-$KEYWORD.sse) bytes"
done
echo "ALL SANITY SCANS DONE"
