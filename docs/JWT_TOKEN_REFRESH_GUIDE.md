# JWT Token Refresh Guide

## Проблема

При використанні JWT автентифікації з Cloud LLM Hub, токени не оновлювались автоматично при роботі через cloud-llm-hub proxy, хоча працювали у standalone mcp-abap-adt з тими ж credentials.

### Коренева причина

**Архітектурна проблема в mcp-manager.ts**: Створювався глобальний `overrideConnection` при запуску сервера, який **БЛОКУВАВ** використання session-specific configuration з HTTP headers.

Механізм роботи:
1. При створенні `new mcp_abap_adt_server(serverOptions)` з `serverOptions.sapConfig`
2. В конструкторі викликався `setSapConfigOverride(options?.sapConfig)`
3. Це створювало **глобальний** `overrideConnection` з початковим (можливо неповним) config
4. При обробці HTTP запитів `getManagedConnection()` **ЗАВЖДИ** повертав цей `overrideConnection`
5. Session context з AsyncLocalStorage **ІГНОРУВАВСЯ** через early return в `getManagedConnection()`

**Результат**: Connection створювався **один раз** при старті з неповним config (без refresh token/UAA params), а per-request credentials з headers **НЕ ВИКОРИСТОВУВАЛИСЬ**.

### OAuth2 Refresh Token Requirements

Для автоматичного оновлення JWT токенів за стандартом **OAuth2 RFC 6749**, пакет `@mcp-abap-adt/connection` (клас `JwtAbapConnection`) вимагає **чотири параметри**:

1. ✅ `refreshToken` - refresh token отриманий при OAuth2 автентифікації
2. ❌ `uaaUrl` - UAA endpoint URL з service key (раніше не передавався)
3. ❌ `uaaClientId` - OAuth2 client ID з service key (раніше не передавався)
4. ❌ `uaaClientSecret` - OAuth2 client secret з service key (раніше не передавався)

**Важливо**: Це **вимога стандарту OAuth2 RFC 6749**. Refresh token **прив'язаний до конкретного OAuth2 клієнта** (client_id + client_secret з service key) і не може бути використаний без автентифікації цього клієнта.

### Як це працює

1. **Отримання токенів** (через `sap-abap-auth` утиліту):
   - Утиліта читає service key (містить uaaUrl, clientId, clientSecret)
   - Відкриває браузер для OAuth2 Authorization Code flow
   - Отримує authorization code від UAA
   - Обмінює code на **access_token + refresh_token** використовуючи client credentials
   - Refresh token **прив'язаний** до цих client credentials

2. **Refresh токена**:
   - Для refresh потрібен той **самий client_id + client_secret** з якого був отриманий refresh token
   - Refresh token без client credentials **не працює** (OAuth2 security requirement)
   - UAA перевіряє що refresh token належить саме цьому клієнту

Код `JwtAbapConnection.refreshToken()` перевіряє всі чотири параметри:

```javascript
if (!config.refreshToken) {
    throw new Error("Refresh token is not available. Please re-authenticate.");
}

if (!config.uaaUrl || !config.uaaClientId || !config.uaaClientSecret) {
    throw new Error("UAA credentials are not available for token refresh. " +
        "Please provide UAA_URL, UAA_CLIENT_ID, and UAA_CLIENT_SECRET in configuration or re-authenticate.");
}
```

### Що було

До виправлення, в `mcp-manager.ts` та `server.ts` з headers витягувався **тільки** `X-SAP-Refresh-Token`:

```typescript
const sapRefreshToken = (req.headers['x-sap-refresh-token'] as string | undefined)?.trim();

if (sapRefreshToken) {
  sapConfig.refreshToken = sapRefreshToken;
}
```

Але UAA параметри **не витягувались**, тому `canRefreshToken()` завжди повертав `false`.

## Рішення

### 1. Архітектурний фікс (mcp-manager.ts)

**ДО виправлення**:
```typescript
} else {
  // BUG: Passing sapConfig creates global overrideConnection
  serverOptions.sapConfig = sapConfig;
}
```

**ПІСЛЯ виправлення**:
```typescript
} else {
  // FIXED: DO NOT pass sapConfig to constructor for HTTP transport!
  // This allows getManagedConnection() to use session context from AsyncLocalStorage
  // Connection will be created per-request with session-specific credentials
  // Note: sapConfig NOT passed - will use session context
}
```

