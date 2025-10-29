# 🚀 Quick Testing Commands Cheat Sheet

Швидкий довідник команд для тестування MCP Proxy авторизації.

---

## 📋 Підготовка

### Запуск сервісу
```bash
cds watch --profile development
```

### Генерація credentials
```bash
# alice (admin)
echo -n "alice:" | base64
# YWxpY2U6

# bob (connector)
echo -n "bob:" | base64
# Ym9iOg==

# unknown (без ролі)
echo -n "unknown:" | base64
# dW5rbm93bjo=
```

---

## ✅ SSE Тести (копіюй і вставляй)

### 1. Alice (має працювати ✅)
```bash
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse
```

### 2. Bob (має працювати ✅)
```bash
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic Ym9iOg==" \
     http://localhost:4004/mcp/stream/sse
```

### 3. Без авторизації (401 ❌)
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

### 5. З timeout (для швидкого тесту)
```bash
timeout 5 curl -N -H "Accept: text/event-stream" \
               -H "Authorization: Basic YWxpY2U6" \
               http://localhost:4004/mcp/stream/sse
```

---

## ✅ Stream-HTTP Тести (копіюй і вставляй)

### 1. Alice (має працювати ✅)
```bash
echo '{"command":"test","user":"alice"}' | \
curl -X POST \
     -H "Content-Type: application/x-ndjson" \
     -H "Authorization: Basic YWxpY2U6" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

### 2. Bob (має працювати ✅)
```bash
echo '{"command":"test","user":"bob"}' | \
curl -X POST \
     -H "Content-Type: application/x-ndjson" \
     -H "Authorization: Basic Ym9iOg==" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

### 3. Без авторизації (401 ❌)
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

### 5. NDJSON з файлу
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

## 🧪 Автоматичні тести

### Запустити всі тести
```bash
cd test/smoke
./run-all.sh
```

### Тільки тести авторизації
```bash
cd test/smoke
./test-auth-interactive.sh
```

### Окремі тести
```bash
cd test/smoke
./test-health.sh       # Health check
./test-sse.sh          # SSE endpoint
./test-stream-http.sh  # Stream-HTTP endpoint
```

---

## 🔍 Debug команди

### SSE з повним виводом
```bash
curl -N -vvv \
     -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse 2>&1 | tee sse-debug.log
```

### Stream-HTTP з timing
```bash
echo '{"test":"data"}' | \
curl -w "\nTime: %{time_total}s\nCode: %{http_code}\n" \
     -X POST \
     -H "Content-Type: application/x-ndjson" \
     -H "Authorization: Basic YWxpY2U6" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

### Перевірка headers
```bash
curl -I -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/Health
```

---

## 📊 Перевірка логів сервера

### Фільтрувати логи авторизації
```bash
# У терміналі де запущено cds watch
# Шукати ці рядки:
```

Очікувані логи для успішної авторизації:
```
[mcp-proxy/authShim] - Basic auth detected { username: 'alice' }
[mcp-proxy/sse] - SSE connection established { user: 'alice' }
```

Очікувані логи для помилок:
```
[mcp-proxy/authShim] - Unauthorized request - missing or invalid Authorization header
[mcp-proxy/sse] - Forbidden: User lacks MCP_Connector role { user: 'unknown' }
```

---

## 🎯 One-liner тести

### Швидкий health check
```bash
curl -s http://localhost:4004/mcp/Health | jq .
```

### Швидкий SSE test (5 секунд)
```bash
timeout 5 curl -sN -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/stream/sse | head -5
```

### Перевірити всі статус коди
```bash
for user in "YWxpY2U6" "Ym9iOg==" "dW5rbm93bjo=" ""; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Accept: text/event-stream" -H "Authorization: Basic $user" http://localhost:4004/mcp/stream/sse)
  echo "User: ${user:-none} -> Status: $code"
done
```

---

## 📱 Тестування з інших інструментів

### HTTPie
```bash
# Встановити: pip install httpie

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

### Чи сервіс запущений?
```bash
curl -f http://localhost:4004/mcp/Health && echo "✅ Service is running" || echo "❌ Service is down"
```

### Чи backend доступний?
```bash
curl -f http://127.0.0.1:7070/health && echo "✅ Backend is running" || echo "⚠️  Backend not available"
```

### Декодувати Base64 credential
```bash
echo "YWxpY2U6" | base64 -d && echo ""
# alice:
```

### Перевірити всі endpoints
```bash
for endpoint in "/mcp/Health" "/mcp/stream/sse" "/mcp/stream/http"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:4004$endpoint")
  echo "$endpoint -> $code"
done
```

---

## 🎨 Pretty output з jq

### Format JSON responses
```bash
curl -s http://localhost:4004/mcp/Health | jq .
```

### Extract specific fields
```bash
curl -s http://localhost:4004/mcp/Health | jq -r '.status'
```

---

## 💡 Корисні alias

Додай у `~/.zshrc` або `~/.bashrc`:

```bash
# MCP Proxy shortcuts
alias mcp-start='cd /home/developer/prj/cloud-llm-hub && cds watch --profile development'
alias mcp-health='curl -s http://localhost:4004/mcp/Health | jq .'
alias mcp-sse-alice='timeout 5 curl -sN -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/stream/sse'
alias mcp-test='cd /home/developer/prj/cloud-llm-hub/test/smoke && ./test-auth-interactive.sh'
alias mcp-logs='cd /home/developer/prj/cloud-llm-hub && cds watch --profile development 2>&1 | grep -E "(auth|MCP_|Unauthorized|Forbidden)"'
```

Після додавання:
```bash
source ~/.zshrc  # або source ~/.bashrc
```

Використання:
```bash
mcp-start      # Запустити сервіс
mcp-health     # Перевірити health
mcp-sse-alice  # Швидкий SSE тест
mcp-test       # Запустити всі тести
mcp-logs       # Дивитись логи авторизації
```

---

## 🎯 Матриця швидких тестів

| Що тестуємо | Команда | Очікуваний результат |
|-------------|---------|---------------------|
| Health | `curl localhost:4004/mcp/Health` | 200, JSON з status:UP |
| SSE + alice | `timeout 3 curl -N -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" localhost:4004/mcp/stream/sse` | 200, retry hint, heartbeat |
| SSE - no auth | `curl -I localhost:4004/mcp/stream/sse` | 401 Unauthorized |
| HTTP + alice | `echo '{"test":"data"}' \| curl -X POST -H "Authorization: Basic YWxpY2U6" -H "Content-Type: application/x-ndjson" --data-binary @- localhost:4004/mcp/stream/http` | 200 або 502 (якщо backend down) |
| HTTP - no auth | `curl -I -X POST localhost:4004/mcp/stream/http` | 401 Unauthorized |

---

**Готово!** Скопіюй потрібні команди та тестуй! 🚀
