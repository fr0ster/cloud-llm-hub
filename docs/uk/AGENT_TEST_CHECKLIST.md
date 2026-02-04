# Чеклист: Тестування LLM агента

## ✅ Перед тестуванням

### 1. Встановити залежності

```bash
# З кореня проекту
npm install

# Збудувати llm-agent субмодуль
npm install @mcp-abap-adt/llm-proxy
npm install
npm run build
cd ../..
```

### 2. Налаштувати змінні оточення

**Варіант A: Використання .env файлу (рекомендовано)**

```bash
# Скопіювати .env від агента (це файл від агента)
touch .env

# Редагувати .env і впевнитися що LLM_PROVIDER встановлено
nano .env
```

**Важливо:** Файл `.env` в корені проекту (`cloud-llm-hub/.env`) - це **той самий файл що й у агента** (`cloud-llm-hub/.env`). Скопіюйте його від агента: `touch .env`

**Варіант B: Експорт змінних оточення**

**Обов'язково:**
```bash
# Провайдер LLM має бути явно вказаний
export LLM_PROVIDER="openai"
export OPENAI_API_KEY="sk-your-openai-api-key-here"
```

**Опціонально:**
```bash
# Якщо MCP endpoint не на localhost:4004
export MCP_ENDPOINT="http://your-host:port/mcp/stream/http"

# Якщо хочете використовувати іншу модель OpenAI
export OPENAI_MODEL="gpt-4o-mini"  # або gpt-4, gpt-3.5-turbo тощо
```

### 3. Перевірити що MCP Proxy працює

MCP Proxy запускається автоматично з CAP сервісом, але можна перевірити:

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/mcp/Health()" \
  -H "Authorization: Basic YWxpY2U6"
```

Очікується: `{"status":"UP",...}`

### 4. Запустити CAP сервіс

```bash
cds watch --profile development
```

Сервіс буде доступний на `http://localhost:4004`

## 🧪 Тестування

### Швидкий тест (готовий скрипт)

```bash
# З кореня проекту
bash test/test-agent.sh
```

### Ручне тестування

#### 1. Health Check

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6"
```

**Очікується:**
```json
{
  "status": "READY",
  "agentReady": true,
  "mcpConnected": true,
  "llmProvider": "OpenAI",
  "timestamp": "..."
}
```

#### 2. Простий Chat (без SAP)

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='Hello')" \
  -H "Authorization: Basic YWxpY2U6"
```

#### 3. Chat з SAP Destination

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='What tools are available?')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

#### 4. Chat з прямими SAP параметрами (без Destination)

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='Hello')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-URL: https://your-sap-system.example.com" \
  -H "X-SAP-Auth-Type: jwt" \
  -H "X-SAP-JWT-Token: your-jwt-token"
```

#### 5. Отримати історію

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/GetHistory()" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

#### 6. Очистити історію

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/agent/ClearHistory" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

## 🔍 Що перевіряти

### Успішне тестування означає:

1. ✅ Health check повертає `status: "READY"`
2. ✅ `agentReady: true` - агент створено
3. ✅ `mcpConnected: true` - агент підключено до MCP
4. ✅ Chat повертає відповідь від LLM
5. ✅ Історія зберігається між запитами
6. ✅ ClearHistory очищає історію

### Типові помилки:

#### ❌ "LLM provider must be explicitly specified" або "OPENAI_API_KEY is required"
**Рішення:** 
- Встановити `LLM_PROVIDER=openai` в `.env` файлі (скопіювати від агента: `touch .env`)
- Або експортувати: `export LLM_PROVIDER="openai"` та `export OPENAI_API_KEY="sk-..."`

#### ❌ "MCP client configuration required"
**Рішення:** Перевірте що MCP proxy працює (`/odata/v4/mcp/Health()`)

#### ❌ "Connection failed" або `mcpConnected: false`
**Рішення:** 
- Перевірте що CAP сервіс запущено
- Перевірте що MCP proxy endpoint доступний
- Перевірте логи CAP сервісу

#### ❌ Agent повертає порожню відповідь
**Рішення:**
- Перевірте що OpenAI API key валідний
- Перевірте що модель доступна (gpt-4o-mini за замовчуванням)
- Перевірте логи на помилки

## 📝 Примітки

1. **Destination vs Direct:** 
   - Використовуйте `X-SAP-Destination` для destination mode
   - Використовуйте `X-SAP-URL`, `X-SAP-Auth-Type`, тощо для direct mode

2. **Кешування:**
   - Агент кешується по destination/config
   - Історія зберігається в кешованому агенті
   - Різні destinations = різні агенти = різні історії

3. **MCP Proxy:**
   - Запускається автоматично з CAP
   - Endpoint: `http://localhost:4004/mcp/stream/http`
   - Обробляє headers і створює embedded MCP server

## 🚀 Готово до тестування!

Якщо всі пункти виконано, можна тестувати:

```bash
# 1. Встановити OpenAI ключ
export OPENAI_API_KEY="sk-..."

# 2. Запустити сервіс (в одному терміналі)
cds watch --profile development

# 3. Запустити тести (в іншому терміналі)
bash test/test-agent.sh
```
