#!/bin/bash

# Interactive Authorization Testing Script for MCP Proxy
# Usage: ./test-auth-interactive.sh

set -e

BASE_URL="${BASE_URL:-http://localhost:4004}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"
}

print_test() {
    echo -e "${YELLOW}🧪 Test: $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Generate Base64 credentials
alice_creds=$(echo -n "alice:" | base64)
bob_creds=$(echo -n "bob:" | base64)
unknown_creds=$(echo -n "unknown:" | base64)

print_header "MCP Proxy Authorization Testing"
print_info "Base URL: $BASE_URL"
echo ""

# Test 1: Health Check (no auth required)
print_test "Health endpoint (no auth)"
HTTP_CODE=$(curl -s -o /tmp/response.txt -w "%{http_code}" "$BASE_URL/mcp/Health")
if [ "$HTTP_CODE" = "200" ]; then
    print_success "Health check passed: $HTTP_CODE"
    cat /tmp/response.txt | jq . 2>/dev/null || cat /tmp/response.txt
else
    print_error "Health check failed: $HTTP_CODE"
    cat /tmp/response.txt
fi
echo ""

# SSE Tests
print_header "SSE Endpoint Authorization Tests"

# Test 2: SSE without auth
print_test "SSE without Authorization header (expect 401)"
HTTP_CODE=$(curl -s -o /tmp/response.txt -w "%{http_code}" \
    -H "Accept: text/event-stream" \
    "$BASE_URL/mcp/stream/sse")
if [ "$HTTP_CODE" = "401" ]; then
    print_success "Correctly rejected: $HTTP_CODE"
    echo "Response: $(cat /tmp/response.txt)"
else
    print_error "Expected 401, got: $HTTP_CODE"
    cat /tmp/response.txt
fi
echo ""

# Test 3: SSE with alice
print_test "SSE with alice (admin - expect 200)"
print_info "Authorization: Basic $alice_creds"
timeout 3 curl -N -s \
    -H "Accept: text/event-stream" \
    -H "Authorization: Basic $alice_creds" \
    -w "\nHTTP: %{http_code}\n" \
    "$BASE_URL/mcp/stream/sse" > /tmp/sse-alice.txt 2>&1 || true

if grep -q "retry: 15000" /tmp/sse-alice.txt; then
    print_success "Connection established, received retry hint"
    echo "First few lines:"
    head -n 5 /tmp/sse-alice.txt
else
    print_error "Did not receive expected SSE stream"
    cat /tmp/sse-alice.txt
fi
echo ""

# Test 4: SSE with bob
print_test "SSE with bob (connector - expect 200)"
print_info "Authorization: Basic $bob_creds"
timeout 3 curl -N -s \
    -H "Accept: text/event-stream" \
    -H "Authorization: Basic $bob_creds" \
    "$BASE_URL/mcp/stream/sse" > /tmp/sse-bob.txt 2>&1 || true

if grep -q "retry: 15000" /tmp/sse-bob.txt; then
    print_success "Connection established for bob"
else
    print_error "Failed to establish connection for bob"
    head -n 10 /tmp/sse-bob.txt
fi
echo ""

# Test 5: SSE with unknown user
print_test "SSE with unknown user (expect 403)"
print_info "Authorization: Basic $unknown_creds"
HTTP_CODE=$(curl -s -o /tmp/response.txt -w "%{http_code}" \
    -H "Accept: text/event-stream" \
    -H "Authorization: Basic $unknown_creds" \
    "$BASE_URL/mcp/stream/sse")
if [ "$HTTP_CODE" = "403" ]; then
    print_success "Correctly forbidden: $HTTP_CODE"
else
    print_error "Expected 403, got: $HTTP_CODE"
    cat /tmp/response.txt
fi
echo ""

# Stream-HTTP Tests
print_header "Stream-HTTP Endpoint Authorization Tests"

# Test 6: Stream-HTTP without auth
print_test "Stream-HTTP without Authorization header (expect 401)"
HTTP_CODE=$(curl -s -o /tmp/response.txt -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/x-ndjson" \
    --data '{"test":"data"}' \
    "$BASE_URL/mcp/stream/http")
if [ "$HTTP_CODE" = "401" ]; then
    print_success "Correctly rejected: $HTTP_CODE"
    echo "Response: $(cat /tmp/response.txt)"
else
    print_error "Expected 401, got: $HTTP_CODE"
    cat /tmp/response.txt
fi
echo ""

# Test 7: Stream-HTTP with alice
print_test "Stream-HTTP with alice (admin - expect 200 or 502)"
print_info "Authorization: Basic $alice_creds"
echo '{"command":"test","user":"alice"}' | \
HTTP_CODE=$(curl -s -o /tmp/response.txt -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/x-ndjson" \
    -H "Authorization: Basic $alice_creds" \
    --data-binary @- \
    "$BASE_URL/mcp/stream/http")

if [ "$HTTP_CODE" = "200" ]; then
    print_success "Request accepted: $HTTP_CODE"
    echo "Response:"
    cat /tmp/response.txt | head -c 200
    echo ""
elif [ "$HTTP_CODE" = "502" ] || [ "$HTTP_CODE" = "500" ]; then
    print_info "Proxy accepted request ($HTTP_CODE) - upstream may not be running"
else
    print_error "Expected 200/502, got: $HTTP_CODE"
    cat /tmp/response.txt
fi
echo ""

# Test 8: Stream-HTTP with bob
print_test "Stream-HTTP with bob (connector - expect 200 or 502)"
print_info "Authorization: Basic $bob_creds"
echo '{"command":"test","user":"bob"}' | \
HTTP_CODE=$(curl -s -o /tmp/response.txt -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/x-ndjson" \
    -H "Authorization: Basic $bob_creds" \
    --data-binary @- \
    "$BASE_URL/mcp/stream/http")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "502" ] || [ "$HTTP_CODE" = "500" ]; then
    print_success "Request accepted: $HTTP_CODE"
else
    print_error "Expected 200/502, got: $HTTP_CODE"
    cat /tmp/response.txt
fi
echo ""

# Test 9: Stream-HTTP with unknown user
print_test "Stream-HTTP with unknown user (expect 403)"
print_info "Authorization: Basic $unknown_creds"
HTTP_CODE=$(curl -s -o /tmp/response.txt -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/x-ndjson" \
    -H "Authorization: Basic $unknown_creds" \
    --data '{"test":"data"}' \
    "$BASE_URL/mcp/stream/http")
if [ "$HTTP_CODE" = "403" ]; then
    print_success "Correctly forbidden: $HTTP_CODE"
else
    print_error "Expected 403, got: $HTTP_CODE"
    cat /tmp/response.txt
fi
echo ""

# Summary
print_header "Test Summary"
echo "All authorization tests completed!"
echo ""
print_info "Credentials used:"
echo "  alice: $alice_creds"
echo "  bob:   $bob_creds"
echo "  unknown: $unknown_creds"
echo ""
print_info "Check server logs for detailed authorization flow"
echo ""

# Cleanup
rm -f /tmp/response.txt /tmp/sse-alice.txt /tmp/sse-bob.txt

print_success "Testing complete! 🎉"