**Що це фіксить**:
- ✅ `overrideConnection` більше **НЕ створюється** для HTTP transport
- ✅ `getManagedConnection()` тепер використовує session context з AsyncLocalStorage  
- ✅ Кожен HTTP запит має власний session-specific `sapConfig` з headers
- ✅ Refresh token працює, бо connection створюється з правильним config

### 2. Різниця: Standalone vs Cloud LLM Hub

#### Standalone mcp-abap-adt
```bash
# Credentials в .env файлі
SAP_URL=https://...
SAP_JWT_TOKEN=...
SAP_REFRESH_TOKEN=...
SAP_UAA_URL=...          # З service key
SAP_UAA_CLIENT_ID=...    # З service key  
SAP_UAA_CLIENT_SECRET=... # З service key
```

`getConfig()` читає з `process.env` → всі UAA параметри **доступні**

#### Cloud LLM Hub (через proxy) - РЕКОМЕНДОВАНИЙ СПОСІБ

**Server-side (.env в cloud-llm-hub):**
```env
# UAA credentials зберігаються ОДИН РАЗ на сервері
SAP_UAA_URL=https://tenant.authentication.eu10.hana.ondemand.com
SAP_UAA_CLIENT_ID=sb-...
SAP_UAA_CLIENT_SECRET=...
```

**Client-side (Cline config):**
```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "type": "stream-http",
      "endpoint": "http://localhost:4004/mcp/stream/http",
      "headers": {
        "Authorization": "Basic YWxpY2U6",
        "X-SAP-URL": "https://your-system.abap.cloud.sap",
        "X-SAP-Auth-Type": "jwt",
        "X-SAP-JWT-Token": "eyJhbGc...",
        "X-SAP-Refresh-Token": "d97ecc6dde864389..."
      }
    }
  }
}
```

**Переваги:**
- ✅ UAA credentials зберігаються **один раз** на сервері
- ✅ Клієнт передає **тільки** access token + refresh token
- ✅ Безпечніше - client credentials не передаються через мережу
- ✅ Простіше - менше headers в Cline config

#### Cloud LLM Hub - альтернативний спосіб (UAA в headers)

Якщо ви **НЕ хочете** зберігати UAA credentials на сервері, можете передавати їх через headers:

```json
{
  "headers": {
    "X-SAP-UAA-URL": "https://tenant.authentication.eu10.hana.ondemand.com",
    "X-SAP-UAA-Client-ID": "sb-...",
    "X-SAP-UAA-Client-Secret": "..."
  }
}
```

**Fallback logic:**
- Headers мають пріоритет над `.env`
- Якщо header пустий, використовується `.env`
- Якщо обидва відсутні, refresh не працює

### 3. Отримання токенів та credentials

Використовуйте утиліту `sap-abap-auth` з пакету `@mcp-abap-adt/connection`:

```bash
# Встановіть пакет
npm install -g @mcp-abap-adt/connection

# Автентифікуйтеся з service key
sap-abap-auth auth -k path/to/service-key.json
```

Ця команда:
1. Читає service key (містить UAA credentials)
2. Відкриває браузер для OAuth2 автентифікації
3. Отримує access token + refresh token
4. Створює `.env` файл з **всіма необхідними параметрами**:

```env
# Створений автоматично утилітою sap-abap-auth
SAP_URL=https://your-instance.abap.cloud.sap
SAP_CLIENT=100
SAP_AUTH_TYPE=jwt
SAP_JWT_TOKEN=eyJhbGc...  # Access token
SAP_REFRESH_TOKEN=eyJhbGc...  # Refresh token
SAP_UAA_URL=https://tenant.authentication.eu10.hana.ondemand.com
SAP_UAA_CLIENT_ID=sb-...  # З service key
SAP_UAA_CLIENT_SECRET=...  # З service key
```

**Важливо**: Всі ці параметри беруться **з одного service key** і утворюють комплект для роботи з конкретною SAP BTP ABAP системою.

### 4. Таблиця HTTP Headers

Всі SAP-специфічні headers мають префікс `x-sap-` (маленькі літери):

