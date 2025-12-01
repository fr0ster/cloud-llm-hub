# ⚡ Швидкий старт

**Версія:** 1.0.0  
**Останнє оновлення:** 2025-11-05

**Почніть за 60 секунд!** Найшвидший спосіб підключити ваші інструменти до SAP через Cloud LLM Hub.

## 🎯 Налаштування однією командою

### Для Cline (VS Code)

```bash
# Завантажте та запустіть налаштування
curl -sSL https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js | \
  node - --template cloud-destination \
    --connection sap-dev \
    --mcp-app cloud-llm-hub \
    --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
    --service-key-file sapAbap=./keys/sap-abap.json
```

**Що це робить:**

1. Завантажує інструмент налаштування
2. Генерує конфігурацію для Cline
3. Автоматично оновлює налаштування Cline
4. Готово до використання!

**Перезапустіть VS Code** і Cline автоматично підключиться.

---

## 🚀 Варіанти розгортання

### Варіант 1: Використати існуюче розгортання (Найшвидше)

Якщо у вас вже є розгортання Cloud LLM Hub:

```bash
# Просто налаштуйте клієнта
export MCP_ENDPOINT="https://your-app.cfapps.eu10.hana.ondemand.com"
export MCP_TOKEN="your-xsuaa-token"
export SAP_DEST="SAP_DEV_DEST"
```

### Варіант 2: Розгорнути на SAP BTP

```bash
# Клонуйте та розгорніть
git clone https://github.com/fr0ster/cloud-llm-hub.git
cd cloud-llm-hub
npm install

# Розгорніть (потрібен CF CLI та логін)
npm run deploy
```

**Час:** ~5 хвилин

---

## 📋 Чекліст конфігурації

### ✅ Передумови

- [ ] Обліковий запис SAP BTP (або використайте існуюче розгортання)
- [ ] Доступ до SAP системи (прямий URL або Destination)
- [ ] Екземпляр сервісу XSUAA (для аутентифікації)
- [ ] Екземпляр сервісу Destination (для режиму destination)

### ✅ Швидка конфігурація

1. **Отримайте сервісні ключі:**

   ```bash
   cf service-key cloud-llm-hub-auth mcp > keys/mcp-xsuaa.json
   cf service-key sap-abap-backend abap > keys/sap-abap.json
   ```

2. **Згенеруйте конфігурацію:**

   ```bash
   node tools/update-cline-connection.js \
     --template cloud-destination \
     --connection my-sap-system \
     --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
     --service-key-file sapAbap=./keys/sap-abap.json
   ```

3. **Перевірте підключення:**
   ```bash
   curl -H "Authorization: Bearer \$(jq -r .access_token keys/mcp-xsuaa.json)" \
        https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)
   ```

---

## 🎨 Шаблони швидкого старту

### Cloud з Destination (Рекомендовано)

```bash
node tools/update-cline-connection.js \
  --template cloud-destination \
  --connection sap-prod \
  --mcp-app cloud-llm-hub \
  --destination-name SAP_PROD_DEST \
  --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json
```

### Пряме підключення (Локальна розробка)

```bash
node tools/update-cline-connection.js \
  --template direct-jwt \
  --connection sap-dev \
  --mcp-endpoint http://localhost:4004/mcp/stream/http \
  --service-key-file sapAbapXsuaa=./keys/sap-abap.json
```

### Basic Auth (Тестування)

```bash
node tools/update-cline-connection.js \
  --template direct-basic \
  --connection sap-test \
  --mcp-endpoint http://localhost:4004/mcp/stream/sse \
  --mcp-username alice \
  --mcp-password "" \
  --sap-username developer \
  --sap-password "change-me"
```

---

## 🔧 Змінні середовища

Швидке налаштування через змінні середовища:

```bash
export MCP_ENDPOINT="https://your-app.cfapps.eu10.hana.ondemand.com"
export MCP_XSUAA_TOKEN="your-token"
export SAP_DESTINATION="SAP_DEV_DEST"

# Або для прямого режиму
export SAP_URL="https://your-sap-system.com"
export SAP_CLIENT="210"
export SAP_JWT_TOKEN="your-sap-token"
```

---

## 📱 Швидкі старти для клієнтів

### Cline (VS Code)

```bash
# Налаштування однією командою
node tools/update-cline-connection.js --template cloud-destination \
  --connection sap-dev --mcp-app cloud-llm-hub \
  --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
  --service-key-file sapAbap=./keys/sap-abap.json
```

### Claude Desktop

1. Завантажте шаблон конфігурації:

   ```bash
   curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/docs/templates/mcp-config/cloud-destination.yaml
   ```

2. Заповніть ваші значення
3. Конвертуйте в формат Claude Desktop
4. Додайте до налаштувань Claude Desktop

### n8n / Zapier / Make.com

Використайте HTTP Request nodes з:

- **URL:** Ваш MCP endpoint
- **Headers:** Authorization + X-SAP-Destination
- **Body:** Формат MCP JSON-RPC

Див. [Приклади інтеграцій](../INTEGRATIONS.md) для деталей.

---

## 🧪 Перевірте ваше налаштування

```bash
# Перевірка здоров'я
curl -H "Authorization: Bearer $MCP_TOKEN" \
     https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)

# Тест MCP виклику
curl -X POST https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "X-SAP-Destination: $SAP_DEST" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "GetObjectList",
      "arguments": {"objectType": "CLAS"}
    }
  }'
```

---

## 🎉 Чекліст успіху

- [ ] MCP endpoint доступний
- [ ] Аутентифікація працює
- [ ] Підключення до SAP встановлено
- [ ] Можна викликати MCP інструменти
- [ ] Клієнт налаштований та підключений

**Все відмічено?** Ви готові до роботи! 🚀

---

## 📚 Наступні кроки

- **Приклади інтеграцій:** [INTEGRATIONS.md](../INTEGRATIONS.md)
- **Детальне налаштування:** [GETTING_STARTED.md](../GETTING_STARTED.md)
- **Гайд конфігурації:** [MCP_CONFIG_UPDATE_HOWTO.md](../MCP_CONFIG_UPDATE_HOWTO.md)
- **API довідка:** [MCP_PROXY_USAGE.md](../MCP_PROXY_USAGE.md)

---

**Потрібна допомога?** Перевірте документацію або відкрийте issue!

---

**Переклад:** Українська версія  
**Оригінал:** [QUICK_SETUP.md](../QUICK_SETUP.md)
