#!/bin/bash

# Cloud LLM Hub - Cloud Endpoint Smoke Tests
#
# Tests all cloud endpoints: OData services, MCP proxy, OpenAI-compatible LLM agent
#
# Prerequisites:
#   - App deployed to BTP Cloud Foundry
#   - JWT token obtained via one of:
#     a) mcp-auth: npm run get:key && npm run get:token  (saves to service.env)
#     b) Manual: set TEST_JWT_XSUAA in .env
#
# Usage:
#   ./test-cloud-endpoints.sh [base-url]
#
# Example:
#   ./test-cloud-endpoints.sh https://your-app.cfapps.eu10.hana.ondemand.com

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Load env files via node dotenv (handles $, quotes, multiline correctly)
eval "$(node -e "
  const dotenv = require('dotenv');
  const fs = require('fs');
  const root = '$PROJECT_ROOT';
  for (const f of ['service.env', '.env']) {
    const p = root + '/' + f;
    if (fs.existsSync(p)) {
      const vars = dotenv.parse(fs.readFileSync(p));
      for (const [k, v] of Object.entries(vars)) {
        // Use single quotes to prevent bash variable expansion (escape inner single quotes)
        const escaped = v.replace(/'/g, \"'\\\\''\" );
        process.stdout.write('export ' + k + \"='\" + escaped + \"'\\n\");
      }
    }
  }
" 2>/dev/null)"

BASE_URL="${1:-${TEST_BASE_URL:-}}"
# Prefer TEST_JWT_XSUAA (manual), fallback to XSUAA_JWT_TOKEN (mcp-auth)
JWT="${TEST_JWT_XSUAA:-${XSUAA_JWT_TOKEN:-}}"
DESTINATION="${TEST_MCP_DESTINATION:-S4HANA_DEV}"

# Auto-detect BASE_URL from CF if not provided
if [ -z "$BASE_URL" ]; then
  BASE_URL=$(cf env cloud-llm-hub-srv 2>/dev/null \
    | grep -A1 '"application_uris"' \
    | tail -1 \
    | tr -d ' ",' \
    || true)
  if [ -n "$BASE_URL" ]; then
    BASE_URL="https://$BASE_URL"
    echo "Auto-detected URL from CF: $BASE_URL"
  else
    echo "ERROR: Base URL required. Pass as argument, set TEST_BASE_URL in .env, or log in to CF"
    echo "Usage: $0 <base-url>"
    exit 1
  fi
fi

if [ -z "$JWT" ]; then
  echo "ERROR: No JWT token found."
  echo "  Option 1: npm run get:key && npm run get:token  (creates service.env)"
  echo "  Option 2: Set TEST_JWT_XSUAA in .env"
  exit 1
fi

AUTH="Bearer $JWT"
PASS=0
FAIL=0
SKIP=0

# Helper: run a test
run_test() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_code="$4"
  local content_type="${5:-application/json}"
  local body="${6:-}"

  printf "%-50s " "$name"

  local curl_args=(-s -o /tmp/test_response.json -w "%{http_code}" \
    -H "Authorization: $AUTH" \
    -H "Accept: application/json")

  if [ "$method" = "POST" ]; then
    curl_args+=(-X POST -H "Content-Type: $content_type")
    if [ -n "$body" ]; then
      curl_args+=(--data "$body")
    fi
  fi

  local http_code
  http_code=$(curl "${curl_args[@]}" "$url" 2>/dev/null || echo "000")

  if echo "$expected_code" | grep -q "$http_code"; then
    echo "PASS ($http_code)"
    PASS=$((PASS + 1))
  else
    echo "FAIL (expected $expected_code, got $http_code)"
    cat /tmp/test_response.json 2>/dev/null | head -c 200
    echo ""
    FAIL=$((FAIL + 1))
  fi
}

echo "============================================"
echo "Cloud LLM Hub - Endpoint Smoke Tests"
echo "============================================"
echo "URL:         $BASE_URL"
echo "Destination: $DESTINATION"
echo "Token:       ${JWT:0:20}..."
echo "============================================"
echo ""

# ==========================================
# 1. OData Services
# ==========================================
echo "--- OData Services ---"

run_test "Auth: CheckAuth" \
  GET "$BASE_URL/odata/v4/auth/CheckAuth()" "200"

run_test "MCP: Health" \
  GET "$BASE_URL/odata/v4/mcp/Health()" "200"

run_test "MCP: ProbeDestination" \
  GET "$BASE_URL/odata/v4/mcp/ProbeDestination(destination='$DESTINATION')" "200"

run_test "Agent: Health" \
  GET "$BASE_URL/odata/v4/agent/Health()" "200"

# Override AUTH for this one test
AUTH_SAVE="$AUTH"
AUTH=""
printf "%-50s " "Auth: no token (expect 401)"
http_code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/odata/v4/auth/CheckAuth()" 2>/dev/null || echo "000")
if [ "$http_code" = "401" ]; then
  echo "PASS ($http_code)"
  PASS=$((PASS + 1))
else
  echo "FAIL (expected 401, got $http_code)"
  FAIL=$((FAIL + 1))
fi
AUTH="$AUTH_SAVE"

echo ""

# ==========================================
# 2. MCP Proxy (Stream HTTP)
# ==========================================
echo "--- MCP Proxy (Stream HTTP) ---"

# MCP Initialize (requires X-SAP-Destination header)
MCP_INIT_BODY='{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0.0"}}}'
printf "%-50s " "MCP: Initialize"
http_code=$(curl -s -D /tmp/test_headers.txt -o /tmp/test_response.json -w "%{http_code}" \
  -H "Authorization: $AUTH" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-SAP-Destination: $DESTINATION" \
  -X POST \
  --data "$MCP_INIT_BODY" \
  "$BASE_URL/mcp/stream/http" 2>/dev/null || echo "000")
if [ "$http_code" = "200" ]; then
  echo "PASS ($http_code)"
  PASS=$((PASS + 1))
else
  echo "FAIL (expected 200, got $http_code)"
  cat /tmp/test_response.json 2>/dev/null | head -c 200
  echo ""
  FAIL=$((FAIL + 1))
fi

# Extract session ID from response headers
MCP_SESSION_ID=$(grep -i "mcp-session-id" /tmp/test_headers.txt 2>/dev/null | tr -d '\r' | awk '{print $2}' || true)

if [ -n "$MCP_SESSION_ID" ]; then
  echo "  Session ID: ${MCP_SESSION_ID:0:20}..."

  # MCP List Tools (with session)
  printf "%-50s " "MCP: List Tools"
  http_code=$(curl -s -o /tmp/test_response.json -w "%{http_code}" \
    -H "Authorization: $AUTH" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-SAP-Destination: $DESTINATION" \
    -H "Mcp-Session-Id: $MCP_SESSION_ID" \
    -X POST \
    --data '{"jsonrpc":"2.0","id":"2","method":"tools/list"}' \
    "$BASE_URL/mcp/stream/http" 2>/dev/null || echo "000")
  if [ "$http_code" = "200" ]; then
    tool_count=$(cat /tmp/test_response.json 2>/dev/null | grep -o '"name"' | wc -l || echo "?")
    echo "PASS ($http_code, $tool_count tools)"
    PASS=$((PASS + 1))
  else
    echo "FAIL (expected 200, got $http_code)"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  SKIP: No session ID, skipping tools/list"
  SKIP=$((SKIP + 1))
fi

echo ""

# ==========================================
# 3. OpenAI-compatible LLM Agent
# ==========================================
echo "--- OpenAI-compatible LLM Agent ---"

run_test "LLM: GET /v1/models" \
  GET "$BASE_URL/v1/models" "200"

run_test "LLM: GET /v1/usage" \
  GET "$BASE_URL/v1/usage" "200"

# Chat completions (non-streaming)
run_test "LLM: POST /v1/chat/completions" \
  POST "$BASE_URL/v1/chat/completions" "200" "application/json" \
  '{"messages":[{"role":"user","content":"Say hello in one word"}],"stream":false}'

# Chat completions (streaming)
printf "%-50s " "LLM: POST /v1/chat/completions (stream)"
http_code=$(curl -s -o /tmp/test_response_stream.txt -w "%{http_code}" \
  -H "Authorization: $AUTH" \
  -H "Content-Type: application/json" \
  -X POST \
  --data '{"messages":[{"role":"user","content":"Say hi in one word"}],"stream":true}' \
  "$BASE_URL/v1/chat/completions" 2>/dev/null || echo "000")
if [ "$http_code" = "200" ]; then
  has_done=$(grep -c "\[DONE\]" /tmp/test_response_stream.txt 2>/dev/null || echo "0")
  if [ "$has_done" -gt 0 ]; then
    echo "PASS ($http_code, stream complete)"
  else
    echo "PASS ($http_code, stream partial)"
  fi
  PASS=$((PASS + 1))
else
  echo "FAIL (expected 200, got $http_code)"
  FAIL=$((FAIL + 1))
fi

echo ""

# ==========================================
# Summary
# ==========================================
echo "============================================"
TOTAL=$((PASS + FAIL + SKIP))
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped (total: $TOTAL)"
echo "============================================"

# Cleanup
rm -f /tmp/test_response.json /tmp/test_response_stream.txt /tmp/test_headers.txt

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
