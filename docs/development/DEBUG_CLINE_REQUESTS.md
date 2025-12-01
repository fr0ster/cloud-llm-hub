# Where to Catch Cline Requests During Hybrid Debugging

Cline makes **POST** requests to `/mcp/stream/http` (StreamableHTTP endpoint).

## 🔍 Breakpoints for Debugging

### 1. **Incoming Request from Cline** (first breakpoint)

**File:** `srv/server.ts`  
**Line:** `400` (middleware for `/mcp` routes)

```typescript
app.use((req: Request, res: Response, next: NextFunction) => {
  // 🔴 BREAKPOINT HERE - first point where we see the request from Cline
  if (!req.path?.startsWith('/mcp')) {
    return next();
  }
  // ... auth processing
});
```

**What to check:**

- `req.path` - should be `/mcp/stream/http`
- `req.method` - should be `POST`
- `req.headers.authorization` - whether auth header exists
- `req.headers['x-sap-destination']` - which destination is being used

---

### 2. **Authorization Processing**

**File:** `srv/server.ts`  
**Line:** `426` (call to `authShim`)

```typescript
return authShim(req, res, next);
```

Or inside `authShim`:
**Line:** `25` (beginning of `authShim` function)

```typescript
async function authShim(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 🔴 BREAKPOINT HERE - authorization check
  const log = cds.log('mcp-proxy/authShim');
  const hdr = req.headers.authorization || '';
  // ...
}
```

**What to check:**

- Which auth type (Basic or Bearer)
- Whether `req.user` is set after authShim
- Which roles the user has (`req.user.roles`)

---

### 3. **StreamableHTTP Request Processing** (main handler)

**File:** `srv/server.ts`  
**Line:** `164` (beginning of `handleStreamHTTP` function)

```typescript
async function handleStreamHTTP(req: Request, res: Response): Promise<any> {
  // 🔴 BREAKPOINT HERE - processing StreamableHTTP request from Cline
  const log = cds.log('mcp-proxy/stream-http');
  const user = (req as any).user;
  // ...
}
```

**What to check:**

- Whether `req.user` exists (should not be `undefined`)
- Whether user has `MCP_Connector` role
- Headers: `x-sap-destination`, `x-sap-client`, etc.

---

### 4. **Getting MCP Server**

**File:** `srv/mcp-manager.ts`  
**Line:** `214` (call to `extractSapContext`)

```typescript
const sapContext = await extractSapContext(req);
// 🔴 BREAKPOINT HERE - after getting SAP context
const { sapConfig, destination, cacheExpiresAt } = sapContext;
```

Or:
**Line:** `77` (beginning of `extractSapContext`)

```typescript
async function extractSapContext(req: Request): Promise<SapContext> {
  // 🔴 BREAKPOINT HERE - extracting SAP context from request
  const log = cds.log('mcp-manager/extractSapContext');
  // ...
}
```

**What to check:**

- `sapConfig.url` - ABAP system URL
- `sapConfig.authType` - authentication type (basic/jwt)
- `destination` - destination configuration
- `destinationName` - destination name

---

### 5. **Creating/Getting Cached MCP Server**

**File:** `srv/mcp-manager.ts`  
**Line:** `231` (cache check)

```typescript
const cached = instanceCache.get(cacheKey);
if (cached) {
  // 🔴 BREAKPOINT HERE - if MCP server is already in cache
  // ...
}
```

Or:
**Line:** `250` (creating new MCP server)

```typescript
// Create new MCP server instance
// 🔴 BREAKPOINT HERE - creating new MCP server
const mcpServer = createMCPServer(sapConfig);
// ...
```

**Note:** If a destination name is provided, `CloudSdkAbapConnection` is used, which leverages SAP Cloud SDK's `executeHttpRequest` for automatic destination handling.

---

## 🚀 How to Start Hybrid Debugging

1. **Start configuration:**
   - VS Code: `F5` or Run → "cds watch (Hybrid - Local + Cloud Services)"
   - Or manually: `cds watch --profile production`

2. **Set breakpoints** in the files above

3. **Make request from Cline:**
   - Cline will automatically make POST to `/mcp/stream/http`
   - Debugger will stop at the first breakpoint

---

## 📋 Typical Execution Flow for Cline Request

```
1. cds.on('bootstrap') middleware (line 400)
   ↓
2. authShim() - authorization processing (line 25 or 426)
   ↓
3. app.post('/mcp/stream/http', handleStreamHTTP) - router (line 477)
   ↓
4. handleStreamHTTP() - main handler (line 164)
   ↓
5. getMCPServer(req) - getting MCP server (line 207)
   ↓
6. extractSapContext(req) - extracting SAP configuration (line 77)
   ↓
7. Creating/getting MCP server from cache (line 231 or 250)
   ↓
8. Processing request through MCP transport
```

---

## 🔧 Debug Console Commands

While stopped at a breakpoint, you can use:

```javascript
// Check request
req.path;
req.method;
req.headers;

// Check authorization
req.user;
req.user?.id;
req.user?.roles;

// Check destination
req.headers['x-sap-destination'];

// Check SAP config (in extractSapContext or after)
sapConfig;
destination;
```

---

## ⚠️ Important

1. **Cline makes POST `/mcp/stream/http`** (not GET, not SSE)
2. **Auth header:** Cline may not send auth header (needs to be checked)
3. **Destination:** Check if header `x-sap-destination` exists
4. **Errors:** If 502 - check logs or breakpoint in error handler (line 431)
