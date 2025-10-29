# Технічне завдання (ТЗ): Проксі для MCP поверх SSE та Stream-HTTP з авторизацією BTP (XSUAA/CAP)

**Версія:** 1.4  
**Дата:** 2025-10-29  
**Власник:** Oleksii Kyslytsia (проект *Programming*)

---

## 1. Мета

Реалізувати безпечний **CAP-проксі** для MCP (Model Command Protocol), який працює через **SSE (Server-Sent Events)** і **Stream-HTTP** протоколи, з автентифікацією та авторизацією через **SAP BTP XSUAA**, створену за допомогою команди `cds add xsuaa`.  
Реальна реалізація MCP знаходиться у підмодулі **`mcp-abap-adt`** (який не має власної авторизації). CAP-проксі виступає як шлюз з авторизацією, перевіркою ролей і стабільним проксуванням потоків.

---

## 2. Цілі

1. Захистити всі входи MCP через XSUAA.  
2. Забезпечити доступ до стрімів лише для користувачів із відповідними ролями.  
3. Підтримати два протоколи: **SSE** (Server-Sent Events) і **Stream-HTTP** (NDJSON).  
4. Зробити універсальний middleware авторизації для SSE (оскільки CDS не обробляє SSE автоматично).  
5. Реалізувати Dev/Prod профілі: Basic/mock у dev, XSUAA у продакшн.  
6. Підготувати CAP-додаток до деплою на BTP.

---

## 3. Архітектура

```mermaid
flowchart LR
  CLI[Cline / CLI client] -->|SSE / Stream-HTTP| CAP[CAP Service: mcp-proxy]
  CAP -->|Auth via JWT / Basic| XSUAA[XSUAA (SAP BTP)]
  CAP -->|Forward stream| MCP[mcp-abap-adt (submodule)]
  MCP -->|stream responses| CAP --> CLI
```

---

## 4. Інтеграція XSUAA

```bash
cds add xsuaa
```

CAP автоматично:
- створює файл `xs-security.json`;
- додає в `package.json`:
  ```json
  { "cds": { "requires": { "auth": "xsuaa" } } }
  ```
- додає залежності:
  ```json
  { "@sap/xssec": "^3", "@sap/xsenv": "^3" }
  ```
- підключає middleware `cds.auth()` для JWT токенів.

---

## 5. Основні компоненти

| Компонент | Опис |
|------------|------|
| **CAP mcp-proxy** | Проксі, який приймає SSE та Stream-HTTP запити, перевіряє авторизацію та пересилає дані у `mcp-abap-adt`. |
| **XSUAA (SAP BTP)** | Сервіс авторизації для перевірки JWT токенів. |
| **authShim** | Додатковий middleware, який обробляє Basic (для dev) та Bearer (для prod) авторизацію і встановлює `req.user` у форматі CAP. |
| **mcp-abap-adt** | Реальна реалізація MCP API, підключена як git submodule. |
| **Cline/CLI** | Клієнт, який ініціює SSE або stream-http запити. |

---

## 6. Конфігурація CAP (package.json)

```json
{
  "name": "mcp-proxy",
  "dependencies": {
    "@sap/cds": "^7",
    "@sap/xssec": "^3",
    "@sap/xsenv": "^3",
    "node-fetch": "^3"
  },
  "cds": {
    "requires": {
      "auth": "xsuaa",
      "mcpTarget": {
        "kind": "rest",
        "credentials": { "url": "http://127.0.0.1:7070" }
      }
    },
    "profiles": {
      "dev": {
        "requires": {
          "auth": {
            "kind": "mock",
            "users": {
              "alice": { "roles": ["MCP_Connector", "MCP_Admin"] },
              "bob":   { "roles": ["MCP_Connector"] }
            }
          }
        }
      }
    }
  }
}
```

---

## 7. Модель безпеки (xs-security.json)

