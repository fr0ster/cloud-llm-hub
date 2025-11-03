#!/bin/bash
# Test CAP endpoints
# Usage: ./scripts/test-cap-endpoints.sh [base-url]

BASE_URL="${1:-http://localhost:4004}"

echo "🧪 Тестування CAP ендпойнтів на ${BASE_URL}"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test function
test_endpoint() {
    local method=$1
    local url=$2
    local auth=$3
    local name=$4
    
    echo -n "  ${name}... "
    
    if [ -z "$auth" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" "${BASE_URL}${url}" 2>&1)
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" -H "Authorization: $auth" "${BASE_URL}${url}" 2>&1)
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)
    
    if [ "$http_code" -eq 200 ] || [ "$http_code" -eq 201 ]; then
        echo -e "${GREEN}✅ OK (${http_code})${NC}"
        echo "$body" | jq '.' 2>/dev/null || echo "$body"
    else
        echo -e "${RED}❌ FAILED (${http_code})${NC}"
        echo "$body" | head -n5
    fi
    echo ""
}

echo "📋 AuthService (@path: 'auth')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Basic auth for development
BASIC_ALICE="Basic YWxpY2U6"  # alice: (empty password)

echo "1️⃣  CheckAuth (без авторизації):"
test_endpoint "GET" "/odata/v4/auth/CheckAuth()" "" "CheckAuth"

echo "2️⃣  CheckAuth (з авторизацією):"
test_endpoint "GET" "/odata/v4/auth/CheckAuth()" "$BASIC_ALICE" "CheckAuth (auth)"

echo "3️⃣  CheckRoles (без авторизації - має повернути 401):"
test_endpoint "GET" "/odata/v4/auth/CheckRoles?required=%5B%22MCP_Connector%22%5D" "" "CheckRoles (no auth)"

echo "4️⃣  CheckRoles (з авторизацією):"
test_endpoint "GET" "/odata/v4/auth/CheckRoles?required=%5B%22MCP_Connector%22%5D" "$BASIC_ALICE" "CheckRoles (auth)"

echo ""
echo "📋 McpProxyService (@path: 'mcp')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo "5️⃣  Health (без авторизації - має повернути 401/403):"
test_endpoint "GET" "/odata/v4/mcp/Health()" "" "Health (no auth)"

echo "6️⃣  Health (з авторизацією):"
test_endpoint "GET" "/odata/v4/mcp/Health()" "$BASIC_ALICE" "Health (auth)"

echo "7️⃣  Health (НЕПРАВИЛЬНО - без дужок, має повернути помилку):"
test_endpoint "GET" "/odata/v4/mcp/Health" "$BASIC_ALICE" "Health (wrong URL)"

echo ""
echo "📝 Примітки:"
echo "  • Переконайтеся, що сервер запущений: cds watch --profile development"
echo "  • Для production замініть BASIC_ALICE на Bearer JWT токен"
echo "  • URL encoded масив: ['MCP_Connector'] = %5B%22MCP_Connector%22%5D"

