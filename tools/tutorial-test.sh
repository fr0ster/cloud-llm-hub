#!/usr/bin/env bash
# Tutorial step tester — sends a prompt to cloud-llm-hub and shows the response.
# Usage: ./tools/tutorial-test.sh "Your prompt here"
#        ./tools/tutorial-test.sh --save output.md "Generate business requirements"
# Env: STAGING_TOKEN (OAuth token), STAGING_URL (API base URL)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ENV="$SCRIPT_DIR/../mcp.env"

# Load token from mcp.env if not set via environment
if [ -z "${STAGING_TOKEN:-}" ] && [ -f "$MCP_ENV" ]; then
  STAGING_TOKEN=$(grep -m1 '^XSUAA_JWT_TOKEN=' "$MCP_ENV" | cut -d= -f2-)
fi

STAGING_URL="${STAGING_URL:?STAGING_URL is required (e.g. https://<subaccount>-cloud-llm-hub.cfapps.<region>.hana.ondemand.com)}"
SESSION_FILE="/tmp/tutorial-test-session.json"
SAVE_FILE=""

if [ -z "${STAGING_TOKEN:-}" ]; then
  echo "Error: No token found. Set STAGING_TOKEN or add XSUAA_JWT_TOKEN to mcp.env"
  exit 1
fi

# Parse --save option
if [ "${1:-}" = "--save" ]; then
  SAVE_FILE="$2"
  shift 2
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 [--save filename.md] \"prompt text\""
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
    max_tokens: 32000,
    stream: false,
    tools: [
      {
        type: "function",
        function: {
          name: "GenerateFile",
          description: "Generate a file for the user to download. Use when the user asks to create, generate, export, or save content as a file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Filename with extension (e.g. report.md, spec.json)" },
              content: { type: "string", description: "File content as text" },
              encoding: { type: "string", enum: ["text", "base64"], description: "Content encoding. Default: text" }
            },
            required: ["path", "content"]
          }
        }
      }
    ]
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

# Extract assistant message and tool calls
ASSISTANT_MSG=$(echo "$BODY_RESPONSE" | jq -r '.choices[0].message.content // "No content"')
USAGE=$(echo "$BODY_RESPONSE" | jq '.usage // {}')

# Handle GenerateFile tool calls — save files locally
TOOL_CALLS=$(echo "$BODY_RESPONSE" | jq -r '.choices[0].message.tool_calls // []')
FILE_COUNT=$(echo "$TOOL_CALLS" | jq 'map(select(.function.name == "GenerateFile")) | length')
if [ "$FILE_COUNT" -gt 0 ]; then
  echo ""
  echo "FILES GENERATED: $FILE_COUNT"
  echo "$TOOL_CALLS" | jq -r '.[] | select(.function.name == "GenerateFile") | .function.arguments' | while read -r ARGS; do
    FILE_PATH=$(echo "$ARGS" | jq -r '.path // "unnamed.txt"')
    FILE_CONTENT=$(echo "$ARGS" | jq -r '.content // ""')
    OUTPUT_DIR="/tmp/tutorial-files"
    mkdir -p "$OUTPUT_DIR"
    echo "$FILE_CONTENT" > "$OUTPUT_DIR/$FILE_PATH"
    echo "  -> $OUTPUT_DIR/$FILE_PATH ($(echo "$FILE_CONTENT" | wc -c) bytes)"
  done
fi

echo "RESPONSE:"
echo "--------------------------------------------"
echo "$ASSISTANT_MSG"
echo "--------------------------------------------"
echo ""
echo "USAGE: $(echo "$USAGE" | jq -c '{prompt: .prompt_tokens, completion: .completion_tokens, total: .total_tokens}')"

# Save assistant message to session
MESSAGES=$(echo "$MESSAGES" | jq --arg m "$ASSISTANT_MSG" '. + [{"role": "assistant", "content": $m}]')
echo "$MESSAGES" > "$SESSION_FILE"

# Save response content to file if --save was specified
if [ -n "$SAVE_FILE" ]; then
  OUTPUT_DIR="/tmp/tutorial-files"
  mkdir -p "$OUTPUT_DIR"
  echo "$ASSISTANT_MSG" > "$OUTPUT_DIR/$SAVE_FILE"
  echo "SAVED: $OUTPUT_DIR/$SAVE_FILE ($(echo "$ASSISTANT_MSG" | wc -c) bytes)"
fi

echo ""
echo "Session saved ($SESSION_FILE) — $(echo "$MESSAGES" | jq length) messages"
