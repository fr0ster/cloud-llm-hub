# Гайд вирішення проблем

**Версія:** 1.0.0  
**Останнє оновлення:** 2025-11-05

Швидкий довідник з типових проблем та їх вирішення при використанні Cloud LLM Hub.

## 🔍 Швидка діагностика

### Перевірка здоров'я сервісу

```bash
# Перевірка здоров'я
curl -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/odata/v4/mcp/Health\(\)

# Очікується: {"status":"UP","timestamp":"..."}
```

### Перевірка логів

```bash
# Локальна розробка
cds watch --profile development --debug

# Cloud Foundry
cf logs cloud-llm-hub-srv --recent
cf logs cloud-llm-hub-srv  # Потік логів
```

### Перевірка прив'язок сервісів

```bash
# Перевірка прив'язаних сервісів
cf services

# Перевірка прив'язок сервісів
cf env cloud-llm-hub-srv
```

---

## 🔐 Проблеми з аутентифікацією

### Проблема: 401 Unauthorized

**Симптоми:**
- Запити повертають `401 Unauthorized`
- Повідомлення про помилку "Authentication required"

**Можливі причини:**
1. Відсутній заголовок `Authorization`
2. Невалідний або застарілий JWT токен
3. Неправильні облікові дані Basic auth
4. Сервіс XSUAA не прив'язаний

**Рішення:**

**1. Перевірте заголовок Authorization:**
```bash
# Перевірте, що заголовок присутній
curl -v -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/odata/v4/mcp/Health\(\)
```

**2. Оновіть токен XSUAA:**
```bash
# Отримайте новий токен
curl -X POST "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<client-id>" \
  -d "client_secret=<client-secret>"
```

**3. Перевірте прив'язку сервісу:**
```bash
# Перевірте сервіс XSUAA
cf services | grep xsuaa

# Прив'яжіть сервіс якщо відсутній
cf bind-service cloud-llm-hub-srv cloud-llm-hub-auth
cf restage cloud-llm-hub-srv
```

**4. Перевірте режим розробки:**
```bash
# Переконайтеся що активний профіль розробки
cds watch --profile development

# Використайте правильний Basic auth (alice: порожній пароль)
echo -n "alice:" | base64  # Має бути YWxpY2U6
```

---

### Проблема: 403 Forbidden

**Симптоми:**
- Запити повертають `403 Forbidden`
- Повідомлення про помилку "Insufficient permissions"

**Можливі причини:**
1. Користувач не має необхідних scopes
2. Role collection не призначена
3. Неправильна конфігурація XSUAA

**Рішення:**

**1. Перевірте ролі користувача:**
```bash
# Користувачі розробки
# alice: MCP_Connector, MCP_Admin
# bob: MCP_Connector

# Перевірте з правильним користувачем
curl -H "Authorization: Basic YWxpY2U6" \  # alice
     http://localhost:4004/odata/v4/mcp/Health\(\)
```

**2. Перевірте XSUAA Scopes:**
- Перевірте `xs-security.json` на наявність необхідних scopes
- Переконайтеся що role collections налаштовані
- Перевірте що користувач має роль `MCP_Connector`

**3. Перевірте ролі в продакшені:**
```bash
# В BTP Cockpit
# Перейдіть до Security → Role Collections
# Призначте роль MCP_Connector користувачу
```

---

## 🔌 Проблеми з підключенням

### Проблема: Connection Timeout

**Симптоми:**
- Запити тайм-аутують після 30-60 секунд
- Помилки "ETIMEDOUT" в логах
- Немає відповіді від SAP системи

**Можливі причини:**
1. SAP система недоступна
2. Проблеми з мережею
3. Блокування файрволом
4. Cloud Connector не налаштований

**Рішення:**

**1. Перевірте підключення до SAP:**
```bash
# Тест прямого підключення
curl -v https://your-sap-system.com/sap/bc/adt/discovery

# Перевірте статус Cloud Connector
# В адмін-панелі Cloud Connector
```

**2. Перевірте конфігурацію Destination:**
```bash
# Перевірте destination
curl -H "Authorization: Basic YWxpY2U6" \
     "http://localhost:4004/odata/v4/mcp/ProbeDestination?destination=SAP_DEV_DEST"
```