```json
{
  "xsappname": "mcp-proxy",
  "tenant-mode": "shared",
  "scopes": [
    { "name": "$XSAPPNAME.MCP_Connect", "description": "Connect to MCP stream" },
    { "name": "$XSAPPNAME.MCP_Read",    "description": "Read MCP stream" },
    { "name": "$XSAPPNAME.MCP_Admin",   "description": "Admin operations" }
  ],
  "roles": [
    {
      "name": "MCP_Connector",
      "description": "Basic MCP access",
      "scope-references": [ "$XSAPPNAME.MCP_Connect", "$XSAPPNAME.MCP_Read" ]
    },
    {
      "name": "MCP_Admin",
      "description": "Full administrative access",
      "scope-references": [ "$XSAPPNAME.MCP_Admin", "$XSAPPNAME.MCP_Connect", "$XSAPPNAME.MCP_Read" ]
    }
  ]
}
```

---

## 8. Локальна привʼязка сервісу (default-env.json)

```json
{
  "VCAP_SERVICES": {
    "xsuaa": [
      {
        "name": "mcp-xsuaa",
        "label": "xsuaa",
        "credentials": {
          "xsappname": "mcp-proxy",
          "url": "https://<xsuaa-domain>",
          "clientid": "<id>",
          "clientsecret": "<secret>"
        }
      }
    ]
  }
}
```

---

## 9. AuthShim (універсальний middleware для SSE/Stream)

```js
// auth-shim.js
const xsenv = require('@sap/xsenv')
const xssec = require('@sap/xssec')
const cds   = require('@sap/cds')

let xsuaa
try {
  xsuaa = xsenv.getServices({ uaa: { tag: 'xsuaa' } }).uaa
} catch {
  xsuaa = null
}

function extractBearer(req) {
  const h = req.headers
  let b = h.authorization || h['x-approuter-authorization'] || h['x-forwarded-authorization']
  if (!b) return null
  if (Array.isArray(b)) b = b[0]
  b = String(b)
  return b.startsWith('Bearer ') ? b.slice(7) : null
}

function rolesFromScopes(scopes, xsapp) {
  const s = new Set(scopes || [])
  const roles = []
  if (s.has(`${xsapp}.MCP_Connect`)) roles.push('MCP_Connector')
  if (s.has(`${xsapp}.MCP_Admin`))   roles.push('MCP_Admin')
  return roles
}

async function authShim(req, res, next) {
  try {
    const auth = req.headers.authorization || ''

    // Dev: Basic (mock)
    if (auth.startsWith('Basic ')) {
      const [user] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':')
      const roles = user === 'alice' ? ['MCP_Connector', 'MCP_Admin'] : ['MCP_Connector']
      req.user = new cds.User({ id: user || 'anonymous', roles })
      return next()
    }

    // Prod: Bearer (end-user або service)
    const token = extractBearer(req)
    if (!token) return res.status(401).send('Unauthorized: no token')
    if (!xsuaa) return res.status(500).send('XSUAA binding missing')

    const sc = await new Promise((resolve, reject) =>
      xssec.createSecurityContext(token, xsuaa, (e, ctx) => e ? reject(e) : resolve(ctx))
    )
    req._sc = sc

    const userId = sc.getLogonName() || `system:${sc.getClientId?.() || 'client'}`
    const roles = rolesFromScopes(sc.getScopes?.(), xsuaa.xsappname)
    req.user = new cds.User({ id: userId, roles })
    return next()
  } catch (e) {
    return res.status(401).send('Unauthorized: ' + e.message)
  }
}

module.exports = { authShim }
```

---

## 10. SSE endpoint (GET /mcp/stream/sse)

```js
// server.js (фрагмент)
const cds = require('@sap/cds')
const { authShim } = require('./auth-shim')

cds.on('bootstrap', (app) => {
  app.use(cds.auth())

  app.get('/mcp/stream/sse', authShim, async (req, res) => {
    if (!req.user?.is('MCP_Connector')) return res.sendStatus(403)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write('retry: 15000\\n\\n')
    const hb = setInterval(() => res.write(': ping\\n\\n'), 15000)

    // TODO: Проксі до MCP-сервісу (mcp-abap-adt)
    // const target   = cds.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070'
    // const upstream = await fetch(target + '/sse', { headers: { Accept: 'text/event-stream' } })
    // upstream.body.on('data', chunk => res.write(chunk))
    // upstream.body.on('end',  () => { clearInterval(hb); res.end() })
    // req.on('close', () => { upstream.body?.destroy?.(); clearInterval(hb); res.end() })
  })
})
```

