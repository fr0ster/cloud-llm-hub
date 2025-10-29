
# Технічне завдання (ТЗ): Проксі для MCP поверх SSE та Stream‑HTTP з авторизацією BTP (XSUAA/CAP)

**Версія:** 1.0  
**Дата:** 2025-10-29  
**Власник:** Oleksii Kyslytsia (проект *Programming*)

---

## 1. Мета

Побудувати безпечний **проксі‑шар** для MCP (Model Command Protocol), який:
- працює поверх **SSE** (Server‑Sent Events) і **stream‑http**;
- виконує **автентифікацію та авторизацію через SAP BTP XSUAA** з ролями/скоупами, оголошеними у **xs-security.json** (CAP);
- **делегує** фактичну MCP‑логіку до підмодуля **`mcp-abap-adt`** (існуюча реалізація без авторизації);
- забезпечує стабільне стрімінг‑зʼєднання (heartbeat, reconnection hints, backpressure, тайм‑аути);
- надає **єдині точки входу** для CLI‑клієнтів (напр. Cline) і службових інтеграцій.

> NB: Для **SSE/stream-http** уникати SAP App Router для самих стрімів (історичні проблеми з `text/event-stream`). App Router може залишатися для UI/звичайних REST‑роутів.

---

## 2. Обсяг робіт

1. **CAP‑сервіс “mcp-proxy”** у `srv/`, що перевіряє токени XSUAA та ролі і прокидує стріми до `mcp-abap-adt`:
   - `/mcp/stream/sse` — проксі SSE;
   - `/mcp/stream/http` — проксі stream‑http (chunked/NDJSON/line‑delimited).

2. **Авторизація (XSUAA)**:
   - оголошення скоупів/ролей у `xs-security.json`;
   - прив’язка xsuaa‑інстансу до бекенда;
   - перевірка скоупів у проксі‑хендлерах.

3. **Dev/Prod режими**:
   - **Dev**: mock/basic (user *alice*) або service JWT; перемикання профілем `--profile dev`;
   - **Prod**: лише XSUAA JWT (client‑credentials/end‑user).

4. **Інтеграція з `mcp-abap-adt`**:
   - як Git submodule у `external/mcp-abap-adt`;
   - проксі підключається до його локального/віддаленого endpoint’а.

5. **Оборонне програмування**:
   - тайм‑аути, періодичний heartbeat (`: ping`), ліміти розміру подій, контроль реконектів;
   - коректне вимкнення компресії/буферизації на стрім‑роутах.

6. **Документація і приклади**:
   - `README` з curl/Cline прикладами;
   - приклади `cline.json` для SSE/stream‑http;
   - зразки `xs-security.json`, `package.json (cds)`, `default-env.json` (шаблон).

---

## 3. Архітектура

```mermaid
flowchart LR
  C[Cline/CLI\n(service token)] -- SSE/stream-http --> P[CAP srv: mcp-proxy\n(cds.auth/xssec)]
  P -- authZ check --> Auth[XSUAA\n(scopes/roles)]
  P -- forward (stream) --> M[mcp-abap-adt\n(submodule/service)]
  M -- responses (stream) --> P -- pipe --> C
```

### 3.1 Компоненти
- **mcp-proxy (CAP)** — Express‑рівень у `cds.on('bootstrap', app => ...)` з власними роутами та обов’язковим `cds.auth()` **або** кастомним `authShim`.
- **authShim** — легка прослойка, що розуміє **Basic (dev)** і **Bearer (JWT/XSUAA)** та мапить скоупи → CAP‑ролі.
- **mcp-abap-adt** — реальна MCP‑реалізація, без авторизації; приймає локальні loopback‑конекшени від проксі.
- **(опційно)** `nginx` sidecar лише якщо потрібен DMZ/edge; для SSE — `proxy_buffering off`.

---

## 4. Протоколи і вимоги

### 4.1 SSE
- Відповідь: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- Перший рядок: `retry: 15000` (рекомендація клієнту по auto‑reconnect).
- Heartbeat: коментарні рядки `: ping` кожні 10–30 с.
- Заборонити компресію/буферизацію для `/mcp/stream/sse`.

### 4.2 Stream‑HTTP
- Формати: `application/x-ndjson` або `text/plain` (line‑delimited JSON).
- Backpressure: перевіряти `res.write()`/флаші; керовані тайм‑аути.