| Header | Обов'язковий | Джерело | Змінна .env | Опис |
|--------|--------------|---------|-------------|------|
| `x-sap-url` | ✅ Так | Client | `SAP_URL` | URL ABAP системи |
| `x-sap-auth-type` | ✅ Так | Client | `SAP_AUTH_TYPE` | Тип автентифікації: `jwt` або `basic` |
| `x-sap-jwt-token` | ✅ Для JWT | Client | `SAP_JWT_TOKEN` | Access token (JWT) |
| `x-sap-refresh-token` | ⚠️ Рекомендовано | Client | `SAP_REFRESH_TOKEN` | Refresh token для авто-оновлення |
| `x-sap-uaa-url` | 🔄 Fallback .env | Client/.env | `SAP_UAA_URL` | UAA endpoint (для refresh) |
| `x-sap-uaa-client-id` | 🔄 Fallback .env | Client/.env | `SAP_UAA_CLIENT_ID` | OAuth2 client ID (для refresh) |
| `x-sap-uaa-client-secret` | 🔄 Fallback .env | Client/.env | `SAP_UAA_CLIENT_SECRET` | OAuth2 client secret (для refresh) |
| `x-sap-client` | ❌ Опційно | Client | `SAP_CLIENT` | SAP client (наприклад, `100`) |
| `x-sap-username` | ✅ Для Basic | Client | `SAP_USERNAME` | Username для Basic auth |
| `x-sap-password` | ✅ Для Basic | Client | `SAP_PASSWORD` | Password для Basic auth |
| `x-sap-destination` | 🔀 Альтернатива | Client | - | BTP Destination name (замість URL) |

**Легенда:**
- ✅ **Обов'язковий** - header МАЄ бути присутнім
- ⚠️ **Рекомендовано** - не обов'язковий, але потрібен для певної функції
- 🔄 **Fallback .env** - можна не передавати, буде взято з server .env
- ❌ **Опційно** - можна не передавати
- 🔀 **Альтернатива** - використовується замість іншого header

### 5. Приклади конфігурації

#### Мінімальна конфігурація (рекомендовано)

UAA credentials зберігаються в `.env` на сервері, клієнт передає тільки tokens:

```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "type": "stream-http",
      "endpoint": "http://localhost:4004/mcp/stream/http",
      "headers": {
        "authorization": "Basic YWxpY2U6",
        "x-sap-url": "https://your-system.abap.cloud.sap",
        "x-sap-auth-type": "jwt",
        "x-sap-jwt-token": "eyJhbGc...",
        "x-sap-refresh-token": "d97ecc6dde864389..."
      }
    }
  }
}
```

**Server .env містить:**
```env
SAP_UAA_URL=https://tenant.authentication.eu10.hana.ondemand.com
SAP_UAA_CLIENT_ID=sb-...
SAP_UAA_CLIENT_SECRET=...
```

#### Повна конфігурація (з UAA в headers)

Всі credentials в headers, сервер `.env` не потрібен:

```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "type": "stream-http",
      "endpoint": "http://localhost:4004/mcp/stream/http",
      "headers": {
        "authorization": "Basic YWxpY2U6",
        "x-sap-url": "https://your-system.abap.cloud.sap",
        "x-sap-auth-type": "jwt",
        "x-sap-jwt-token": "eyJhbGc...",
        "x-sap-refresh-token": "d97ecc6dde864389...",
        "x-sap-uaa-url": "https://tenant.authentication.eu10.hana.ondemand.com",
        "x-sap-uaa-client-id": "sb-...",
        "x-sap-uaa-client-secret": "..."
      }
    }
  }
}
```

#### З SAP Client

Якщо ваша система вимагає SAP client:

```json
{
  "headers": {
    "x-sap-client": "100",
    ...
  }
}
```

### 6. Виправлення в коді

#### `srv/mcp-manager.ts`

Додано витягування UAA параметрів з headers:

```typescript
// Add refresh token if provided (for token refresh)
const sapRefreshToken = (req.headers['x-sap-refresh-token'] as string | undefined)?.trim();
const sapUaaUrl = (req.headers['x-sap-uaa-url'] as string | undefined)?.trim();
const sapUaaClientId = (req.headers['x-sap-uaa-client-id'] as string | undefined)?.trim();
const sapUaaClientSecret = (req.headers['x-sap-uaa-client-secret'] as string | undefined)?.trim();

if (sapRefreshToken) {
  sapConfig.refreshToken = sapRefreshToken;
}

// Add UAA credentials if provided (required for token refresh)
if (sapUaaUrl) {
  sapConfig.uaaUrl = sapUaaUrl;
}
if (sapUaaClientId) {
  sapConfig.uaaClientId = sapUaaClientId;
}
if (sapUaaClientSecret) {
  sapConfig.uaaClientSecret = sapUaaClientSecret;
}
```

