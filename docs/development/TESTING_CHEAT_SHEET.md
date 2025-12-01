# 🚀 Quick Testing Commands Cheat Sheet

Quick command reference for testing MCP Proxy authorization flows.

---

## 📋 Preparation

### Start the service

```bash
cds watch --profile development
```

### Generate credentials

```bash
# alice (admin)
echo -n "alice:" | base64
# YWxpY2U6

# bob (connector)
echo -n "bob:" | base64
# Ym9iOg==

# unknown (no roles)
echo -n "unknown:" | base64
# dW5rbm93bjo=
```

---

## ✅ SSE Tests (copy & paste)

### 1. Alice (should succeed ✅)

```bash
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse
```

### 2. Bob (should succeed ✅)

```bash
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic Ym9iOg==" \
     http://localhost:4004/mcp/stream/sse
```

### 3. No authorization (401 ❌)

```bash
curl -v -H "Accept: text/event-stream" \
     http://localhost:4004/mcp/stream/sse
```

### 4. Unknown user (403 ❌)

```bash
curl -v -H "Accept: text/event-stream" \
     -H "Authorization: Basic dW5rbm93bjo=" \
     http://localhost:4004/mcp/stream/sse
```

### 5. With timeout (quick check)

```bash
timeout 5 curl -N -H "Accept: text/event-stream" \
               -H "Authorization: Basic YWxpY2U6" \
               http://localhost:4004/mcp/stream/sse
```

---

## ✅ Stream-HTTP Tests (copy & paste)

### 1. Alice (should succeed ✅)

```bash
echo '{"command":"test","user":"alice"}' | \
curl -X POST \
     -H "Content-Type: application/x-ndjson" \
     -H "Authorization: Basic YWxpY2U6" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

### 2. Bob (should succeed ✅)

```bash
echo '{"command":"test","user":"bob"}' | \
curl -X POST \
     -H "Content-Type: application/x-ndjson" \
     -H "Authorization: Basic Ym9iOg==" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

### 3. No authorization (401 ❌)

```bash
curl -v -X POST \
     -H "Content-Type: application/x-ndjson" \
     --data '{"command":"test"}' \
     http://localhost:4004/mcp/stream/http
```

### 4. Unknown user (403 ❌)

```bash
curl -v -X POST \
     -H "Content-Type: application/x-ndjson" \
     -H "Authorization: Basic dW5rbm93bjo=" \
     --data '{"command":"test"}' \
     http://localhost:4004/mcp/stream/http
```

### 5. NDJSON from file

```bash
cat <<EOF > /tmp/test.ndjson
{"command":"tools/list"}
{"command":"tools/call","params":{"name":"test"}}
EOF

curl -X POST \
     -H "Content-Type: application/x-ndjson" \
     -H "Authorization: Basic YWxpY2U6" \
     --data-binary @/tmp/test.ndjson \
     http://localhost:4004/mcp/stream/http
```

---

## 🧪 Automated tests

### Run the entire suite

```bash
cd test/smoke
./run-all.sh
```

### Authorization-only tests

```bash
cd test/smoke
./test-auth-interactive.sh
```

### Individual scripts

```bash
cd test/smoke
./test-health.sh       # Health check
./test-sse.sh          # SSE endpoint
./test-stream-http.sh  # Stream-HTTP endpoint
```

---

## 🔍 Debug commands

### SSE with verbose output

```bash
curl -N -vvv \
     -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse 2>&1 | tee sse-debug.log
```

### Stream-HTTP with timing information

```bash
echo '{"test":"data"}' | \
curl -w "\nTime: %{time_total}s\nCode: %{http_code}\n" \
     -X POST \
     -H "Content-Type: application/x-ndjson" \
     -H "Authorization: Basic YWxpY2U6" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

### Inspect headers

```bash
curl -I -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/Health
```

---

## 📊 Inspect server logs

### Filter authorization logs

```bash
# Use the terminal running `cds watch`
# Look for the following entries:
```

Expected logs for successful authorization:

```
[mcp-proxy/authShim] - Basic auth detected { username: 'alice' }
[mcp-proxy/sse] - SSE connection established { user: 'alice' }
```

Expected logs when something goes wrong:

```
[mcp-proxy/authShim] - Unauthorized request - missing or invalid Authorization header
[mcp-proxy/sse] - Forbidden: User lacks MCP_Connector role { user: 'unknown' }
```

---

## 🎯 One-liner tests

### Quick health check

```bash
curl -s http://localhost:4004/mcp/Health | jq .
```

### Quick SSE test (5 seconds)

```bash
timeout 5 curl -sN -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/stream/sse | head -5
```

### Verify status codes for each user

```bash
for user in "YWxpY2U6" "Ym9iOg==" "dW5rbm93bjo=" ""; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Accept: text/event-stream" -H "Authorization: Basic $user" http://localhost:4004/mcp/stream/sse)
  echo "User: ${user:-none} -> Status: $code"