**3. Перевірте мережу/файрвол:**
- Перевірте що SAP система доступна з Cloud Foundry
- Перевірте правила файрволу для Cloud Connector
- Перевірте Location ID Cloud Connector

**4. Перевірте Cloud Connector:**
```bash
# Перевірте що Cloud Connector запущений
# Перевірте адмін-панель Cloud Connector
# Перевірте що тунель активний
# Перевірте що Location ID відповідає конфігурації
```

---

### Проблема: 502 Bad Gateway

**Симптоми:**
- Запити повертають `502 Bad Gateway`
- Помилки "MCP server connection failed"

**Можливі причини:**
1. MCP сервер не ініціалізований
2. Підключення до SAP не вдалося
3. Невалідні облікові дані SAP
4. Помилка конфігурації destination

**Рішення:**

**1. Перевірте статус MCP сервера:**
```bash
# Перевірте що MCP сервер запущений (якщо standalone)
curl http://127.0.0.1:7070/health

# Перевірте логи на помилки ініціалізації
cds watch --profile development --debug
```

**2. Перевірте облікові дані SAP:**
```bash
# Тест підключення до SAP напряму
curl -u username:password \
     https://sap-system.com/sap/bc/adt/discovery
```

**3. Перевірте конфігурацію Destination:**
- Перевірте що ім'я destination правильне
- Перевірте облікові дані destination в BTP Cockpit
- Перевірте що тип аутентифікації відповідає

**4. Скиньте сесію MCP:**
```bash
# Пропустіть заголовок Mcp-Session-Id щоб примусити ре-ініціалізацію
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     # БЕЗ Mcp-Session-Id заголовка
     --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:4004/mcp/stream/http
```

---

## 🌐 Проблеми з Destination

### Проблема: Destination Not Found

**Симптоми:**
- `404 Not Found` для destination
- Помилка "Destination not found"

**Рішення:**

**1. Перевірте що Destination існує:**
```bash
# Перевірте в BTP Cockpit
# Connectivity → Destinations
# Переконайтеся що ім'я destination точно відповідає
```

**2. Перевірте прив'язку сервісу:**
```bash
# Перевірте що Destination сервіс прив'язаний
cf services | grep destination

# Прив'яжіть якщо відсутній
cf bind-service cloud-llm-hub-srv cloud-llm-hub-destination
cf restage cloud-llm-hub-srv
```

**3. Перевірте ім'я Destination:**
```bash
# Використайте точне ім'я destination (чутливе до регістру)
curl -H "Authorization: Basic YWxpY2U6" \
     -H "X-SAP-Destination: SAP_DEV_DEST" \  # Точне ім'я
     http://localhost:4004/mcp/stream/http
```

---

### Проблема: Cloud Connector Issues

**Симптоми:**
- On-premise destinations не працюють
- Тайм-аути підключення
- Помилки "Tunnel not found"

**Рішення:**

**1. Перевірте конфігурацію Cloud Connector:**
- Перевірте що `ConnectorID` в `mta.yaml` відповідає Cloud Connector
- Перевірте що Location ID в destination відповідає Cloud Connector
- Перевірте адмін-панель Cloud Connector для статусу тунелю

**2. Перевірте Connectivity Service:**
```bash
# Перевірте що Connectivity сервіс прив'язаний
cf services | grep connectivity

# Прив'яжіть якщо відсутній
cf bind-service cloud-llm-hub-srv cloud-llm-hub-connectivity
cf restage cloud-llm-hub-srv
```

**3. Перевірте Location ID:**
```bash
# Перевірте конфігурацію destination
# Переконайтеся що CloudConnectorLocationId відповідає Cloud Connector
# Або використайте заголовок X-SAP-Connectivity-Location-ID
```

---

## 📡 Проблеми зі стримінгом

### Проблема: SSE Stream Disconnects

**Симптоми:**
- SSE підключення несподівано закривається
- Heartbeat не отримується
- Помилки тайм-ауту підключення

**Рішення:**

**1. Перевірте стабільність мережі:**
```bash
# Тест з детальним curl
curl -v -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse
```

**2. Перевірте Heartbeat:**
- SSE повинен відправляти `: ping` кожні 15 секунд
- Якщо відсутній, перевірте логи сервера
- Перевірте налаштування тайм-ауту

