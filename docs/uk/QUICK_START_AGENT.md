# Швидкий старт: Тестування LLM агента

## Швидкий старт

### 1. Встановити залежності

```bash
# Встановити залежності основного проекту
npm install

# Збудувати llm-agent субмодуль
npm install @mcp-abap-adt/llm-proxy
npm install
npm run build
cd ../..
```

### 2. Налаштувати змінні оточення

**Варіант A: Використання .env файлу (рекомендовано для локальної розробки)**

```bash
# Скопіювати .env від агента (якщо вже налаштовано)
touch .env

# Або створити з шаблону
cp .env.template .env

# Редагувати .env і додати API ключі
nano .env
```

**Важливо:** Файл `.env` в корені проекту (`cloud-llm-hub/.env`) - це **той самий файл що й у агента** (`cloud-llm-hub/.env`). Скопіюйте його від агента: `touch .env`

**Варіант B: Експорт змінних оточення**

```bash
# Обов'язково: Провайдер LLM (має бути явно вказаний)
export LLM_PROVIDER="openai"

# Обов'язково: OpenAI API ключ
export OPENAI_API_KEY="sk-your-key-here"

# Опціонально: MCP endpoint (за замовчуванням http://localhost:4004/mcp/stream/http)
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"

# Опціонально: SAP destination (можна також передати через header)
export SAP_DESTINATION="SAP_DEV_DEST"
```

### 3. Запустити сервіс

```bash
cds watch --profile development
```

Сервіс буде доступний на `http://localhost:4004`.

### 4. Протестувати

#### Варіант 1: Використати готовий скрипт

```bash
# З кореня проекту
bash test/test-agent.sh

# Або з папки test
cd test
./test-agent.sh
```

#### Варіант 2: curl вручну

```bash
# Health check
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6"

# Chat (з SAP destination)
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='Hello')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV_DEST"

# Примітка: Агент не знає про destination - cloud-llm-hub wrapper обробляє це
```

#### Варіант 3: Postman

1. Створити новий запит
2. URL: `http://localhost:4004/odata/v4/agent/Chat(message='Hello')`
3. Method: GET
4. Headers:
   - `Authorization: Basic YWxpY2U6`
   - `X-SAP-Destination: SAP_DEV_DEST`

## Що потрібно для тестування

✅ **Обов'язково:**
- OpenAI API ключ (`OPENAI_API_KEY`)
- Запущений CAP сервіс (`cds watch`)
- Доступний MCP proxy endpoint

✅ **Рекомендовано:**
- Налаштований SAP destination або прямі SAP параметри
- `jq` для форматування JSON відповідей

## Доступні ендпойнти

- `GET /odata/v4/agent/Health()` - перевірка стану агента
- `GET /odata/v4/agent/Chat(message='...')` - відправити повідомлення
- `GET /odata/v4/agent/GetHistory()` - отримати історію розмови
- `POST /odata/v4/agent/ClearHistory` - очистити історію

## Детальна документація

- [LLM_PROXY_TESTING.md](../LLM_PROXY_TESTING.md) - повний гайд з тестування
- [LLM_PROXY_EMBEDDED_USAGE.md](../LLM_PROXY_EMBEDDED_USAGE.md) - embedded використання
- [LLM_PROXY_CONFIG_USAGE.md](../LLM_PROXY_CONFIG_USAGE.md) - конфігурація