### 4.3 Безпека
- Авторизація **обов’язкова**: `401/403` якщо немає токена/скоупів.
- Логування тільки метаданих (без секретів); маскувати заголовки.
- Ліміти: розмір одного event’а (наприклад 1MB), загальний rate‑limit per user/IP.

---

## 5. Ролі та авторизація

### 5.1 Скоупи (xs-security.json)
```json
{
  "xsappname": "mcp-proxy",
  "scopes": [
    { "name": "$XSAPPNAME.MCP_Connect", "description": "Connect to MCP streams" },
    { "name": "$XSAPPNAME.MCP_Read",    "description": "Read stream data" },
    { "name": "$XSAPPNAME.MCP_Admin",   "description": "Admin operations" }
  ],
  "roles": [
    { "name": "MCP_Connector", "description": "Connect & read", "scope-references": [ "$XSAPPNAME.MCP_Connect", "$XSAPPNAME.MCP_Read" ]},
    { "name": "MCP_Admin",     "description": "Admin",          "scope-references": [ "$XSAPPNAME.MCP_Admin", "$XSAPPNAME.MCP_Connect", "$XSAPPNAME.MCP_Read" ]}
  ]
}
```

### 5.2 Перевірка в коді
```js
const need = (u, scopes) => scopes.every(s => u.is(s))

// приклад:
if (!need(req.user, ['MCP_Connect'])) return res.sendStatus(403)
```

### 5.3 Dev‑профіль (mock)
```json
{
  "cds": {
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

## 6. Ендпоїнти проксі

### 6.1 SSE: `GET /mcp/stream/sse`
**Запит:**  
- Заголовки:  
  - `Authorization: Bearer <JWT>` (Prod) **або** `Authorization: Basic <base64>` (Dev)
  - `Accept: text/event-stream`  
- Параметри: `?target=local|url` (опційно) — куди форвардити MCP.

**Відповідь:**  
- 200 + стрім з `event:`/`data:`;  
- `401/403` при відсутності/недостатності прав;  
- `5xx` при збоях форварду.

**Алгоритм:**  
1. `authShim` → встановити `req.user` (`cds.User`) з ролями.  
2. Перевірити `MCP_Connect`.  
3. Встановити стрім‑заголовки, надіслати `retry` та heartbeat.  
4. Відкрити вихідний стрім до `mcp-abap-adt` (локал/URL).  
5. Проксидувати події **без буферизації/компресії**.  
6. При розриві — закрити обидва кінці; дати клієнту реконект.  

### 6.2 Stream‑HTTP: `POST /mcp/stream/http`
**Запит:**  
- Заголовки: `Authorization: ...`, `Content-Type: application/x-ndjson`  
- Тіло: стрім команд/запитів MCP.

**Відповідь:**  
- `200` + стрім відповідей (NDJSON) або `text/plain` line‑delimited.  

---

## 7. Підключення `mcp-abap-adt`

- Додати git submodule:  
  ```bash
  git submodule add <repo_url> external/mcp-abap-adt
  ```
- Запуск як **internal service** (локальний порт, наприклад `127.0.0.1:7070`).  
- Конфіг у `package.json`:
  ```json
  {
    "cds": {
      "requires": {
        "mcpTarget": {
          "kind": "rest",
          "credentials": { "url": "http://127.0.0.1:7070" }
        }
      }
    }
  }
  ```

---

## 8. Технічні деталі реалізації

### 8.1 Auth shim (універсальний)
```js
const xsenv = require('@sap/xsenv')
const xssec = require('@sap/xssec')
let xsuaa
try { xsuaa = xsenv.getServices({ uaa: { tag: 'xsuaa' } }).uaa } catch {}

