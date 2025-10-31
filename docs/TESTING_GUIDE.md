# MCP Proxy Testing Guide

Comprehensive instructions for validating authentication on the SSE and Stream-HTTP endpoints.

---

## 🚀 Test Preparation

### 1. Start the service

```bash
# Terminal 1: start the CAP service
cd /home/developer/prj/cloud-llm-hub
cds watch --profile development
```

Expected output:
```
[cds] - server listening on { url: 'http://localhost:4004' }
[cds] - launched at 10/29/2025, 11:30:00 AM
```

### 2. Prepare credentials

**alice (admin user):**
```bash
# Generate Base64 for alice (empty password)
echo -n "alice:" | base64
# Expected: YWxpY2U6
```

**bob (standard user):**
```bash
# Generate Base64 for bob (empty password)
echo -n "bob:" | base64
# Expected: Ym9iOg==
```

**Unknown user:**
```bash
# Generate Base64 for unknown
echo -n "unknown:" | base64
# Expected: dW5rbm93bjo=
```

---

## 🔐 Testing the SSE endpoint

### ✅ Test 1: Successful authorization (alice)

```bash
curl -N -v \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/mcp/stream/sse
```

**Expected result:**
- HTTP status `200 OK`
- Headers include:
  ```
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive
  ```
- First line: `retry: 15000`
- Heartbeat every 15 seconds: `: ping`

**Sample output:**
```
< HTTP/1.1 200 OK
< Content-Type: text/event-stream
< Cache-Control: no-cache
< Connection: keep-alive

retry: 15000

: ping

: ping
...
```

### ✅ Test 2: Successful authorization (bob)

```bash
curl -N -v \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic Ym9iOg==" \
  http://localhost:4004/mcp/stream/sse
```

**Expected result:** Same as alice (both users carry the `MCP_Connector` role).

### ❌ Test 3: Missing authorization header

```bash
curl -v \
  -H "Accept: text/event-stream" \
  http://localhost:4004/mcp/stream/sse
```

**Expected result:**
- HTTP status `401 Unauthorized`
- Body: `Unauthorized: Missing or invalid Authorization header`

**Sample output:**
```
< HTTP/1.1 401 Unauthorized
< Content-Type: text/plain; charset=utf-8

Unauthorized: Missing or invalid Authorization header
```

### ❌ Test 4: User without the role

```bash
curl -v \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic dW5rbm93bjo=" \
  http://localhost:4004/mcp/stream/sse
```

**Expected result:**
- HTTP status `403 Forbidden` (recognized user, missing `MCP_Connector`).

### ❌ Test 5: Invalid Bearer token

```bash
curl -v \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer invalid-token-here" \
  http://localhost:4004/mcp/stream/sse
```

**Expected result:**
- HTTP status `401 Unauthorized`
- Body includes the error `Missing XSUAA binding in production mode`

### 🔍 Test 6: Inspect server logs

After each request, review the terminal running `cds watch`:

```
[mcp-proxy/authShim] - Basic auth detected { username: 'alice' }
[mcp-proxy/sse] - SSE connection established { user: 'alice' }
[mcp-proxy/sse] - Connecting to upstream SSE { targetUrl: 'http://127.0.0.1:7070' }
```

For invalid requests:
```
[mcp-proxy/authShim] - Unauthorized request - missing or invalid Authorization header
[mcp-proxy/sse] - Forbidden: User lacks MCP_Connector role { user: 'unknown' }
```

---

## 🔐 Testing the Stream-HTTP endpoint

### ✅ Test 1: Successful authorization (alice)

```bash
echo '{"command":"test","timestamp":"'$(date -Iseconds)'"}' | \
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic YWxpY2U6" \
  --data-binary @- \
  http://localhost:4004/mcp/stream/http
```

**Expected result:**
- HTTP status `200 OK`
- Headers include `Content-Type: application/x-ndjson`
- Upstream response when the backend is running

**File-based alternative:**

```bash
# Create a test file
cat > /tmp/test-stream.ndjson <<EOF
{"command":"tools/list"}
{"command":"tools/call","params":{"name":"test"}}
EOF

# Send the request
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic YWxpY2U6" \
  --data-binary @/tmp/test-stream.ndjson \
  http://localhost:4004/mcp/stream/http
```

### ✅ Test 2: Successful authorization (bob)

```bash
echo '{"command":"test"}' | \
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic Ym9iOg==" \
  --data-binary @- \
  http://localhost:4004/mcp/stream/http
```

**Expected result:** `200 OK` (bob has the `MCP_Connector` role)

### ❌ Test 3: Missing authorization header

```bash
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  --data '{"command":"test"}' \
  http://localhost:4004/mcp/stream/http
```

