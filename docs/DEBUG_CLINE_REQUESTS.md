# Де ловити звернення від Cline під час гібридної відладки

Cline робить **POST** запити до `/mcp/stream/http` (StreamableHTTP endpoint).

## 🔍 Breakpoints для відлагодження

### 1. **Вхідний запит від Cline** (найперший breakpoint)
**Файл:** `srv/server.ts`  
**Рядок:** `400` (middleware для `/mcp` routes)

```typescript
app.use((req: Request, res: Response, next: NextFunction) => {
  // 🔴 BREAKPOINT ТУТ - перша точка де бачимо запит від Cline
  if (!req.path?.startsWith('/mcp')) {
    return next();
  }
  // ... auth processing
});
```

**Що дивитися:**
- `req.path` - має бути `/mcp/stream/http`
- `req.method` - має бути `POST`
- `req.headers.authorization` - чи є auth header
- `req.headers['x-sap-destination']` - яка destination використовується

---

### 2. **Обробка авторизації**
**Файл:** `srv/server.ts`  
**Рядок:** `426` (виклик `authShim`)

```typescript
return authShim(req, res, next);
```

Або всередині `authShim`:
**Рядок:** `25` (початок функції `authShim`)

```typescript
async function authShim(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 🔴 BREAKPOINT ТУТ - перевірка авторизації
  const log = cds.log('mcp-proxy/authShim');
  const hdr = req.headers.authorization || '';
  // ...
}
```

**Що дивитися:**
- Який тип auth (Basic чи Bearer)
- Чи встановлено `req.user` після authShim
- Які ролі має користувач (`req.user.roles`)

---

### 3. **Обробка StreamableHTTP запиту** (основний handler)
**Файл:** `srv/server.ts`  
**Рядок:** `164` (початок функції `handleStreamHTTP`)

```typescript
async function handleStreamHTTP(req: Request, res: Response): Promise<any> {
  // 🔴 BREAKPOINT ТУТ - обробка StreamableHTTP запиту від Cline
  const log = cds.log('mcp-proxy/stream-http');
  const user = (req as any).user;
  // ...
}
```

**Що дивитися:**
- Чи є `req.user` (не має бути `undefined`)
- Чи є роль `MCP_Connector` у користувача
- Headers: `x-sap-destination`, `x-sap-client`, etc.

---

### 4. **Отримання MCP сервера**
**Файл:** `srv/mcp-manager.ts`  
**Рядок:** `214` (виклик `extractSapContext`)

```typescript
const sapContext = await extractSapContext(req);
// 🔴 BREAKPOINT ТУТ - після отримання SAP контексту
const { sapConfig, destination, cacheExpiresAt } = sapContext;
```

Або:
**Рядок:** `77` (початок `extractSapContext`)

```typescript
async function extractSapContext(req: Request): Promise<SapContext> {
  // 🔴 BREAKPOINT ТУТ - витягування SAP контексту з запиту
  const log = cds.log('mcp-manager/extractSapContext');
  // ...
}
```

**Що дивитися:**
- `sapConfig.url` - URL ABAP системи
- `sapConfig.authType` - тип авторизації (basic/jwt)
- `destination` - конфігурація destination
- `destinationName` - назва destination

---

### 5. **Створення/отримання кешованого MCP сервера**
**Файл:** `srv/mcp-manager.ts`  
**Рядок:** `231` (перевірка кешу)

```typescript
const cached = instanceCache.get(cacheKey);
if (cached) {
  // 🔴 BREAKPOINT ТУТ - якщо MCP сервер вже в кеші
  // ...
}
```

Або:
**Рядок:** `250` (створення нового MCP сервера)

```typescript
// Create new MCP server instance
// 🔴 BREAKPOINT ТУТ - створення нового MCP сервера
const mcpServer = createMCPServer(sapConfig);
// ...
```

---

## 🚀 Як запустити гібридну відладку

1. **Запустити конфігурацію:**
   - VS Code: `F5` або Run → "cds watch (Hybrid - Local + Cloud Services)"
   - Або вручну: `cds watch --profile production`

2. **Поставити breakpoints** у файлах вище

3. **Зробити запит від Cline:**
   - Cline автоматично зробить POST до `/mcp/stream/http`
   - Debugger зупиниться на першому breakpoint

---

## 📋 Типовий потік виконання для запиту від Cline

```
1. cds.on('bootstrap') middleware (рядок 400)
   ↓
2. authShim() - обробка авторизації (рядок 25 або 426)
   ↓
3. app.post('/mcp/stream/http', handleStreamHTTP) - router (рядок 477)
   ↓
4. handleStreamHTTP() - основний handler (рядок 164)
   ↓
5. getMCPServer(req) - отримання MCP сервера (рядок 207)
   ↓
6. extractSapContext(req) - витягування SAP конфігурації (рядок 77)
   ↓
7. Створення/отримання MCP сервера з кешу (рядок 231 або 250)
   ↓
8. Обробка запиту через MCP transport
```

---

## 🔧 Debug Console Commands

Під час зупинки на breakpoint можна використовувати:

```javascript
// Перевірити request
req.path
req.method
req.headers

// Перевірити авторизацію
req.user
req.user?.id
req.user?.roles

// Перевірити destination
req.headers['x-sap-destination']

// Перевірити SAP config (в extractSapContext або після)
sapConfig
destination
```

---

## ⚠️ Важливо

1. **Cline робить POST `/mcp/stream/http`** (не GET, не SSE)
2. **Auth header:** Cline може не надсилати auth header (потрібно перевірити)
3. **Destination:** Перевірити чи є header `x-sap-destination`
4. **Помилки:** Якщо 502 - дивитися логи або breakpoint у error handler (рядок 431)

