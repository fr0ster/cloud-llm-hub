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
./test-stream-http.sh  # Stream-HTTP endpoint
```

---

## 🔍 Debug commands

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
```

Expected logs when something goes wrong:

```
[mcp-proxy/authShim] - Unauthorized request - missing or invalid Authorization header
```

---

## 🎯 One-liner tests

### Quick health check

```bash
curl -s http://localhost:4004/mcp/Health | jq .
```

### Verify status codes for each user

```bash
for user in "YWxpY2U6" "Ym9iOg==" "dW5rbm93bjo=" ""; do
  code=$(echo '{"command":"test"}' | curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/x-ndjson" -H "Authorization: Basic $user" --data-binary @- http://localhost:4004/mcp/stream/http)
  echo "User: ${user:-none} -> Status: $code"
done
```

---

## 📱 Testing with other tools

### HTTPie

```bash
# Install: pip install httpie

# Stream-HTTP
echo '{"test":"data"}' | http POST localhost:4004/mcp/stream/http \
  Content-Type:application/x-ndjson \
  Authorization:"Basic YWxpY2U6"
```

### Postman / Insomnia

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
for endpoint in "/mcp/Health" "/mcp/stream/http"; do
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
mcp-test       # Run the auth smoke tests
mcp-logs       # Watch authorization logs
```

---

## 🎯 Quick test matrix

| Scenario       | Command                                                                                                                                                             | Expected result                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Health         | `curl localhost:4004/mcp/Health`                                                                                                                                    | 200 with `status: "UP"`            |
| HTTP + alice   | `echo '{"test":"data"}' \| curl -X POST -H "Authorization: Basic YWxpY2U6" -H "Content-Type: application/x-ndjson" --data-binary @- localhost:4004/mcp/stream/http` | 200 or 502 (if backend is offline) |
| HTTP – no auth | `curl -I -X POST localhost:4004/mcp/stream/http`                                                                                                                    | 401 Unauthorized                   |

---

**All set!** Copy the commands you need and start testing. 🚀
