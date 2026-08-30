#!/bin/bash

# Smoke test for a deployed cloud-llm-hub on BTP.
# Usage: bash test/test-agent-btp.sh
#
# Exits non-zero if any step fails, so it can gate a deployment. Two traps this
# guards against: an API error is usually valid JSON, so a parsed response proves
# nothing; and Health() answers HTTP 200 even when it reports NOT_READY, so the
# status line proves nothing either. Both the transport status and the payload
# are checked.
#
# Set EXPECT_MCP=1 when the deployment is supposed to have an MCP destination
# configured — then mcpConnected: false fails the run instead of only warning.
#
# Model and provider are NOT script inputs. The application reads them from its
# own environment (LLM_AGENT_MODEL, LLM_AGENT_PROVIDER, ...), so this tests
# whatever the deployment is configured with. Sending a model in the request body
# would hot-swap it for every cached agent, which a smoke test has no business
# doing.

set -o pipefail

BASE_URL="${BASE_URL:-https://your-app.cfapps.eu10.hana.ondemand.com}"
# `cf oauth-token` prints "bearer <jwt>"; the prefix must go, or the header ends
# up as "Bearer bearer <jwt>".
TOKEN="${TOKEN:-$(cf oauth-token 2>/dev/null | sed 's/^bearer //i' || echo '')}"
SAP_DEST="${SAP_DESTINATION:-}"
EXPECT_MCP="${EXPECT_MCP:-}"

failures=0
LAST_BODY=""

# call <label> <curl args...> — prints the body, fails the run on a non-2xx status
call() {
  local label="$1"; shift
  local body status
  body=$(curl -sS -o - -w '\n%{http_code}' "$@" 2>&1) || {
    echo "❌ $label — curl failed"
    failures=$((failures + 1))
    return 1
  }
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"

  if [ "${status:0:1}" != "2" ]; then
    echo "❌ $label — HTTP $status"
    echo "$body" | head -20
    failures=$((failures + 1))
    return 1
  fi

  LAST_BODY="$body"
  echo "$body" | jq '.' 2>/dev/null || echo "$body"
  return 0
}

# fail <message> — record a failure with a reason
fail() {
  echo "❌ $1"
  failures=$((failures + 1))
}

echo "🧪 Testing cloud-llm-hub on BTP"
echo "================================"
echo "Base URL: $BASE_URL"
if [ -n "$SAP_DEST" ]; then
  echo "SAP Destination: $SAP_DEST (ABAP tools will be exercised)"
else
  echo "SAP Destination: not set (LLM only)"
fi
echo ""

if [ -z "$TOKEN" ]; then
  echo "❌ No XSUAA token. Get one with: cf oauth-token"
  echo "   or export TOKEN='<your-xsuaa-token>'"
  exit 1
fi

# 1. Health — reports the server's own configuration; request headers are ignored
echo "1️⃣ Health..."
if call "Health" -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json"
then
  # Health answers 200 for NOT_READY too, so the payload decides.
  # `// "missing"` would report a legitimate false as missing — jq treats false
  # as empty for that operator. tostring keeps false, true and null distinct.
  health_status=$(echo "$LAST_BODY" | jq -r '.status | tostring' 2>/dev/null)
  agent_ready=$(echo "$LAST_BODY" | jq -r '.agentReady | tostring' 2>/dev/null)
  mcp_connected=$(echo "$LAST_BODY" | jq -r '.mcpConnected | tostring' 2>/dev/null)

  [ "$health_status" = "READY" ] || fail "Health reports status=$health_status"
  [ "$agent_ready" = "true" ] || fail "Health reports agentReady=$agent_ready"

  if [ "$mcp_connected" != "true" ]; then
    if [ -n "$EXPECT_MCP" ]; then
      fail "Health reports mcpConnected=$mcp_connected, but EXPECT_MCP is set"
    else
      echo "ℹ️  mcpConnected=$mcp_connected — expected unless LLM_AGENT_MCP_DESTINATION is configured and initialized"
    fi
  fi
fi
echo ""

# 2. LLM only, through the legacy OData Chat. That path never enters the
#    per-request connection scope, so it cannot call ABAP tools — which is
#    exactly what makes it a clean LLM-only check.
echo "2️⃣ Chat (LLM only)..."
call "Chat (LLM only)" -X GET \
  "$BASE_URL/odata/v4/agent/Chat(message='Reply with the word OK')" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json"
echo ""

# 3. ABAP tools, through /v1 — the only path that builds the per-request
#    connection from the x-sap-* headers. The question is one the model cannot
#    answer without actually calling a tool.
if [ -n "$SAP_DEST" ]; then
  echo "3️⃣ Chat (ABAP tools via /v1)..."
  call "Chat (ABAP tools)" -X POST \
    "$BASE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-SAP-Destination: $SAP_DEST" \
    -d '{"messages":[{"role":"user","content":"List the ABAP classes in package $TMP"}]}'
  echo ""
else
  echo "3️⃣ Chat (ABAP tools) — skipped."
  echo "   export SAP_DESTINATION='SAP_DEV_DEST' to exercise the tools."
  echo ""
fi

if [ "$failures" -gt 0 ]; then
  echo "❌ $failures step(s) failed."
  exit 1
fi

echo "✅ All steps passed."
echo ""
echo "💡 Notes:"
echo "   - The provider and model come from the app's environment, not from here."
echo "     To change them: cf set-env cloud-llm-hub-srv LLM_AGENT_MODEL '<model>'"
echo "     followed by cf restart cloud-llm-hub-srv"
echo "   - SAP_DESTINATION selects the ABAP system for step 3 (optional)"
echo "   - EXPECT_MCP=1 turns mcpConnected: false into a failure rather than a note"
echo "   - Install jq for readable output"
echo ""
echo "📚 Full guide: docs/deployment/TESTING_AFTER_DEPLOYMENT.md"
