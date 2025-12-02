# Testing Guide

Comprehensive guide for writing and running tests in Cloud LLM Hub.

## 🧪 Test Structure

```
test/
├── test-cap-from-yaml.js       # Integration test runner
├── integration.yaml.template   # Test configuration template
└── smoke/                       # Manual smoke tests
    ├── run-all.sh
    ├── test-health.sh
    ├── test-sse.sh
    ├── test-stream-http.sh
    └── test-destination-probe.sh
```

## 📋 Types of Tests

### 1. Unit Tests

**Purpose:** Test individual functions and components in isolation

**Location:** `test/unit/`

**Framework:** Jest (recommended) or Mocha

**Run:**

```bash
npm run test:unit
```

**Coverage:** Target > 80% for critical components

### 2. Integration Tests

**Purpose:** Test full request/response flow

**Location:** `test/test-cap-from-yaml.js`

**Configuration:** `test/integration.yaml`

**Run:**

```bash
npm test
```

### 3. Smoke Tests

**Purpose:** Quick manual verification

**Location:** `test/smoke/`

**Run:**

```bash
cd test/smoke
./run-all.sh
```

### 4. Type Checking

**Purpose:** Verify TypeScript compilation

**Run:**

```bash
npm exec -- tsc --noEmit
```

## 🚀 Running Tests

### Integration Tests

**Prerequisites:**

- Copy template: `cp test/integration.yaml.template test/integration.yaml`
- Configure with your values

**Run:**

```bash
npm test
```

**What it tests:**

- Health endpoint
- SSE streaming
- Stream-HTTP
- Destination probe

### Smoke Tests

**Individual tests:**

```bash
cd test/smoke
./test-health.sh
./test-sse.sh
./test-stream-http.sh
./test-destination-probe.sh
```

**All tests:**

```bash
cd test/smoke
./run-all.sh
```

### Type Checking

```bash
npm exec -- tsc --noEmit
```

## ✍️ Writing Tests

### Unit Test Structure

**Setup (Jest):**

1. **Install Jest:**

```bash
npm install --save-dev jest @types/jest ts-jest
```

2. **Create `jest.config.js`:**

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/srv', '<rootDir>/test/unit'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: ['srv/**/*.ts', '!srv/**/*.d.ts', '!srv/**/*.test.ts'],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
```

3. **Add to `package.json`:**

```json
{
  "scripts": {
    "test:unit": "jest",
    "test:unit:watch": "jest --watch",
    "test:unit:coverage": "jest --coverage"
  }
}
```

**Example Unit Test:**

```typescript
// test/unit/mcp-manager.test.ts
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { getMCPServer } from '../../srv/mcp-manager';

describe('MCP Manager', () => {
  beforeEach(() => {
    // Clear cache before each test
    jest.clearAllMocks();
  });

  it('should create new MCP server for new URL', async () => {
    const sapUrl = 'https://sap.example.com';
    const config = {
      url: sapUrl,
      client: '200',
      auth: { type: 'jwt', token: 'test-token' },
    };

    const result = await getMCPServer({} as any);
    expect(result.server).toBeDefined();
    expect(result.server.url).toBe(sapUrl);
  });

  it('should return cached server for same URL', async () => {
    const sapUrl = 'https://sap.example.com';

    // First call
    const result1 = await getMCPServer({} as any);

    // Second call (should use cache)
    const result2 = await getMCPServer({} as any);

    expect(result1.server).toBe(result2.server);
  });

  it('should handle connection errors gracefully', async () => {
    // Mock connection failure
    jest
      .spyOn(require('../../srv/connections/CloudSdkAbapConnection'), 'default')
      .mockRejectedValue(new Error('Connection failed'));

    await expect(getMCPServer({} as any)).rejects.toThrow('Connection failed');
  });
});
```

**Mocking Strategies:**

**Mock SAP Cloud SDK:**

```typescript
jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: jest.fn().mockResolvedValue({
    data: { status: 'ok' },
    status: 200,
  }),
}));
```

**Mock CAP Services:**

```typescript
jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  })),
}));
```

**Mock External Dependencies:**

```typescript
jest.mock('@fr0ster/mcp-abap-adt', () => ({
  MCPServer: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue({}),
    listTools: jest.fn().mockResolvedValue([]),
  })),
}));
```

### Integration Test Structure

**YAML Configuration:**

```yaml
baseUrl: http://localhost:4004
auth:
  header: 'Basic YWxpY2U6' # alice (mocked dev)
sap:
  mode: direct
  direct:
    url: 'https://sap.example.com'
    client: 200
    auth:
      type: jwt
      token: 'your-token'
```

**Test Runner:**

- Reads YAML configuration
- Constructs HTTP requests
- Validates responses
- Logs results

### Example Test Addition

**Adding a new test endpoint:**

1. **Edit `test/test-cap-from-yaml.js`:**

```javascript
async function testNewEndpoint(baseUrl, headers) {
  const response = await fetchWithTimeout(`${baseUrl}/odata/v4/mcp/NewEndpoint()`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`NewEndpoint failed: ${response.status}`);
  }

  const data = await response.json();
  console.log('✅ NewEndpoint:', data);
}
```

2. **Add to test suite:**

```javascript
await testNewEndpoint(baseUrl, headers);
```

### Smoke Test Structure

**Example (`test/smoke/test-health.sh`):**

```bash
#!/bin/bash
set -e

BASE_URL="${BASE_URL:-http://localhost:4004}"
AUTH="${AUTH:-Basic YWxpY2U6}"

