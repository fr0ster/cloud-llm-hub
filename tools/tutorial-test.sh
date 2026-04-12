#!/usr/bin/env bash
# Tutorial step tester — sends a prompt to cloud-llm-hub staging and shows the response.
# Usage: ./tools/tutorial-test.sh "Your prompt here"
# Env: STAGING_TOKEN (OAuth token), STAGING_URL (API base URL)

set -euo pipefail

STAGING_URL="${STAGING_URL:-https://acme-subaccount-cloud-llm-hub.cfapps.eu10.hana.ondemand.com}"
SESSION_FILE="/tmp/tutorial-test-session.json"

if [ -z "${STAGING_TOKEN:-}" ]; then
  echo "Error: STAGING_TOKEN not set. Get it with:"
  echo '  export STAGING_TOKEN=$(curl -s -X POST "$AUTH_URL/oauth/token" ...)'
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 \"prompt text\""
  exit 1
fi

PROMPT="$1"

# Load or init session history
if [ -f "$SESSION_FILE" ]; then
  MESSAGES=$(cat "$SESSION_FILE")
else
  MESSAGES='[]'
fi

# Append user message
MESSAGES=$(echo "$MESSAGES" | jq --arg p "$PROMPT" '. + [{"role": "user", "content": $p}]')

echo "============================================"
echo "PROMPT: $PROMPT"
echo "============================================"
echo ""

# Build request body
BODY=$(jq -n \
  --argjson messages "$MESSAGES" \
  '{
    model: "anthropic--claude-4.5-sonnet",
    messages: $messages,
    max_tokens: 16000,
    stream: false
  }')

# Send request
RESPONSE=$(curl -s -w "\n---HTTP_CODE:%{http_code}---" \
  "$STAGING_URL/v1/chat/completions" \
  -H "Authorization: Bearer $STAGING_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY")

HTTP_CODE=$(echo "$RESPONSE" | grep -o 'HTTP_CODE:[0-9]*' | cut -d: -f2)
BODY_RESPONSE=$(echo "$RESPONSE" | sed 's/---HTTP_CODE:[0-9]*---//')

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: HTTP $HTTP_CODE"
  echo "$BODY_RESPONSE" | jq . 2>/dev/null || echo "$BODY_RESPONSE"
  exit 1
fi

# Extract assistant message
ASSISTANT_MSG=$(echo "$BODY_RESPONSE" | jq -r '.choices[0].message.content // "No content"')
USAGE=$(echo "$BODY_RESPONSE" | jq '.usage // {}')

echo "RESPONSE:"
echo "--------------------------------------------"
echo "$ASSISTANT_MSG"
echo "--------------------------------------------"
echo ""
echo "USAGE: $(echo "$USAGE" | jq -c '{prompt: .prompt_tokens, completion: .completion_tokens, total: .total_tokens}')"

# Save assistant message to session
MESSAGES=$(echo "$MESSAGES" | jq --arg m "$ASSISTANT_MSG" '. + [{"role": "assistant", "content": $m}]')
echo "$MESSAGES" > "$SESSION_FILE"

echo ""
echo "Session saved ($SESSION_FILE) — $(echo "$MESSAGES" | jq length) messages"
