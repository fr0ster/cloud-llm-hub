# mcp-abap-adt Library Usage Guide

**Date:** December 2025  
**Version:** 1.0  
**Status:** Current

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Import Strategy](#import-strategy)
3. [Key Components](#key-components)
4. [Usage Patterns](#usage-patterns)
5. [Best Practices](#best-practices)
6. [Common Pitfalls](#common-pitfalls)

---

## 🎯 Overview

This document explains how `cloud-llm-hub` uses the `mcp-abap-adt` library. It covers import strategies, key components, usage patterns, and best practices.

### Library Structure

```
@fr0ster/mcp-abap-adt (submodule)
├── src/
│   ├── index.ts                    # Main MCP server class
│   ├── handlers/                   # ADT tool handlers
│   └── lib/
│       ├── utils.ts               # sessionContext, getManagedConnection
│       ├── logger.ts              # Logging utilities
│       └── loggerAdapter.ts       # Logger adapter interface
├── packages/
│   ├── @mcp-abap-adt/connection   # Base connection (axios)
│   ├── @mcp-abap-adt/adt-clients  # ADT clients (CrudClient, etc.)
│   ├── @mcp-abap-adt/auth-broker  # AuthBroker for token refresh
│   └── @mcp-abap-adt/header-validator # Header validation
└── dist/                           # Compiled output
```

---

## 📦 Import Strategy

### 1. Environment Setup (Critical!)

**Location:** `srv/env-setup.ts`

**Purpose:** Prevent submodule from auto-loading `.env` files

```typescript
// MUST be imported FIRST, before any mcp-abap-adt imports
import './env-setup';

// env-setup.ts sets:
process.env.MCP_SKIP_AUTO_START = 'true';
process.env.MCP_SKIP_ENV_LOAD = 'true';
```

**Why:** cloud-llm-hub passes SAP config via HTTP headers, not `.env` files. The submodule's auto-load logic would interfere.

### 2. Dynamic Import for MCP Server

**Location:** `srv/mcp-manager.ts`

**Pattern:**
```typescript
// Dynamic import to avoid executing top-level code
const { mcp_abap_adt_server } = await import('@fr0ster/mcp-abap-adt');
const mcpServerInstance = new mcp_abap_adt_server(serverOptions);
```

**Why:** The submodule's `index.ts` has top-level code that loads `.env`. Dynamic import delays execution until after environment setup.

### 3. Static Import for Utilities

**Location:** `srv/server.ts`, `srv/mcp-manager.ts`

**Pattern:**
```typescript
import { validateAuthHeaders } from '@mcp-abap-adt/header-validator';
import { createAbapConnection } from '@mcp-abap-adt/connection';
import type { AbapConnection, SapConfig } from '@mcp-abap-adt/connection';
```

**Why:** These are pure functions/types, no side effects. Safe to import statically.

### 4. Runtime Access for sessionContext

**Location:** `srv/server.ts`

**Pattern:**
```typescript
// Use require() to access the same instance that mcp-abap-adt uses internally
const mcpUtils = require('@fr0ster/mcp-abap-adt/dist/lib/utils.js');
const mcpSessionContext = mcpUtils.sessionContext;
```

**Why:** `sessionContext` is a singleton AsyncLocalStorage instance. We must use the same instance that `getManagedConnection()` reads from.

---

## 🔧 Key Components

### 1. MCP Server Class

**Import:**
```typescript
const { mcp_abap_adt_server } = await import('@fr0ster/mcp-abap-adt');
```

**Usage:**
```typescript
const serverOptions = {
  connection?: AbapConnection,      // Optional: for destination-based
  sapConfig?: SapConfig,            // Optional: for direct (but we use sessionContext instead)
  allowProcessExit: false,          // Prevent submodule from exiting process
  registerSignalHandlers: false    // Prevent submodule from registering signal handlers
};

const mcpServer = new mcp_abap_adt_server(serverOptions);
```

**Key Points:**
- For destination-based: Pass `connection` directly
- For direct (Basic/JWT): Omit both `connection` and `sapConfig`, use `sessionContext` instead
- Always set `allowProcessExit: false` and `registerSignalHandlers: false` in cloud-llm-hub

### 2. sessionContext (AsyncLocalStorage)

**Access:**
```typescript
const mcpUtils = require('@fr0ster/mcp-abap-adt/dist/lib/utils.js');
const sessionContext = mcpUtils.sessionContext;
```

**Usage:**
```typescript
await sessionContext.run(
  {
    sessionId: 'unique-session-id',
    sapConfig: {
      url: 'https://sap-system.com',
      authType: 'jwt',
      jwtToken: 'eyJhbGci...',
      // ... other config
    }
  },
  async () => {
    // Inside this callback, getManagedConnection() will use the sapConfig from context
    await transport.handleRequest(req, res, body);
  }
);
```

**Key Points:**
- Each HTTP request should run in its own `sessionContext.run()` call
- `sapConfig` in context is used by `getManagedConnection()` automatically
- Context is request-scoped (AsyncLocalStorage)

### 3. getManagedConnection()

**Access:**
```typescript
const mcpUtils = require('@fr0ster/mcp-abap-adt/dist/lib/utils.js');
const getManagedConnection = mcpUtils.getManagedConnection;
```

**Usage:**
```typescript
// Inside sessionContext.run() callback
const connection = getManagedConnection();
// Connection is automatically created/cached based on sessionContext.sapConfig
```

**Key Points:**
- Must be called inside `sessionContext.run()` callback
- Reads `sapConfig` from `sessionContext.getStore()`
- Returns cached connection if available, creates new one otherwise
- Only for direct connections (Basic/JWT), not for destination-based

### 4. validateAuthHeaders()

**Import:**
```typescript
import { validateAuthHeaders } from '@mcp-abap-adt/header-validator';
```

**Usage:**
```typescript
const validationResult = validateAuthHeaders(req.headers);

if (!validationResult.isValid) {
  throw new Error(`Invalid authentication headers: ${validationResult.errors.join('; ')}`);
}

const config = validationResult.config;
// Use config to build SapConfig
```

**Key Points:**
- Validates headers for direct connections (not destinations)
- Returns structured result with `isValid`, `config`, `errors`, `warnings`
- Handles priority: SAP Destination > MCP Destination > JWT > Basic

### 5. createAbapConnection()

**Import:**
```typescript
import { createAbapConnection } from '@mcp-abap-adt/connection';
```

**Usage:**
```typescript
const connection = createAbapConnection(
  sapConfig,
  logger,
  sessionStorage,
  sessionId
);
```

**Key Points:**
- Creates base connection (axios-based) for direct Basic/JWT auth
- Used by connection factory for non-destination connections
- Returns `AbapConnection` interface implementation

---

## 🎨 Usage Patterns

### Pattern 1: Destination-Based Connection

**When:** BTP Destination name provided in `X-SAP-Destination` header

**Flow:**
```typescript
// 1. Resolve destination
const resolved = await resolveDestinationSapConfig(destinationName, jwtToken);

// 2. Create CloudSdkAbapConnection
const connection = new CloudSdkAbapConnection(resolved.sapConfig, destinationName);

// 3. Create MCP server with connection
const mcpServer = new mcp_abap_adt_server({
  connection,  // Pass connection directly
  allowProcessExit: false,
  registerSignalHandlers: false
});

// 4. Use server (no sessionContext needed)
await mcpServer.server.connect(transport);
await transport.handleRequest(req, res, body);
```

**Key Points:**
- Connection created before MCP server
- Connection passed to constructor
- No `sessionContext` needed (connection is already configured)

### Pattern 2: Direct Connection (Basic/JWT)

**When:** Direct URL + Basic/JWT auth (no destination)

**Flow:**
```typescript
// 1. Extract and validate headers
const validationResult = validateAuthHeaders(req.headers);
const sapConfig = buildSapConfigFromValidation(validationResult);

// 2. Create MCP server WITHOUT connection or sapConfig
const mcpServer = new mcp_abap_adt_server({
  // Don't pass connection or sapConfig!
  allowProcessExit: false,
  registerSignalHandlers: false
});

// 3. Run in sessionContext
await sessionContext.run(
  { sessionId, sapConfig },
  async () => {
    // 4. Inside context, getManagedConnection() will use sapConfig
    await mcpServer.server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
);
```

**Key Points:**
- Don't pass `connection` or `sapConfig` to constructor
- Use `sessionContext.run()` to provide per-request config
- `getManagedConnection()` reads from context automatically

### Pattern 3: Connection Factory

**When:** Need to create connection based on configuration

**Flow:**
```typescript
import { createConnection } from './connections/connectionFactory';

const connection = createConnection({
  sapConfig,
  destinationName,  // Optional: if provided, uses CloudSdkAbapConnection
  logger,
  sessionStorage,
  sessionId
});
```

**Key Points:**
- Single entry point for connection creation
- Automatic type selection (Destination vs Direct)
- Consistent interface

---

## ✅ Best Practices

### 1. Always Import env-setup First

```typescript
// ✅ CORRECT
import './env-setup';
import { ... } from '@fr0ster/mcp-abap-adt';

// ❌ WRONG
import { ... } from '@fr0ster/mcp-abap-adt';
import './env-setup';  // Too late!
```

### 2. Use Dynamic Import for MCP Server

```typescript
// ✅ CORRECT
const { mcp_abap_adt_server } = await import('@fr0ster/mcp-abap-adt');

// ❌ WRONG (if top-level)
import { mcp_abap_adt_server } from '@fr0ster/mcp-abap-adt';  // Executes top-level code!
```

### 3. Clear Environment Variables Before Server Creation

```typescript
// ✅ CORRECT
const oldEnv = { SAP_URL: process.env.SAP_URL, ... };
delete process.env.SAP_URL;
// ... create server ...
Object.assign(process.env, oldEnv);

// ❌ WRONG
// Server might read stale env vars
```

### 4. Use sessionContext for Direct Connections

```typescript
// ✅ CORRECT
await sessionContext.run({ sessionId, sapConfig }, async () => {
  // Handler code
});

// ❌ WRONG
// Passing sapConfig to constructor creates global override
const server = new mcp_abap_adt_server({ sapConfig });  // Bad!
```

### 5. Cache MCP Server Instances

```typescript
// ✅ CORRECT
const cacheKey = getCacheKey(sapConfig, destinationName);
let cached = instanceCache.get(cacheKey);
if (!cached) {
  cached = await createNewServer(...);
  instanceCache.set(cacheKey, cached);
}

// ❌ WRONG
// Creating new server for every request is expensive
const server = await createNewServer(...);  // Bad!
```

---

## ⚠️ Common Pitfalls

### Pitfall 1: Environment Variables Leaking

**Problem:** Submodule reads `.env` files or cached env vars

**Solution:**
```typescript
// Set flags BEFORE imports
process.env.MCP_SKIP_ENV_LOAD = 'true';

// Clear env vars before server creation
delete process.env.SAP_URL;
// ... create server ...
```

### Pitfall 2: Wrong sessionContext Instance

**Problem:** Using different `sessionContext` instance than `getManagedConnection()`

**Solution:**
```typescript
// Use require() to get the same instance
const mcpUtils = require('@fr0ster/mcp-abap-adt/dist/lib/utils.js');
const sessionContext = mcpUtils.sessionContext;  // Same instance!
```

### Pitfall 3: Passing sapConfig to Constructor for Direct Connections

**Problem:** Creates global override, prevents per-request tokens

**Solution:**
```typescript
// Don't pass sapConfig to constructor
const server = new mcp_abap_adt_server({
  // No sapConfig here!
});

// Use sessionContext instead
await sessionContext.run({ sapConfig }, async () => {
  // Handler code
});
```

### Pitfall 4: Not Clearing Cache on Token Expiry

**Problem:** Using expired tokens from cache

**Solution:**
```typescript
if (cached.expiresAt && cached.expiresAt <= Date.now()) {
  instanceCache.delete(cacheKey);
  // Create new instance
}
```

### Pitfall 5: Mixing Connection Types

**Problem:** Using `CloudSdkAbapConnection` for direct connections

**Solution:**
```typescript
// Use connection factory
const connection = createConnection({
  sapConfig,
  destinationName  // Only if destination-based
});
```

---

## 📚 Related Documentation

- [Integration Architecture](../architecture/INTEGRATION_ARCHITECTURE.md) - Overall architecture
- [Connection Architecture](CONNECTION_ARCHITECTURE.md) - Connection types
- [Code Sharing Policy](CODE_SHARING_POLICY.md) - Duplication policy
- [MCP ABAP ADT Integration](MCP_ABAP_ADT_INTEGRATION.md) - Integration roadmap

---

**Author:** AI Assistant  
**Last Updated:** December 2025  
**Version:** 1.0