echo "Testing Health endpoint..."

response=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: $AUTH" \
  "$BASE_URL/odata/v4/mcp/Health()")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
  echo "✅ Health check passed"
  echo "$body" | jq .
else
  echo "❌ Health check failed: $http_code"
  exit 1
fi
```

## 🎯 Test Coverage

### Current Coverage

**Integration Tests:**

- ✅ Health endpoint
- ✅ SSE streaming
- ✅ Stream-HTTP
- ✅ Destination probe
- ✅ Authentication

**Unit Tests:**

- ⚠️ Not yet implemented (Phase 4 task)

### Target Coverage

**Critical Components (Priority 1):**

- `srv/mcp-manager.ts` - MCP server lifecycle and caching
- `srv/connections/destinationResolver.ts` - Destination resolution
- `srv/connections/CloudSdkAbapConnection.ts` - SAP connection handling

**Important Components (Priority 2):**

- `srv/mcp-proxy.ts` - Endpoint handlers
- `tools/update-cline-connection.js` - Configuration management

**Nice to Have (Priority 3):**

- Utility functions
- Helper modules

### Missing Coverage

- ⚠️ Error handling
- ⚠️ Edge cases
- ⚠️ Session management
- ⚠️ Cache behavior
- ⚠️ Connection failures

## 📝 Test Best Practices

### 1. Test Structure (AAA Pattern)

```typescript
describe('Feature', () => {
  it('should do something', async () => {
    // Arrange - Set up test data
    const config = { url: 'https://example.com' };

    // Act - Execute the code
    const result = await functionUnderTest(config);

    // Assert - Verify results
    expect(result).toBeDefined();
    expect(result.status).toBe('ok');
  });
});
```

### 2. Test Naming

**Use descriptive names:**

```typescript
// ✅ Good
it('should return cached server for same URL', async () => {});
it('should throw error when connection fails', async () => {});

// ❌ Bad
it('test1', async () => {});
it('works', async () => {});
```

### 3. Test Isolation

**Each test should be independent:**

```typescript
// ✅ Good
beforeEach(() => {
  // Reset state
  manager.clearCache();
});

it('should create new server', async () => {
  // Test doesn't depend on previous tests
});
```

### 4. Mock External Dependencies

**Mock SAP calls in unit tests:**

```typescript
// ✅ Good
jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: jest.fn().mockResolvedValue({ data: 'ok' }),
}));
```

### 5. Test Error Cases

**Don't just test happy path:**

```typescript
// ✅ Good
it('should handle connection timeout', async () => {
  jest.useFakeTimers();
  const promise = connectWithTimeout();
  jest.advanceTimersByTime(30000);
  await expect(promise).rejects.toThrow('Timeout');
});
```

## 🔧 Test Configuration

### Integration Test Config

**File:** `test/integration.yaml`

**Required fields:**

- `baseUrl` - MCP endpoint URL
- `auth.header` - Authorization header
- `sap` - SAP connection configuration

**Optional fields:**

- `timeoutMs` - Request timeout
- `streamTimeoutMs` - Stream timeout
- `headers` - Custom headers

### Environment Variables

**For smoke tests:**

```bash
export BASE_URL="http://localhost:4004"
export AUTH="Basic YWxpY2U6"
export DESTINATION="SAP_DEV_DEST"
```

## 🐛 Debugging Tests

### Enable Verbose Logging

```bash
# Integration tests
DEBUG=* npm test

# Smoke tests
DEBUG=1 ./test-smoke.sh
```

### Manual Testing

**Test endpoints manually:**

```bash
# Health
curl -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/odata/v4/mcp/Health\(\)

# SSE
curl -N -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse

# Stream-HTTP
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:4004/mcp/stream/http
```

### Common Issues

**Port already in use:**

```bash
lsof -i :4004
kill -9 <PID>
```

**Authentication failures:**

- Check token validity
- Verify XSUAA configuration
- Check user roles

**Connection timeouts:**

- Verify SAP system accessibility
- Check network connectivity
- Review Cloud Connector (for on-premise)

## 📊 Test Reports

### Unit Test Output

```
PASS  test/unit/mcp-manager.test.ts
  MCP Manager
    ✓ should create new MCP server for new URL (45ms)
    ✓ should return cached server for same URL (12ms)
    ✓ should handle connection errors gracefully (8ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        2.345 s
```

### Integration Test Output

```
✅ Health: OK
✅ SSE: Connected
✅ Stream-HTTP: OK
✅ ProbeDestination: OK
```

### Failed Test Output

```
✅ Health: OK
❌ SSE: Failed - Connection timeout
   Error: Request timeout after 15000ms
```

### Coverage Report

```
File              | % Stmts | % Branch | % Funcs | % Lines |
------------------|---------|----------|---------|---------|
 mcp-manager.ts   |   85.2  |   78.5   |   82.1  |   85.2  |
 destinationResolver.ts | 92.3 | 88.9 | 90.0 | 92.3 |
------------------|---------|----------|---------|---------|
All files         |   88.7  |   83.7   |   86.0  |   88.7  |
```

## 🔄 Continuous Integration

### GitHub Actions

Tests run automatically on PR:

- Integration tests
- Type checking
- Build verification

### Local CI Simulation

```bash
# Run all checks
npm exec -- tsc --noEmit && npm test
```

## 📚 Additional Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
- [CAP Testing Guide](https://cap.cloud.sap/docs/guides/testing)

---

**Questions?** Check existing tests or ask in discussions!