**Expected result:**
- HTTP status `401 Unauthorized`

### ❌ Test 4: User without the role

```bash
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic dW5rbm93bjo=" \
  --data '{"command":"test"}' \
  http://localhost:4004/mcp/stream/http
```

**Expected result:**
- HTTP status `403 Forbidden`

### ❌ Test 5: Wrong HTTP method (GET instead of POST)

```bash
curl -v \
  -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/mcp/stream/http
```

**Expected result:**
- HTTP status `404 Not Found` (endpoint only accepts POST)

---

## 🧪 Automated tests

### Run the full smoke suite

```bash
cd test/smoke
./run-all.sh
```

### Run individual scripts

```bash
# Health check
./test-health.sh

# SSE scenarios (covers auth cases)
./test-sse.sh

# Stream-HTTP scenarios (covers auth cases)
./test-stream-http.sh
```

---

## 🔍 Deep-dive diagnostics

### SSE with full debug output

```bash
curl -N -vvv \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/mcp/stream/sse 2>&1 | tee /tmp/sse-test.log
```

Review the log afterwards:
```bash
cat /tmp/sse-test.log | grep -E "(HTTP|Content-Type|Authorization|retry|ping)"
```

### Stream-HTTP with timing information

```bash
echo '{"test":"data"}' | \
curl -w "\n\nTime stats:\n-----------\nTotal: %{time_total}s\nConnect: %{time_connect}s\nStart Transfer: %{time_starttransfer}s\nHTTP Code: %{http_code}\n" \
  -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic YWxpY2U6" \
  --data-binary @- \
  http://localhost:4004/mcp/stream/http
```

---

## 🐍 Python helpers

Create `test_auth.py`:

```python
#!/usr/bin/env python3
import requests
import base64
from sseclient import SSEClient  # pip install sseclient-py

def test_sse_auth(username, password=""):
  """Exercise SSE authorization"""
    creds = base64.b64encode(f"{username}:{password}".encode()).decode()
    headers = {
        "Accept": "text/event-stream",
        "Authorization": f"Basic {creds}"
    }
    
    print(f"\n🧪 Testing SSE with user: {username}")
    print(f"Authorization: Basic {creds}")
    
    try:
        response = requests.get(
            "http://localhost:4004/mcp/stream/sse",
            headers=headers,
            stream=True,
            timeout=5
        )
        
        print(f"✅ Status: {response.status_code}")
        print(f"Headers: {dict(response.headers)}")
        
    if response.status_code == 200:
      # Read the first few events
            client = SSEClient(response)
            count = 0
            for event in client.events():
                print(f"📨 Event: {event.data}")
                count += 1
                if count >= 3:
                    break
        else:
            print(f"❌ Body: {response.text}")
            
  except Exception as exc:
    print(f"❌ Error: {exc}")

def test_stream_http_auth(username, password=""):
  """Exercise Stream-HTTP authorization"""
    creds = base64.b64encode(f"{username}:{password}".encode()).decode()
    headers = {
        "Content-Type": "application/x-ndjson",
        "Authorization": f"Basic {creds}"
    }
    
    print(f"\n🧪 Testing Stream-HTTP with user: {username}")
    print(f"Authorization: Basic {creds}")
    
    try:
        response = requests.post(
            "http://localhost:4004/mcp/stream/http",
            headers=headers,
            json={"command": "test", "user": username},
            timeout=5
        )
        
        print(f"✅ Status: {response.status_code}")
        print(f"Headers: {dict(response.headers)}")
        
        if response.status_code == 200:
            print(f"📨 Response: {response.text[:200]}")
        else:
            print(f"❌ Body: {response.text}")
            
  except Exception as exc:
    print(f"❌ Error: {exc}")

if __name__ == "__main__":
    print("=" * 60)
    print("MCP Proxy Authorization Tests")
    print("=" * 60)
    
  # SSE tests
  test_sse_auth("alice")      # Expected: success (admin)
  test_sse_auth("bob")        # Expected: success (connector)
  test_sse_auth("unknown")    # Expected: 403

  # Stream-HTTP tests
  test_stream_http_auth("alice")      # Expected: success
  test_stream_http_auth("bob")        # Expected: success
  test_stream_http_auth("unknown")    # Expected: 403
    
    print("\n" + "=" * 60)
    print("Tests completed!")
```

Run:
```bash
pip install requests sseclient-py
python3 test_auth.py
```

---

## 🌐 JavaScript/Node.js helpers

Create `test-auth.js`:

