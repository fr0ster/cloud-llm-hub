# 🏗️ Архітектура з'єднань (Connection Architecture)

**Дата:** 1 грудня 2025  
**Версія:** 1.0  
**Автор:** AI Assistant

---

## 📋 Зміст

1. [Огляд](#огляд)
2. [Два типи з'єднань](#два-типи-зєднань)
3. [Коли використовувати що](#коли-використовувати-що)
4. [Технічні деталі](#технічні-деталі)
5. [Приклади використання](#приклади-використання)

---

## 🎯 Огляд

`cloud-llm-hub` **НЕ дублює** функціональність `@mcp-abap-adt/connection`, а **розширює** її для роботи з SAP BTP Cloud.

### Чому два типи з'єднань?

```
┌─────────────────────────────────────────────────────────────┐
│              Базова функціональність (mcp-abap-adt)         │
│                                                              │
│  ✅ MCP Protocol (stdio, HTTP, SSE)                         │
│  ✅ ABAP ADT Handlers (Classes, Programs, etc.)             │
│  ✅ Basic Authentication (username/password)                │
│  ✅ JWT Authentication (direct token)                       │
│  ✅ Direct ABAP connections (axios-based)                   │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ РОЗШИРЮЄТЬСЯ ↓
                           │
┌─────────────────────────▼─────────────────────────────────┐
│         Розширення для BTP Cloud (cloud-llm-hub)          │
│                                                            │
│  🆕 BTP Destination Service integration                   │
│  🆕 Cloud Connector support (On-Premise)                  │
│  🆕 Multiple auth types (OAuth2, SAML)                    │
│  🆕 Principal Propagation                                 │
│  🆕 Managed token refresh через BTP                       │
│  🆕 Enterprise-ready REST API (CAP)                       │
└────────────────────────────────────────────────────────────┘
```

---

## 🔧 Два типи з'єднань

### Type 1: Direct Connection (`@mcp-abap-adt/connection`)

**Коли використовується:**
- Локальна розробка
- stdio mode (Cline, Cursor, Claude Desktop)
- Прямі з'єднання до ABAP без BTP
- Тестування та debugging

**Як працює:**
```typescript
import { createAbapConnection, SapConfig } from '@mcp-abap-adt/connection';

const config: SapConfig = {
  url: "https://my-abap-system.com:443",
  authType: "basic",
  username: "DEVELOPER",
  password: "SecretPass123",
  client: "100"
};

const connection = createAbapConnection(config);
```

**Технічні деталі:**
- **HTTP Client:** axios
- **Authentication:** Basic (username/password) або JWT (токен в header)
- **Proxy:** Тільки через `HTTP_PROXY` environment variable
- **Token management:** Manual (передається в config)
- **CSRF handling:** axios-based implementation
- **Session storage:** FileSessionStorage (optional)

**Переваги:**
- ✅ Простота налаштування (.env file)
- ✅ Швидкий старт для розробки
- ✅ Не потребує BTP infrastructure

**Недоліки:**
- ❌ Credentials в .env файлі (security risk)
- ❌ Немає автоматичного token refresh
- ❌ Не працює з On-Premise через Cloud Connector
- ❌ Немає централізованого управління destinations

---

### Type 2: BTP Destination (`CloudSdkAbapConnection`)

**Коли використовується:**
- Production deployment на BTP
- On-Premise ABAP через Cloud Connector
- Multi-tenant SaaS applications
- Enterprise scenarios з Principal Propagation

**Як працює:**
```typescript
import { CloudSdkAbapConnection } from './connections/CloudSdkAbapConnection';

const connection = new CloudSdkAbapConnection(
  sapConfig,
  "MY_ABAP_DESTINATION" // Destination name в BTP
);
```

**Технічні деталі:**
- **HTTP Client:** SAP Cloud SDK (`executeHttpRequest`)
- **Authentication:** через BTP Destination Service
  - BasicAuthentication
  - OAuth2ClientCredentials
  - OAuth2SAMLBearerAssertion
  - Principal Propagation (user context)
- **Proxy:** Cloud Connector (автоматично через Destination)
- **Token management:** Автоматичний через BTP
- **CSRF handling:** Cloud SDK-based implementation
- **Configuration:** Централізована в BTP Cockpit

**Destination Configuration (приклад):**
```json
{
  "Name": "MY_ABAP_DESTINATION",
  "Type": "HTTP",
  "URL": "https://my-abap-system.com:443",
  "ProxyType": "OnPremise",
  "Authentication": "OAuth2SAMLBearerAssertion",
  "tokenServiceURL": "https://my-uaa.com/oauth/token",
  "clientId": "sb-my-app",
  "clientSecret": "***",
  "sap-client": "100"
}
```

**Переваги:**
- ✅ Централізоване управління destinations (BTP Cockpit)
- ✅ Автоматичний token refresh
- ✅ Cloud Connector support для On-Premise
- ✅ Principal Propagation (user context forwarding)
- ✅ Multi-tenant isolation
- ✅ Audit logging через BTP
- ✅ No credentials in code

**Недоліки:**
- ❌ Потребує BTP infrastructure
- ❌ Складніше налаштування
- ❌ Не працює в локальному stdio mode

---

## 🎯 Коли використовувати що?

### Decision Tree

```
                    Де запускається код?
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
   Локально / stdio                    BTP Cloud
        │                                   │
        ▼                                   ▼
 Direct Connection              BTP Destination
  (Basic/JWT)                  (CloudSdkAbapConnection)
        │                                   │
        │                                   │
        ▼                                   ▼
┌──────────────────┐            ┌─────────────────────┐
│ .env file config │            │ Destination Service │
│                  │            │                     │
│ SAP_URL=...      │            │ Destination Name    │
│ SAP_USERNAME=... │            │ + BTP Auth          │
│ SAP_PASSWORD=... │            │                     │
└──────────────────┘            └─────────────────────┘
```

### Use Case Matrix

| Use Case | Connection Type | Чому? |
|----------|----------------|-------|
| **Локальна розробка** | Direct (Basic/JWT) | .env file, простота |
| **stdio mode (Cline/Cursor)** | Direct (Basic/JWT) | Не потребує BTP |
| **BTP Cloud Production** | BTP Destination | Security, management |
| **On-Premise через CC** | BTP Destination | ⚠️ ТІЛЬКИ через Destination! |
| **Principal Propagation** | BTP Destination | User context forwarding |
| **Multi-tenant SaaS** | BTP Destination | Isolation, різні destinations |
| **Development/Test на BTP** | Обидва | Можна обрати зручніший |
| **CI/CD Pipeline** | Direct (JWT) | Service account tokens |

---

## 🔬 Технічні деталі

### Interface Compatibility

Обидва типи імплементують `AbapConnection` interface:

```typescript
interface AbapConnection {
  getConfig(): SapConfig;
  getSessionId(): string;
  setSessionType(type: 'stateless' | 'stateful'): void;
  connect(): Promise<void>;
  getSessionState(): any;
  setSessionState(state: any): void;
  reset(): void;
  getBaseUrl(): Promise<string>;
  getAuthHeaders(): Promise<Record<string, string>>;
  makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse>;
}
```

**Це дозволяє:**
- Прозоро підміняти один тип на інший
- Використовувати однаковий MCP server code
- Factory pattern для вибору типу

### CSRF Token Handling

**Direct Connection:**
```typescript
// @mcp-abap-adt/connection
private async fetchCsrfToken(): Promise<string> {
  const response = await axios.get(`${baseUrl}/sap/bc/adt/discovery`, {
    headers: {
      'x-csrf-token': 'fetch',
      'Authorization': `Basic ${base64encode(username:password)}`
    }
  });
  return response.headers['x-csrf-token'];
}
```

**BTP Destination:**
```typescript
// CloudSdkAbapConnection
private async fetchCsrfToken(url: string): Promise<string> {
  const response = await executeHttpRequest(
    { destinationName: this.destinationName },
    {
      method: 'GET',
      url: `${baseUrl}/sap/bc/adt/discovery`,
      headers: {
        'x-csrf-token': 'fetch',
        'Accept': 'application/atomsvc+xml'
      }
    }
  );
  return response.headers['x-csrf-token'];
}
```

**Різниця:**
- Різні HTTP clients (axios vs Cloud SDK)
- Cloud SDK автоматично додає authentication з Destination
- Cloud SDK автоматично обробляє proxy через Cloud Connector

### Authentication Flow

**Direct Connection (Basic):**
```
Client → cloud-llm-hub → ABAP System
         │
         └─ Authorization: Basic base64(user:pass)
```

**Direct Connection (JWT):**
```
Client → cloud-llm-hub → ABAP System
         │
         └─ Authorization: Bearer eyJhbGci...
```

**BTP Destination (OAuth2ClientCredentials):**
```
Client → cloud-llm-hub → BTP Destination Service → UAA (get token)
                         │                           │
                         │←──────── OAuth token ──────┘
                         │
                         └──→ ABAP System
                              Authorization: Bearer <token>
```

**BTP Destination (Principal Propagation):**
```
User → BTP → cloud-llm-hub → BTP Destination Service
       │                      │
       │ User JWT             │ Exchange token
       │                      ↓
       │                     UAA (SAML assertion)
       │                      │
       └──────────────────────┴──→ ABAP System
                                   (з user context)
```

---

## 💡 Приклади використання

### Приклад 1: Локальна розробка (stdio mode)

**.env file:**
```bash
SAP_URL=https://my-s4hana.com:443
SAP_AUTH_TYPE=basic
SAP_USERNAME=DEVELOPER
SAP_PASSWORD=SecretPass123
SAP_CLIENT=100
```

**Запуск:**
```bash
cd submodules/mcp-abap-adt
npm run build
node dist/index.js --transport=stdio
```

**Cline MCP Config:**
```json
{
  "mcpServers": {
    "abap-adt": {
      "command": "node",
      "args": [
        "/path/to/mcp-abap-adt/dist/index.js",
        "--transport=stdio"
      ]
    }
  }
}
```

---

### Приклад 2: BTP Cloud Production

**BTP Destination (створена в Cockpit):**
```
Name: PROD_S4HANA
Type: HTTP
URL: https://prod-s4hana.mycompany.com:443
ProxyType: Internet
Authentication: OAuth2ClientCredentials
tokenServiceURL: https://myapp.authentication.eu10.hana.ondemand.com/oauth/token
clientId: sb-myapp!t12345
clientSecret: *** (encrypted)
Additional Properties:
  sap-client=100
```

**HTTP Request до cloud-llm-hub:**
```http
POST /mcp/stream-http
Host: cloud-llm-hub.cfapps.eu10.hana.ondemand.com
Content-Type: application/json
X-SAP-Destination: PROD_S4HANA
X-SAP-Client: 100
Authorization: Bearer <user-jwt-token>

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_class",
    "arguments": {
      "class_name": "ZCL_MY_CLASS"
    }
  }
}
```

**Що відбувається:**
1. cloud-llm-hub отримує запит з header `X-SAP-Destination: PROD_S4HANA`
2. `destinationResolver` resolve destination через BTP Destination Service
3. Створюється `CloudSdkAbapConnection` з destination name
4. Cloud SDK автоматично:
   - Отримує OAuth token з UAA
   - Налаштовує proxy (якщо потрібно)
   - Додає authentication headers
5. Виконується ADT request до ABAP
6. Response повертається до клієнта

---

### Приклад 3: On-Premise через Cloud Connector

**BTP Destination:**
```
Name: ONPREM_ECC
Type: HTTP
URL: http://sapecc.internal:8000
ProxyType: OnPremise  ← ВАЖЛИВО!
Authentication: BasicAuthentication
User: DEVELOPER
Password: *** (encrypted)
Additional Properties:
  sap-client=100
  CloudConnectorLocationId=mycc-location
```

**Cloud Connector Configuration:**
```
Virtual Host: sapecc.internal
Virtual Port: 8000
Internal Host: 192.168.1.100
Internal Port: 8000
Access Control: Allow /sap/bc/adt/*
```

**HTTP Request:**
```http
POST /mcp/stream-http
X-SAP-Destination: ONPREM_ECC

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_program",
    "arguments": {
      "program_name": "Z_REPORT_001"
    }
  }
}
```

**Що відбувається:**
1. CloudSdkAbapConnection бачить `ProxyType: OnPremise`
2. Cloud SDK автоматично route через Cloud Connector
3. Cloud Connector forward request до internal network
4. ECC system отримує запит з internal network
5. Response через Cloud Connector → BTP → Client

---

## 🎓 Best Practices

### 1. Вибір типу з'єднання

✅ **DO:**
- Використовуй Direct для локальної розробки
- Використовуй BTP Destination для production
- Використовуй BTP Destination для On-Premise
- Тестуй з обома типами перед production deploy

❌ **DON'T:**
- Не зберігай credentials в коді
- Не використовуй Direct з hard-coded credentials
- Не намагайся підключитись до On-Premise без Cloud Connector

### 2. Configuration Management

✅ **DO:**
```typescript
// Good: Factory pattern
const connection = await createConnection({
  destinationName: req.headers['x-sap-destination'],
  sapConfig: extractedConfig
});
```

❌ **DON'T:**
```typescript
// Bad: Hard-coded type selection
const connection = new CloudSdkAbapConnection(...);
```

### 3. Error Handling

✅ **DO:**
```typescript
try {
  const connection = await createConnection(options);
  const response = await connection.makeAdtRequest({...});
} catch (error) {
  if (error.code === 'DESTINATION_NOT_FOUND') {
    // Fallback to direct connection?
  }
  throw error;
}
```

### 4. Testing

**Unit Tests:**
```typescript
// Mock різні типи з'єднань
it('should use CloudSdkAbapConnection for destination', async () => {
  const conn = await createConnection({ 
    destinationName: 'TEST_DEST' 
  });
  expect(conn).toBeInstanceOf(CloudSdkAbapConnection);
});

it('should use direct connection for sapConfig', async () => {
  const conn = await createConnection({ 
    sapConfig: { url: '...', authType: 'basic' } 
  });
  expect(conn).not.toBeInstanceOf(CloudSdkAbapConnection);
});
```

---

## 📚 Додаткові ресурси

- [SAP Cloud SDK Documentation](https://sap.github.io/cloud-sdk/)
- [BTP Destination Service](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/destinations)
- [Cloud Connector](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/cloud-connector)
- [mcp-abap-adt Documentation](../submodules/mcp-abap-adt/README.md)

---

**Версія:** 1.0  
**Останнє оновлення:** 1 грудня 2025  
**Автор:** AI Assistant