**Вимоги для SSE:**
- Вимкнути компрісію/буферизацію на маршруті `/mcp/stream/sse`.
- Heartbeat кожні 10–30 сек (`: ping`), `retry: 15000` для клієнта.
- Тайм-аути читання/запису — не менше 60 сек.

---

## 11. Stream-HTTP endpoint (POST /mcp/stream/http)

```js
// server.js (фрагмент)
cds.on('bootstrap', (app) => {
  app.post('/mcp/stream/http', authShim, async (req, res) => {
    if (!req.user?.is('MCP_Connector')) return res.sendStatus(403)

    // TODO: Проксі POST-стріму в mcp-abap-adt
    // const target   = cds.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070'
    // const upstream = await fetch(target + '/stream', { method: 'POST', body: req })
    // res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/x-ndjson')
    // upstream.body.on('data', chunk => res.write(chunk))
    // upstream.body.on('end', () => res.end())
  })
})
```

**Вимоги для Stream-HTTP:**
- Формат відповіді — NDJSON (`application/x-ndjson`) або `text/plain` line-delimited JSON.
- Контроль backpressure через `res.write()` і коректні флаші.
- Обмеження на розмір події (наприклад, 1 МБ).

---

## 12. Режими запуску (Dev / Prod)

| Режим | Авторизація | Приклад заголовка |
|--------|--------------|------------------|
| **Dev** | Basic (mock) | `Authorization: Basic YWxpY2U6` |
| **Prod** | JWT (XSUAA) | `Authorization: Bearer <JWT>` |

**Dev:**  
```bash
cds watch --profile dev
# Basic: alice:
# curl -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/stream/sse
```

**Prod:**  
- Прив’язка `xsuaa` на CF/BTP.  
- Клієнти використовують валідний `Bearer` (service token або on-behalf-of).

---

## 13. Приклади конфігурацій Cline

**SSE (`cline.json`):**
```json
{
  "type": "sse",
  "endpoint": "https://<srv-domain>/mcp/stream/sse",
  "headers": {
    "Authorization": "Bearer ${ACCESS_TOKEN}"
  },
  "timeoutMs": 0
}
```

**Stream-HTTP (`cline.json`):**
```json
{
  "type": "stream-http",
  "endpoint": "https://<srv-domain>/mcp/stream/http",
  "headers": {
    "Authorization": "Bearer ${ACCESS_TOKEN}",
    "Content-Type": "application/x-ndjson"
  }
}
```

---

## 14. Критерії приймання

1. Авторизований користувач (MCP_Connector) отримує події через SSE.  
2. Без ролі — `403 Forbidden`.  
3. Dev режим — Basic `alice:` працює.  
4. Потоки стабільні, heartbeat кожні 15 с.  
5. Навантаження 500 evt/s — без витоків пам’яті.  
6. JWT токени XSUAA валідуються.  
7. Документація для деплою на BTP готова.  

---

## 15. План тестування

### 15.1 Функціональні тести
- [ ] Відкрити SSE-потік у dev (Basic alice).  
- [ ] Відкрити SSE-потік у prod (JWT).  
- [ ] Виконати POST на `/mcp/stream/http` із NDJSON.  
- [ ] Перевірити реакцію на відсутність токена (очікувано 401).  
- [ ] Перевірити реакцію без ролі (очікувано 403).  

### 15.2 Навантажувальні тести
- [ ] 500 подій/сек протягом 5 хвилин — без помилок та збоїв.  
- [ ] Перевірити утилізацію CPU/RAM.  

### 15.3 Безпека
- [ ] Маскування чутливих заголовків у логах.  
- [ ] Rate limit на IP (опційно).  
- [ ] Перевірка XSS/інʼєкцій у payload-подіях.  

---

## 16. Подальші кроки

1. Імплементувати SSE і Stream-HTTP endpoint-и.  
2. Підключити XSUAA через `cds add xsuaa`.  
3. Підключити `mcp-abap-adt` як submodule.  
4. Написати тести з Cline/curl.  
5. Зробити деплой на SAP BTP (Cloud Foundry).  
6. Додати Observability (структуровані логи + метрики).
