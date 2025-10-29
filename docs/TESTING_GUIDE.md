# Посібник з тестування MCP Proxy

Детальні інструкції по тестуванню авторизації для SSE та Stream-HTTP endpoints.

---

## 🚀 Підготовка до тестування

### 1. Запуск сервісу

```bash
# У терміналі 1: запустити CAP сервіс
cd /home/developer/prj/cloud-llm-hub
cds watch --profile development
```

Очікуваний вивід:
```
[cds] - server listening on { url: 'http://localhost:4004' }
[cds] - launched at 10/29/2025, 11:30:00 AM
```

### 2. Підготовка credentials

**alice (admin користувач):**
```bash
# Згенерувати Base64 для alice (порожній пароль)
echo -n "alice:" | base64
# Результат: YWxpY2U6
```

**bob (звичайний користувач):**
```bash
# Згенерувати Base64 для bob (порожній пароль)
echo -n "bob:" | base64
# Результат: Ym9iOg==
```

**Невалідний користувач:**
```bash
# Згенерувати Base64 для unknown
echo -n "unknown:" | base64
# Результат: dW5rbm93bjo=
```

---

## 🔐 Тестування авторизації SSE endpoint

### ✅ Тест 1: Успішна авторизація (alice)

```bash
curl -N -v \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/mcp/stream/sse
```

**Очікуваний результат:**
- HTTP Status: `200 OK`
- Headers містять:
  ```
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive
  ```
- Перший рядок: `retry: 15000`
- Heartbeat кожні 15 секунд: `: ping`

**Приклад виводу:**
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

### ✅ Тест 2: Успішна авторизація (bob)

```bash
curl -N -v \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic Ym9iOg==" \
  http://localhost:4004/mcp/stream/sse
```

**Очікуваний результат:** Те саме що і для alice (обидва мають роль MCP_Connector)

### ❌ Тест 3: Відсутня авторизація

```bash
curl -v \
  -H "Accept: text/event-stream" \
  http://localhost:4004/mcp/stream/sse
```

**Очікуваний результат:**
- HTTP Status: `401 Unauthorized`
- Body: `Unauthorized: Missing or invalid Authorization header`

**Приклад виводу:**
```
< HTTP/1.1 401 Unauthorized
< Content-Type: text/plain; charset=utf-8

Unauthorized: Missing or invalid Authorization header
```

### ❌ Тест 4: Невалідний користувач

```bash
curl -v \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic dW5rbm93bjo=" \
  http://localhost:4004/mcp/stream/sse
```

**Очікуваний результат:**
- HTTP Status: `403 Forbidden` (користувач розпізнається, але не має ролі MCP_Connector)

### ❌ Тест 5: Невалідний формат токену

```bash
curl -v \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer invalid-token-here" \
  http://localhost:4004/mcp/stream/sse
```

**Очікуваний результат:**
- HTTP Status: `401 Unauthorized`
- Body містить помилку: `Missing XSUAA binding in production mode`

### 🔍 Тест 6: Перевірка логів сервера

Після кожного запиту перевіряйте логи в терміналі де запущено `cds watch`:

```
[mcp-proxy/authShim] - Basic auth detected { username: 'alice' }
[mcp-proxy/sse] - SSE connection established { user: 'alice' }
[mcp-proxy/sse] - Connecting to upstream SSE { targetUrl: 'http://127.0.0.1:7070' }
```

Для невалідних запитів:
```
[mcp-proxy/authShim] - Unauthorized request - missing or invalid Authorization header
[mcp-proxy/sse] - Forbidden: User lacks MCP_Connector role { user: 'unknown' }
```

---

## 🔐 Тестування авторизації Stream-HTTP endpoint

### ✅ Тест 1: Успішна авторизація (alice)

```bash
echo '{"command":"test","timestamp":"'$(date -Iseconds)'"}' | \
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic YWxpY2U6" \
  --data-binary @- \
  http://localhost:4004/mcp/stream/http
```

**Очікуваний результат:**
- HTTP Status: `200 OK`
- Headers містять: `Content-Type: application/x-ndjson`
- Відповідь від upstream (якщо backend запущений)

**Альтернативний тест з файлом:**

```bash
# Створити тестовий файл
cat > /tmp/test-stream.ndjson <<EOF
{"command":"tools/list"}
{"command":"tools/call","params":{"name":"test"}}
EOF

# Надіслати
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic YWxpY2U6" \
  --data-binary @/tmp/test-stream.ndjson \
  http://localhost:4004/mcp/stream/http
```

### ✅ Тест 2: Успішна авторизація (bob)

```bash
echo '{"command":"test"}' | \
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic Ym9iOg==" \
  --data-binary @- \
  http://localhost:4004/mcp/stream/http
```

**Очікуваний результат:** 200 OK (bob має роль MCP_Connector)

### ❌ Тест 3: Відсутня авторизація

```bash
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  --data '{"command":"test"}' \
  http://localhost:4004/mcp/stream/http
```

**Очікуваний результат:**
- HTTP Status: `401 Unauthorized`

### ❌ Тест 4: Невалідний користувач

```bash
curl -v -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic dW5rbm93bjo=" \
  --data '{"command":"test"}' \
  http://localhost:4004/mcp/stream/http
```

**Очікуваний результат:**
- HTTP Status: `403 Forbidden`

### ❌ Тест 5: Невалідний метод (GET замість POST)

```bash
curl -v \
  -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/mcp/stream/http
```

**Очікуваний результат:**
- HTTP Status: `404 Not Found` (endpoint доступний тільки для POST)

---

