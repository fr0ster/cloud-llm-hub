#!/bin/bash

# Run all MCP Proxy smoke tests
# Usage: ./run-all.sh [base-url] [auth-header]

BASE_URL="${1:-http://localhost:4004}"
AUTH_HEADER="${2:-Basic YWxpY2U6}"

echo "🚀 Running MCP Proxy Smoke Tests"
echo "=================================="
echo "Base URL: $BASE_URL"
echo "Auth: $AUTH_HEADER"
echo ""

# Make scripts executable
chmod +x test-health.sh test-sse.sh test-stream-http.sh

# Run health check
echo "📍 Step 1: Health Check"
./test-health.sh "$BASE_URL"
echo ""

# Wait a bit
sleep 2

# Run SSE tests
echo "📍 Step 2: SSE Endpoint Tests"
./test-sse.sh "$BASE_URL" "$AUTH_HEADER"
echo ""

# Wait a bit
sleep 2

# Run Stream-HTTP tests
echo "📍 Step 3: Stream-HTTP Endpoint Tests"
./test-stream-http.sh "$BASE_URL" "$AUTH_HEADER"
echo ""

echo "=================================="
echo "🎉 All smoke tests completed!"
echo ""
echo "Note: Some tests may show warnings if mcp-abap-adt backend is not running."
echo "To start the backend: cd external/mcp-abap-adt && npm start"