**3. Обробка переподключення:**
```javascript
// Клієнт повинен обробляти переподключення
eventSource.onerror = (error) => {
  // Переподключення після затримки
  setTimeout(() => {
    eventSource = new EventSource(url);
  }, 15000);
};
```

---

### Проблема: Stream-HTTP Session Issues

**Симптоми:**
- Помилки "Server already initialized"
- Сесія не зберігається
- Запити не вдаються після першого виклику

**Рішення:**

**1. Перевірте управління сесією:**
```bash
# Перший запит: Пропустіть Mcp-Session-Id
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:4004/mcp/stream/http

# Відповідь містить: Mcp-Session-Id: <session-id>

# Наступні запити: Включіть Mcp-Session-Id
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Mcp-Session-Id: <session-id-from-previous-response>" \
     -H "Content-Type: application/x-ndjson" \
     --data '{"jsonrpc":"2.0","id":2,"method":"tools/call",...}' \
     http://localhost:4004/mcp/stream/http
```

**2. Скиньте сесію:**
```bash
# Пропустіть Mcp-Session-Id щоб примусити ре-ініціалізацію
# Корисно після ротації облікових даних
```

**3. Перевірте закінчення сесії:**
- Сесії закінчуються після 30 хвилин бездіяльності
- Кеш очищується при перезапуску проксі
- Примусити ре-ініціалізацію якщо потрібно

---

## 🐛 Проблеми розробки

### Проблема: Port Already in Use

**Симптоми:**
- Помилка `EADDRINUSE`
- Неможливо запустити сервер на порту 4004

**Рішення:**

```bash
# Знайдіть процес що використовує порт
lsof -i :4004
# або (Linux)
netstat -tulpn | grep 4004

# Завершіть процес
kill -9 <PID>

# Або використайте інший порт
PORT=4005 cds watch
```

---

### Проблема: TypeScript Compilation Errors

**Симптоми:**
- Помилки типів під час збірки
- Помилки резолюції імпортів

**Рішення:**

```bash
# Перевірте помилки TypeScript
npm exec -- tsc --noEmit

# Очистіть та перебудуйте
rm -rf dist/ node_modules/@types
npm install
npm exec -- tsc --noEmit
```

---

### Проблема: Submodule Issues

**Симптоми:**
- MCP сервер не знайдено
- Помилки імпорту з submodule

**Рішення:**

```bash
# Ре-ініціалізуйте submodules
git submodule deinit --all
git submodule update --init --recursive

# Зберіть submodule
cd submodules/mcp-abap-adt
npm install
npm run build
cd ../..
```

---

## 📋 Типові повідомлення про помилки

### "Invalid Request: Server already initialized"

**Причина:** MCP сесія вже існує, але запит не включає `Mcp-Session-Id`.

**Рішення:** Включіть заголовок `Mcp-Session-Id` з попередньої відповіді, або пропустіть його щоб скинути.

---

### "Destination not found"

**Причина:** Ім'я destination не існує або сервіс не прив'язаний.

**Рішення:** Перевірте ім'я destination та прив'язку сервісу.

---

### "Connection timeout"

**Причина:** Неможливо досягти SAP систему або Cloud Connector.

**Рішення:** Перевірте підключення до мережі та статус Cloud Connector.

---

### "Authentication failed"

**Причина:** Невалідні облікові дані SAP або токен застарів.

**Рішення:** Перевірте облікові дані та оновіть токени.

---

## 🔗 Отримання допомоги

### Додаткові ресурси

- [API Reference](../API_REFERENCE.md) - Повна специфікація API
- [MCP Proxy Usage](../MCP_PROXY_USAGE.md) - Детальний гайд використання
- [Debugging Guide](../DEBUGGING.md) - Техніки дебагу
- [MCP Config Update How-To](../MCP_CONFIG_UPDATE_HOWTO.md) - Допомога з конфігурацією

### Канали підтримки

- **GitHub Issues:** Повідомте про баги та запитуйте функції
- **GitHub Discussions:** Задавайте питання та діліться ідеями
- **Документація:** Перевірте папку docs/ для гайдів

---

**Останнє оновлення:** 2025-11-05  
**Версія:** 1.0.0

---

**Переклад:** Українська версія  
**Оригінал:** [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

