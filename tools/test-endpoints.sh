#!/usr/bin/env bash
# Test all cloud-llm-hub endpoints: MCP, OpenAI, Anthropic.
#
# Usage:
#   ./tools/test-endpoints.sh              # uses mcp.env for auth
#   SRV_URL=http://localhost:4004 ./tools/test-endpoints.sh  # local dev

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load mcp.env
if [[ -f "$PROJECT_DIR/mcp.env" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="$(echo "$key" | xargs)"
    [[ -z "$key" ]] && continue
    export "$key=$value"
  done < "$PROJECT_DIR/mcp.env"
fi

# Resolve service URL
if [[ -z "${SRV_URL:-}" ]]; then
  SRV_URL="https://$(cf app cloud-llm-hub-srv 2>/dev/null | grep 'routes:' | awk '{print $2}')"
fi
TOKEN="${XSUAA_JWT_TOKEN:?XSUAA_JWT_TOKEN not set}"

PASS=0
FAIL=0
TOTAL=0

check() {
  local name="$1" status="$2" body="$3" expect_status="$4" expect_body="${5:-}"
  TOTAL=$((TOTAL + 1))
  local ok=true

  if [[ "$status" != "$expect_status" ]]; then
    ok=false
  fi
  if [[ -n "$expect_body" && ! "$body" == *"$expect_body"* ]]; then
    ok=false
  fi

  if $ok; then
    PASS=$((PASS + 1))
    echo "  PASS  $name (HTTP $status)"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL  $name — expected HTTP $expect_status, got $status"
    echo "        body: ${body:0:200}"
  fi
}

echo "Testing cloud-llm-hub at $SRV_URL"
echo "================================================"

# --- Health / Models ---
echo ""
echo "--- Basic endpoints ---"

resp=$(curl -s -w "\n%{http_code}" "$SRV_URL/v1/models" -H "Authorization: Bearer $TOKEN")
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -1)
check "GET /v1/models" "$status" "$body" "200" "data"

# --- MCP StreamableHTTP ---
echo ""
echo "--- MCP (StreamableHTTP) ---"

resp=$(curl -s -w "\n%{http_code}" -X POST "$SRV_URL/mcp/stream/http" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}')
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -1)
check "POST /mcp/stream/http (initialize)" "$status" "$body" "200" "protocolVersion"

# --- OpenAI Chat Completions ---
echo ""
echo "--- OpenAI (/v1/chat/completions) ---"

resp=$(curl -s -w "\n%{http_code}" -X POST "$SRV_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in one word"}]}')
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -1)
check "POST /v1/chat/completions (non-streaming)" "$status" "$body" "200" "chat.completion"

# Streaming
resp=$(curl -s -w "\n%{http_code}" -N -X POST "$SRV_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi"}],"stream":true}')
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -1)
check "POST /v1/chat/completions (streaming)" "$status" "$body" "200" "data:"

# --- Anthropic Messages ---
echo ""
echo "--- Anthropic (/v1/messages) ---"

resp=$(curl -s -w "\n%{http_code}" -X POST "$SRV_URL/v1/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"smart-agent","max_tokens":256,"messages":[{"role":"user","content":"Say hello in one word"}]}')
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -1)
check "POST /v1/messages (non-streaming)" "$status" "$body" "200" '"type":"message"'

# Streaming
resp=$(curl -s -w "\n%{http_code}" -N -X POST "$SRV_URL/v1/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"smart-agent","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Say hi"}]}')
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -1)
check "POST /v1/messages (streaming)" "$status" "$body" "200" "message_start"

# --- Auth checks ---
echo ""
echo "--- Auth (should reject) ---"

resp=$(curl -s -w "\n%{http_code}" -X POST "$SRV_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -d '{"model":"x","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}')
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -1)
check "POST /v1/messages (no auth → 401)" "$status" "$body" "401"

# --- Summary ---
echo ""
echo "================================================"
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