async function authShim(req, res, next) {
  const hdr = req.headers.authorization || ''
  try {
    if (hdr.startsWith('Basic ')) {
      const [user] = Buffer.from(hdr.slice(6), 'base64').toString('utf8').split(':')
      const roles = user === 'alice' ? ['MCP_Connector','MCP_Admin'] : ['MCP_Connector']
      req.user = new cds.User({ id: user || 'anonymous', roles })
      return next()
    }
    if (hdr.startsWith('Bearer ')) {
      if (!xsuaa) throw new Error('No XSUAA binding')
      await new Promise((resolve, reject) =>
        xssec.createSecurityContext(hdr.slice(7), xsuaa, (e, sc) => e ? reject(e) : resolve(req._sc = sc)))
      const xsapp = xsuaa.xsappname
      const scopes = new Set(req._sc.getScopes() || [])
      const roles = []
      if (scopes.has(f`${{xsapp}}.MCP_Connect`)) roles.push('MCP_Connector')
      if (scopes.has(f`${{xsapp}}.MCP_Admin`))   roles.push('MCP_Admin')
      req.user = new cds.User({ id: req._sc.getLogonName(), roles })
      return next()
    }
    return res.status(401).send('Unauthorized')
  } catch (e) { return res.status(401).send('Unauthorized: ' + e.message) }
}
```

### 8.2 SSE‑проксі (схема)
```js
cds.on('bootstrap', (app) => {
  app.get('/mcp/stream/sse', authShim, async (req, res) => {
    const u = req.user
    if (!u || !u.is('MCP_Connector')) return res.sendStatus(403)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write('retry: 15000\n\n')
    const hb = setInterval(() => res.write(': ping\n\n'), 15000)

    const target = cds.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070'
    const upstream = await fetch(target + '/sse', { headers: { Accept: 'text/event-stream' } })
    upstream.body.on('data', chunk => res.write(chunk))
    upstream.body.on('end',  () => { clearInterval(hb); res.end() })
    req.on('close', () => { upstream.body?.destroy?.(); clearInterval(hb); res.end() })
  })
})
```

### 8.3 Stream‑HTTP проксі (схема)
```js
cds.on('bootstrap', (app) => {
  app.post('/mcp/stream/http', authShim, async (req, res) => {
    const u = req.user
    if (!u || !u.is('MCP_Connector')) return res.sendStatus(403)

    const target = cds.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070'
    const upstream = await fetch(target + '/stream', { method: 'POST', body: req })
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/x-ndjson')
    upstream.body.on('data', chunk => res.write(chunk))
    upstream.body.on('end', () => res.end())
    req.on('close', () => upstream.body?.destroy?.())
  })
})
```

---

## 9. Конфігурація середовища

### 9.1 `package.json`
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
      "auth": { "kind": "xsuaa" },
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
              "alice": { "roles": ["MCP_Connector","MCP_Admin"] },
              "bob":   { "roles": ["MCP_Connector"] }
            }
          }
        }
      }
    }
  }
}
```

### 9.2 `xs-security.json` (скелет)
(див. §5.1)

### 9.3 `default-env.json` (локально, шаблон)
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

## 10. Режими запуску

### Dev
```bash
cds watch --profile dev
# Cline:
# Authorization: Basic YWxpY2U6  (alice:)
```

### Prod
- Прив’язка xsuaa до сервісу (CF bind).  
- Клієнти використовують `Authorization: Bearer <JWT>` (service token або on‑behalf‑of).  
- Запуск MCP‑таргета (`mcp-abap-adt`) окремим процесом/контейнером.

---

## 11. Приклади для Cline

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

**stream-http (`cline.json`):**
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

## 12. Нефункціональні вимоги

- **Надійність стрімів**: heartbeat, reconnection notes, тайм‑аути 60–120 c, без компресії.
- **Продуктивність**: ≥ 500 подій/сек, p95 latency ≤ 200 мс при локальному таргеті.
- **Безпека**: ліміти розміру, rate limiting, відсутність чутливих логів, JWT валідація.
- **Спостережуваність**: структурувати логи (JSON), кореляція запитів, метрики (ops/sec, bytes, open streams).

---

## 13. Критерії приймання

1. Користувач з роллю **MCP_Connector** може встановити SSE/stream‑http конекшн і отримує події з `mcp-abap-adt`.
2. Користувач **без ролі** отримує `403`.
3. Dev‑режим: *alice* через Basic отримує доступ; *bob* — лише читання; анонім — `401`.
4. Потоки не буферизуються, не компресуються; heartbeat і reconnection працюють.
5. Навантаження 500 evt/s не призводить до memory leak і падінь.
6. Документація з прикладами для Cline/`curl` присутня.

---

## 14. Відкриті питання / Ризики

- Чи потрібна підтримка **on‑behalf‑of** (end‑user) замість service token?  
- Чи слід додати **RBAC за ресурсами MCP** (namespace/project‑level)?  
- Взаємодія з App Router для нестрімових роутів (UI) — залишається поза цим ТЗ.

---

## 15. Подальші кроки

1. Додати submodule `mcp-abap-adt` і підняти test endpoint.  
2. Реалізувати `authShim` і два стрім‑проксі.  
3. Додати `xs-security.json` і dev‑mock профіль.  
4. Написати smoke‑тести (`curl`/Cline).  
5. Прогнати навантаження і перевірити метрики/логи.