#### `srv/server.ts`

Аналогічно додано для `sessionSapConfig` (для SessionContext):

```typescript
// Add UAA credentials if provided (required for token refresh)
if (sapUaaUrl) {
  sessionSapConfig.uaaUrl = sapUaaUrl;
}
if (sapUaaClientId) {
  sessionSapConfig.uaaClientId = sapUaaClientId;
}
if (sapUaaClientSecret) {
  sessionSapConfig.uaaClientSecret = sapUaaClientSecret;
}
```

## Як це працює

### 1. Перший запит з валідним JWT токеном

```
Client → Hub: POST /mcp/stream/http
  Headers: JWT token + Refresh token + UAA credentials
  ↓
Hub → extractSapContext: витягує всі параметри з headers
  ↓
Hub → getMCPServer: створює MCP server з sapConfig (включає UAA credentials)
  ↓
Hub → mcp-abap-adt: створює JwtAbapConnection з повним config
  ↓
Connection → SAP: робить запит з JWT токеном
  ↓
SAP → Connection: повертає дані
  ↓
Hub → Client: відповідь
```

### 2. JWT токен expіred - автоматичний refresh

```
Client → Hub: POST /mcp/stream/http (той самий request)
  ↓
Hub → getMCPServer: використовує кешований MCP server (той самий sapConfig)
  ↓
Connection → SAP: робить запит з expired JWT токеном
  ↓
SAP → Connection: 401 Unauthorized
  ↓
Connection.canRefreshToken(): перевіряє чи є всі UAA параметри
  ✓ refreshToken: є
  ✓ uaaUrl: є
  ✓ uaaClientId: є
  ✓ uaaClientSecret: є
  → повертає true
  ↓
Connection.refreshToken(): викликає UAA token endpoint
  ↓
UAA → Connection: новий JWT access token (+ новий refresh token)
  ↓
Connection: оновлює sapConfig.jwtToken і sapConfig.refreshToken
Connection: очищає CSRF token і cookies (вони прив'язані до старого токена)
  ↓
Connection → SAP: повторює запит з новим JWT токеном
  ↓
SAP → Connection: повертає дані
  ↓
Hub → Client: відповідь
```

### 3. Наступні запити використовують оновлений токен

Оскільки `sapConfig` - це об'єкт, що передається по reference, всі наступні запити автоматично використовують оновлений токен.

## Debugging

### Перевірка чи всі параметри передані

Логи в `mcp-manager.ts` тепер показують:

```
SAP config extracted from headers {
  url: 'https://...',
  authType: 'jwt',
  hasJwtToken: true,
  hasRefreshToken: true,
  hasUaaUrl: true,
  hasUaaClientId: true,
  hasUaaClientSecret: true,
  canRefresh: true  // ✓ Якщо true - token refresh буде працювати
}
```

### Якщо `canRefresh: false`

Перевірте що клієнт передає **всі** headers:
- `X-SAP-Refresh-Token`
- `X-SAP-UAA-URL`
- `X-SAP-UAA-Client-ID`
- `X-SAP-UAA-Client-Secret`

### Логи при refresh

Коли токен оновлюється, в логах буде:

```
[DEBUG] Received 401, attempting JWT token refresh...
[DEBUG] Refreshing JWT token...
[DEBUG] JWT token refreshed successfully
[DEBUG] Token updated in config: eyJhbG...xyz -> eyJhbG...abc
[DEBUG] Cleared saved session state from storage
[DEBUG] Reconnected successfully after token refresh
[DEBUG] Retrying ADT request after token refresh...
```

## Приклад клієнта (Cline)

### Крок 1: Отримайте токени через sap-abap-auth

```bash
# В директорії вашого проекту
sap-abap-auth auth -k service-key.json

# Створено .env файл з усіма параметрами
```

### Крок 2: Скопіюйте значення з .env в Cline конфігурацію

