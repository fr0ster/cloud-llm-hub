#!/usr/bin/env bash
# Test the CALM Dump Analyzer locally.
#
# Prerequisites:
#   1. cloud-llm-hub running (locally or on BTP)
#   2. This service running: npm start
#
# Usage:
#   ./test.sh                              # uses localhost:8080
#   SERVICE_URL=https://... ./test.sh      # remote

set -euo pipefail

SERVICE_URL="${SERVICE_URL:-http://localhost:8080}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Testing CALM Dump Analyzer at $SERVICE_URL"
echo ""

echo "=== Health ==="
curl -s "$SERVICE_URL/health" | python3 -m json.tool
echo ""

echo "=== Analyze dump ==="
curl -s -X POST "$SERVICE_URL/analyze" \
  -H "Content-Type: application/json" \
  -d @"$SCRIPT_DIR/test-payload.json" | python3 -m json.tool
