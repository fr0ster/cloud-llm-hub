#!/usr/bin/env bash
set -u
OUT=$(dirname "$0")
# 1. Find any other _TO_SFTP wrappers
python3 - <<'PY' > "$OUT/req-to-sftp.json"
import json
prompt = """You have the tool SearchSource. Use it ONCE with these EXACT arguments:

- query: "_TO_SFTP"
- packages: ["Z001"]
- include_subpackages: true
- object_types: ["PROG","FUGR","CLAS"]
- max_objects: 5000
- concurrency: 8
- max_hits_per_object: 20
- emit_no_hits: false
- exclude_comments: true

This catches every reference to `*_TO_SFTP` named artifacts — substring complement to the earlier _FROM_SFTP scan.

Output:
**SearchSource result:**
- total_hits: <N>
- scanned: { packages, objects, sources }
- truncated: { by_object_cap, by_max_objects }

**Hits grouped by object_name:**
- <object_name> (<object_type>, include=<include>): line <L> — <snippet>

Do not call SearchSource more than once."""
print(json.dumps({"model":"x","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY

# 2. Find callers of ZDMS_EXTRACT_DOCS_TO_SFTP
python3 - <<'PY' > "$OUT/req-extract-callers.json"
import json
prompt = """You have the tool SearchSource. Use it ONCE with these EXACT arguments:

- query: "ZDMS_EXTRACT_DOCS_TO_SFTP"
- packages: ["Z001"]
- include_subpackages: true
- object_types: ["PROG","FUGR","CLAS"]
- max_objects: 5000
- concurrency: 8
- max_hits_per_object: 10
- emit_no_hits: false
- exclude_comments: true

Find every caller of FM ZDMS_EXTRACT_DOCS_TO_SFTP in Z001.

Output:
**SearchSource result:**
- total_hits: <N>
- scanned: { packages, objects, sources }
- truncated: { by_object_cap, by_max_objects }

**Callers of ZDMS_EXTRACT_DOCS_TO_SFTP:**
- <object_name> (<object_type>): line <L> — <snippet>

Do not call SearchSource more than once."""
print(json.dumps({"model":"x","stream":True,"stream_options":{"include_usage":True},"messages":[{"role":"user","content":prompt}]}, ensure_ascii=False))
PY

echo ">>> _TO_SFTP scan"
START=$(date +%s)
curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" -d @"$OUT/req-to-sftp.json" --max-time 900 > "$OUT/resp-to-sftp.sse"
echo "    _TO_SFTP done in $(($(date +%s)-START))s"

echo ">>> ZDMS_EXTRACT_DOCS_TO_SFTP callers"
START=$(date +%s)
curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions -H "Content-Type: application/json" -H "x-sap-destination: DS4_CLH" -d @"$OUT/req-extract-callers.json" --max-time 900 > "$OUT/resp-extract-callers.sse"
echo "    callers done in $(($(date +%s)-START))s"
echo "ALL DONE"