```javascript
#!/usr/bin/env node

const EventSource = require('eventsource');

function testSSE(username, password = '') {
  console.log(`\n🧪 Testing SSE with user: ${username}`);
  
  const creds = Buffer.from(`${username}:${password}`).toString('base64');
  const url = 'http://localhost:4004/mcp/stream/sse';
  
  const es = new EventSource(url, {
    headers: {
      'Authorization': `Basic ${creds}`
    }
  });
  
  es.onopen = () => {
    console.log('✅ Connection opened');
  };
  
  es.onmessage = (event) => {
    console.log('📨 Event:', event.data);
  };
  
  es.onerror = (error) => {
    console.log('❌ Error:', error.message);
    es.close();
  };
  
  // Close after 10 seconds
  setTimeout(() => {
    console.log('🛑 Closing connection');
    es.close();
  }, 10000);
}

async function testStreamHTTP(username, password = '') {
  console.log(`\n🧪 Testing Stream-HTTP with user: ${username}`);
  
  const creds = Buffer.from(`${username}:${password}`).toString('base64');
  
  try {
    const response = await fetch('http://localhost:4004/mcp/stream/http', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Authorization': `Basic ${creds}`
      },
      body: JSON.stringify({ command: 'test', user: username })
    });
    
    console.log(`✅ Status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.text();
      console.log('📨 Response:', data.substring(0, 200));
    } else {
      const error = await response.text();
      console.log('❌ Error:', error);
    }
  } catch (error) {
    console.log('❌ Exception:', error.message);
  }
}

// Run the tests
console.log('='.repeat(60));
console.log('MCP Proxy Authorization Tests');
console.log('='.repeat(60));

testSSE('alice');
testSSE('bob');
testSSE('unknown');

setTimeout(() => {
  testStreamHTTP('alice');
  testStreamHTTP('bob');
  testStreamHTTP('unknown');
}, 12000);
```

Run:
```bash
npm install eventsource
node test-auth.js
```

---

## 📊 Expected results matrix

| Test | User | Endpoint | Method | Expected status | Reason |
|------|------|----------|--------|-----------------|--------|
| 1 | alice | /mcp/stream/sse | GET | 200 | Holds `MCP_Connector` |
| 2 | bob | /mcp/stream/sse | GET | 200 | Holds `MCP_Connector` |
| 3 | unknown | /mcp/stream/sse | GET | 403 | Missing role |
| 4 | (no auth) | /mcp/stream/sse | GET | 401 | Missing Authorization header |
| 5 | alice | /mcp/stream/http | POST | 200 | Holds `MCP_Connector` |
| 6 | bob | /mcp/stream/http | POST | 200 | Holds `MCP_Connector` |
| 7 | unknown | /mcp/stream/http | POST | 403 | Missing role |
| 8 | (no auth) | /mcp/stream/http | POST | 401 | Missing Authorization header |
| 9 | alice | /mcp/stream/http | GET | 404 | Wrong HTTP method |

---

## 🔥 Troubleshooting

### Issue: Always seeing HTTP 500

**Root cause:** The `mcp-abap-adt` backend is not running.

**Fix:**
```bash
# Check whether the backend is running
curl http://127.0.0.1:7070/health

# Start it if needed
cd external/mcp-abap-adt
npm install
npm start
```

### Issue: 401 even with valid Basic auth

**Verify:**
1. Base64 encoding is correct:
   ```bash
   echo "YWxpY2U6" | base64 -d
  # Expected: alice:
   ```

2. Service runs in dev mode:
   ```bash
   cds watch --profile development
   ```

3. Server logs do not report errors

### Issue: SSE connection drops

**Root cause:** Timeout or upstream instability.

**Fix:**
```bash
# Confirm heartbeat events arrive
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse | \
     grep -E "(retry|ping)" | head -n 5
```

---

## 📝 Logging tips

### Enable verbose logging

```bash
# Start cds with debug enabled
DEBUG=* cds watch --profile development
```

### Inspect authorization events

```bash
# Search collected logs for these messages
grep "authShim" logs.txt
grep "MCP_Connector" logs.txt
grep "Unauthorized" logs.txt
grep "Forbidden" logs.txt
```

---

## ✅ Validation checklist

- [ ] Health endpoint responds: `curl http://localhost:4004/mcp/Health`
- [ ] SSE with alice returns 200 and heartbeat
- [ ] SSE with bob returns 200
- [ ] SSE without auth returns 401
- [ ] SSE with unknown returns 403
- [ ] Stream-HTTP with alice returns 200
- [ ] Stream-HTTP with bob returns 200
- [ ] Stream-HTTP without auth returns 401
- [ ] Stream-HTTP with unknown returns 403
- [ ] Logs confirm authorization decisions
- [ ] Smoke tests pass: `cd test/smoke && ./run-all.sh`

---

**Done!** You now have a complete toolkit for testing MCP Proxy authorization. 🎉