## 🧪 Автоматизовані тести

### Запуск усіх smoke тестів

```bash
cd test/smoke
./run-all.sh
```

### Запуск окремих тестів

```bash
# Health check
./test-health.sh

# SSE тести (включають тести авторизації)
./test-sse.sh

# Stream-HTTP тести (включають тести авторизації)
./test-stream-http.sh
```

---

## 🔍 Перевірка з детальним виводом

### SSE з повним debug виводом

```bash
curl -N -vvv \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/mcp/stream/sse 2>&1 | tee /tmp/sse-test.log
```

Після виконання перегляньте лог:
```bash
cat /tmp/sse-test.log | grep -E "(HTTP|Content-Type|Authorization|retry|ping)"
```

### Stream-HTTP з timing інформацією

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

## 🐍 Python скрипт для тестування

Створіть файл `test_auth.py`:

```python
#!/usr/bin/env python3
import requests
import base64
from sseclient import SSEClient  # pip install sseclient-py

def test_sse_auth(username, password=""):
    """Тестування SSE з авторизацією"""
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
            # Читаємо перші кілька подій
            client = SSEClient(response)
            count = 0
            for event in client.events():
                print(f"📨 Event: {event.data}")
                count += 1
                if count >= 3:
                    break
        else:
            print(f"❌ Body: {response.text}")
            
    except Exception as e:
        print(f"❌ Error: {e}")

def test_stream_http_auth(username, password=""):
    """Тестування Stream-HTTP з авторизацією"""
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
            
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    print("=" * 60)
    print("MCP Proxy Authorization Tests")
    print("=" * 60)
    
    # Тести SSE
    test_sse_auth("alice")      # Має працювати (admin)
    test_sse_auth("bob")        # Має працювати (connector)
    test_sse_auth("unknown")    # Має бути 403
    
    # Тести Stream-HTTP
    test_stream_http_auth("alice")      # Має працювати
    test_stream_http_auth("bob")        # Має працювати
    test_stream_http_auth("unknown")    # Має бути 403
    
    print("\n" + "=" * 60)
    print("Tests completed!")
```

Запуск:
```bash
pip install requests sseclient-py
python3 test_auth.py
```

---

## 🌐 JavaScript/Node.js тестування

Створіть файл `test-auth.js`:

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
  
  // Закрити через 10 секунд
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

// Запустити тести
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

Запуск:
```bash
npm install eventsource
node test-auth.js
```

---

## 📊 Матриця очікуваних результатів

| Тест | Користувач | Endpoint | Метод | Очікуваний статус | Причина |
|------|-----------|----------|-------|-------------------|---------|
| 1 | alice | /mcp/stream/sse | GET | 200 | Має роль MCP_Connector |
| 2 | bob | /mcp/stream/sse | GET | 200 | Має роль MCP_Connector |
| 3 | unknown | /mcp/stream/sse | GET | 403 | Немає ролі |
| 4 | (без auth) | /mcp/stream/sse | GET | 401 | Немає Authorization header |
| 5 | alice | /mcp/stream/http | POST | 200 | Має роль MCP_Connector |
| 6 | bob | /mcp/stream/http | POST | 200 | Має роль MCP_Connector |
| 7 | unknown | /mcp/stream/http | POST | 403 | Немає ролі |
| 8 | (без auth) | /mcp/stream/http | POST | 401 | Немає Authorization header |
| 9 | alice | /mcp/stream/http | GET | 404 | Неправильний HTTP метод |

---

## 🔥 Troubleshooting

### Проблема: Завжди отримую 500 error

**Причина:** Backend `mcp-abap-adt` не запущений

**Рішення:**
```bash
# Перевірити чи backend запущений
curl http://127.0.0.1:7070/health

# Якщо ні - запустити
cd external/mcp-abap-adt
npm install
npm start
```

### Проблема: Отримую 401 навіть з валідним Basic auth

**Перевірити:**
1. Base64 encoding правильний:
   ```bash
   echo "YWxpY2U6" | base64 -d
   # Має вивести: alice:
   ```

2. Сервіс запущений у dev режимі:
   ```bash
   cds watch --profile development
   ```

3. Перевірити логи сервера на наявність помилок

### Проблема: SSE connection обривається

**Причина:** Timeout або проблема з upstream

**Рішення:**
```bash
# Перевірити heartbeat працює
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse | \
     grep -E "(retry|ping)" | head -n 5
```

---

## 📝 Логування для аналізу

### Увімкнути детальне логування

```bash
# Запустити з debug режимом
DEBUG=* cds watch --profile development
```

### Перевірити авторизаційні логи

```bash
# У логах шукати ці повідомлення
grep "authShim" logs.txt
grep "MCP_Connector" logs.txt
grep "Unauthorized" logs.txt
grep "Forbidden" logs.txt
```

---

## ✅ Чеклист для повної перевірки

- [ ] Health endpoint працює: `curl http://localhost:4004/mcp/Health`
- [ ] SSE з alice повертає 200 та heartbeat
- [ ] SSE з bob повертає 200
- [ ] SSE без auth повертає 401
- [ ] SSE з unknown повертає 403
- [ ] Stream-HTTP з alice повертає 200
- [ ] Stream-HTTP з bob повертає 200
- [ ] Stream-HTTP без auth повертає 401
- [ ] Stream-HTTP з unknown повертає 403
- [ ] Логи показують правильну авторизацію
- [ ] Smoke тести проходять: `cd test/smoke && ./run-all.sh`

---

**Готово!** Тепер у вас є повний набір інструментів для тестування авторизації MCP Proxy. 🎉