Конфігурація в `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "sap-abap-dev": {
      "command": "node",
      "args": ["-e", "console.log(JSON.stringify({\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}))"],
      "transport": {
        "type": "streamable-http",
        "url": "https://your-hub.cfapps.eu10.hana.ondemand.com/mcp/stream/http",
        "headers": {
          "Authorization": "Bearer <mcp-hub-access-token>",
          "X-SAP-URL": "<значення з SAP_URL>",
          "X-SAP-Auth-Type": "jwt",
          "X-SAP-JWT-Token": "<значення з SAP_JWT_TOKEN>",
          "X-SAP-Refresh-Token": "<значення з SAP_REFRESH_TOKEN>",
          "X-SAP-UAA-URL": "<значення з SAP_UAA_URL>",
          "X-SAP-UAA-Client-ID": "<значення з SAP_UAA_CLIENT_ID>",
          "X-SAP-UAA-Client-Secret": "<значення з SAP_UAA_CLIENT_SECRET>",
          "X-SAP-Client": "<значення з SAP_CLIENT або 100>"
        }
      }
    }
  }
}
```

**Примітка**: Всі ці значення походять **з одного service key** і утворюють комплект credentials для роботи з SAP BTP ABAP системою.

## Безпека

⚠️ **ВАЖЛИВО**: UAA Client Secret передається в headers!

Це означає:
1. **Обов'язково** використовуйте HTTPS для всіх запитів
2. Зберігайте `cline_mcp_settings.json` в безпечному місці
3. Не commitьте цей файл в Git
4. Використовуйте environment variables або секрети для production

**Чому так?** Це вимога OAuth2 стандарту (RFC 6749). Refresh token **не може** бути використаний без client credentials (client_id + client_secret). Це security feature, який запобігає зловживанню викраденими refresh tokens.

### Альтернатива (РЕКОМЕНДОВАНО для production)

Для production **настійно рекомендується** використовувати **Destination Service** з BTP:

```json
{
  "transport": {
    "type": "streamable-http",
    "url": "https://your-hub.cfapps.eu10.hana.ondemand.com/mcp/stream/http",
    "headers": {
      "Authorization": "Bearer <mcp-hub-access-token>",
      "X-SAP-Destination": "SAP_DEV_SYSTEM"
    }
  }
}
```

В цьому випадку:
- ✅ UAA credentials зберігаються **в Destination Service** (не в headers)
- ✅ Token refresh відбувається **автоматично через SAP Cloud SDK**
- ✅ Headers містять **тільки destination name** (безпечно)
- ✅ **Підтримка Cloud Connector** для on-premise систем
- ✅ **Централізоване управління** credentials в BTP Cockpit

**Для Direct JWT Auth (headers):**
- ⚠️ UAA credentials в кожному запиті
- ⚠️ Менша безпека (credentials у багатьох місцях)
- ⚠️ Потрібно manually оновлювати credentials при ротації
- ✅ Простіше для локальної розробки
- ✅ Не потрібен Destination Service

## Два режими роботи

### 1. Direct JWT Auth (headers)

**Використання**: локальна розробка, тестування

**Плюси**:
- Простота налаштування
- Не потрібен Destination Service

**Мінуси**:
- UAA credentials в headers (менш безпечно)
- Потрібно manually передавати всі параметри

**Connection**: створюється через `@mcp-abap-adt/connection` (`JwtAbapConnection`)

### 2. Destination Service (BTP)

**Використання**: production, enterprise

**Плюси**:
- UAA credentials в Destination Service (безпечно)
- Автоматичний token refresh через SAP Cloud SDK
- Підтримка Cloud Connector (on-premise)

**Мінуси**:
- Потрібен BTP Destination Service
- Складніше налаштування

**Connection**: створюється через `CloudSdkAbapConnection` (використовує `executeHttpRequest`)

## Висновок

Після виправлення, JWT token refresh працює автоматично якщо передані **всі чотири параметри**:
1. ✅ `X-SAP-Refresh-Token`
2. ✅ `X-SAP-UAA-URL`
3. ✅ `X-SAP-UAA-Client-ID`
4. ✅ `X-SAP-UAA-Client-Secret`

Коли JWT access token expіred:
- `JwtAbapConnection` автоматично викличе `refreshToken()`
- Отримає новий access token з UAA
- Оновить `sapConfig.jwtToken`
- Повторить запит з новим токеном
- Клієнт отримає відповідь без помилок

**Проблема вирішена! 🎉**