done
```

---

## 📱 Testing with other tools

### HTTPie

```bash
# Install: pip install httpie

# SSE
http --stream GET localhost:4004/mcp/stream/sse \
  Accept:text/event-stream \
  Authorization:"Basic YWxpY2U6"

# Stream-HTTP
echo '{"test":"data"}' | http POST localhost:4004/mcp/stream/http \
  Content-Type:application/x-ndjson \
  Authorization:"Basic YWxpY2U6"
```

### Postman / Insomnia

**SSE Request:**

- Method: `GET`
- URL: `http://localhost:4004/mcp/stream/sse`
- Headers:
  - `Accept: text/event-stream`
  - `Authorization: Basic YWxpY2U6`

**Stream-HTTP Request:**

- Method: `POST`
- URL: `http://localhost:4004/mcp/stream/http`
- Headers:
  - `Content-Type: application/x-ndjson`
  - `Authorization: Basic YWxpY2U6`
- Body (raw): `{"command":"test"}`

---

## 🐛 Troubleshooting one-liners

### Is the service running?

```bash
curl -f http://localhost:4004/mcp/Health && echo "✅ Service is running" || echo "❌ Service is down"
```

### Is the backend reachable?

```bash
curl -f http://127.0.0.1:7070/health && echo "✅ Backend is running" || echo "⚠️  Backend not available"
```

### Decode a Base64 credential

```bash
echo "YWxpY2U6" | base64 -d && echo ""
# alice:
```

### Check every endpoint

```bash
for endpoint in "/mcp/Health" "/mcp/stream/sse" "/mcp/stream/http"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:4004$endpoint")
  echo "$endpoint -> $code"
done
```

---

## 🎨 Pretty output with jq

### Format JSON responses

```bash
curl -s http://localhost:4004/mcp/Health | jq .
```

### Extract specific fields

```bash
curl -s http://localhost:4004/mcp/Health | jq -r '.status'
```

---

## 💡 Helpful aliases

Add to `~/.zshrc` or `~/.bashrc`:

```bash
# MCP Proxy shortcuts
alias mcp-start='cd /home/developer/prj/cloud-llm-hub && cds watch --profile development'
alias mcp-health='curl -s http://localhost:4004/mcp/Health | jq .'
alias mcp-sse-alice='timeout 5 curl -sN -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/stream/sse'
alias mcp-test='cd /home/developer/prj/cloud-llm-hub/test/smoke && ./test-auth-interactive.sh'
alias mcp-logs='cd /home/developer/prj/cloud-llm-hub && cds watch --profile development 2>&1 | grep -E "(auth|MCP_|Unauthorized|Forbidden)"'
```

After adding the aliases:

```bash
source ~/.zshrc  # or source ~/.bashrc
```

Usage:

```bash
mcp-start      # Start the service
mcp-health     # Check the health endpoint
mcp-sse-alice  # Quick SSE test
mcp-test       # Run the auth smoke tests
mcp-logs       # Watch authorization logs
```

---

## 🎯 Quick test matrix

| Scenario       | Command                                                                                                                                                             | Expected result                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Health         | `curl localhost:4004/mcp/Health`                                                                                                                                    | 200 with `status: "UP"`            |
| SSE + alice    | `timeout 3 curl -N -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" localhost:4004/mcp/stream/sse`                                                 | 200, retry hint, heartbeat         |
| SSE – no auth  | `curl -I localhost:4004/mcp/stream/sse`                                                                                                                             | 401 Unauthorized                   |
| HTTP + alice   | `echo '{"test":"data"}' \| curl -X POST -H "Authorization: Basic YWxpY2U6" -H "Content-Type: application/x-ndjson" --data-binary @- localhost:4004/mcp/stream/http` | 200 or 502 (if backend is offline) |
| HTTP – no auth | `curl -I -X POST localhost:4004/mcp/stream/http`                                                                                                                    | 401 Unauthorized                   |

---

**All set!** Copy the commands you need and start testing. 🚀
