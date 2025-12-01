# Code Sharing Policy

**Date:** December 2025  
**Version:** 1.0  
**Status:** Current

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Policy Principles](#policy-principles)
3. [What is NOT Duplication](#what-is-not-duplication)
4. [What We Share](#what-we-share)
5. [What We Duplicate (and Why)](#what-we-duplicate-and-why)
6. [Synchronization Strategy](#synchronization-strategy)
7. [Decision Matrix](#decision-matrix)

---

## 🎯 Overview

This document defines the policy for code sharing and duplication between `cloud-llm-hub` and `mcp-abap-adt`. It clarifies what is considered duplication vs. extension, and provides guidelines for when to share code vs. when to duplicate.

### Key Principle

**Extension, Not Duplication**: cloud-llm-hub extends mcp-abap-adt functionality for BTP Cloud, not duplicates it.

---

## 📐 Policy Principles

### 1. Extension Over Duplication

**Rule:** If functionality can be extended rather than duplicated, extend it.

**Example:**

- ✅ `CloudSdkAbapConnection` extends `AbapConnection` interface
- ❌ Don't reimplement MCP protocol handlers

### 2. Different Transport = Different Implementation

**Rule:** If transport mechanism differs (axios vs Cloud SDK), separate implementations are acceptable.

**Example:**

- ✅ CSRF token fetching: axios (base) vs Cloud SDK (extension)
- ✅ Connection creation: different HTTP clients

### 3. Shared Logic = Shared Code

**Rule:** If logic is identical, extract to shared config/utilities.

**Example:**

- ✅ CSRF retry parameters → `csrfConfig.ts`
- ✅ Error message formats → synchronized constants

### 4. BTP-Specific = cloud-llm-hub Only

**Rule:** BTP-specific functionality belongs in cloud-llm-hub, not base library.

**Example:**

- ✅ Destination Service resolution
- ✅ Cloud Connector integration
- ✅ CAP service definitions

---

## ✅ What is NOT Duplication

### 1. CloudSdkAbapConnection vs Base Connection

**Status:** ✅ Extension, NOT duplication

**Reasoning:**

- Base: `@mcp-abap-adt/connection` uses axios + Basic/JWT
- Extension: `CloudSdkAbapConnection` uses Cloud SDK + Destinations
- Different transport stacks → different implementations
- Both implement `AbapConnection` interface → compatible

**Decision:** Keep separate implementations, synchronize parameters.

### 2. CSRF Token Management

**Status:** ✅ Similar logic, different implementations

**Reasoning:**

- Base: axios-based CSRF fetching
- Extension: Cloud SDK-based CSRF fetching
- Logic similar, but HTTP clients differ
- Retry parameters synchronized via `csrfConfig.ts`

**Decision:** Keep separate implementations, synchronize via shared config.

### 3. Destination Resolution

**Status:** ✅ BTP-specific, unique to cloud-llm-hub

**Reasoning:**

- Requires BTP Destination Service
- Cloud Connector support
- Not applicable to standalone mcp-abap-adt

**Decision:** Keep in cloud-llm-hub only.

### 4. CAP Integration

**Status:** ✅ cloud-llm-hub specific

**Reasoning:**

- CAP service definitions
- Express middleware
- BTP deployment structure

**Decision:** Keep in cloud-llm-hub only.

---

## 🔄 What We Share

### 1. CSRF Configuration

**Location:** `srv/connections/csrfConfig.ts`

**Shared Constants:**

- `RETRY_COUNT`: 3
- `RETRY_DELAY`: 1000ms
- `ENDPOINT`: '/sap/bc/adt/discovery'
- `REQUIRED_HEADERS`: Headers for CSRF fetch

**Usage:**

- `CloudSdkAbapConnection.fetchCsrfToken()` uses shared config
- Base library has hardcoded values (synchronized manually)

**Future:** Propose PR to mcp-abap-adt to export `CSRF_CONFIG`.

### 2. Header Validation

**Location:** `@mcp-abap-adt/header-validator`

**Shared Function:**

- `validateAuthHeaders(headers): HeaderValidationResult`

**Usage:**

- `srv/mcp-manager.ts::extractSapContext()` uses for direct connections
- Centralized validation logic
- Consistent error messages

**Status:** ✅ Already shared via package.

### 3. Session Context

**Location:** `@fr0ster/mcp-abap-adt/dist/lib/utils.js`

**Shared Component:**

- `sessionContext`: AsyncLocalStorage instance

**Usage:**

- `srv/server.ts` uses same instance for per-request context
- `getManagedConnection()` reads from same context

**Status:** ✅ Already shared via runtime access.

### 4. Connection Interface

**Location:** `@mcp-abap-adt/connection`

**Shared Interface:**

- `AbapConnection` interface

**Usage:**

- `CloudSdkAbapConnection` implements interface
- Base connections also implement interface
- Factory pattern uses interface for type safety

**Status:** ✅ Already shared via package.

---

## 🔁 What We Duplicate (and Why)

### 1. URL Handling

**Status:** ✅ Minimal duplication (basic trimming only)

**Current State:**

- Base: `url.trim()` (v1.1.19 removed aggressive cleaning)
- Extension: Basic validation, no special cleaning

**Decision:** ✅ Keep minimal - rely on base validation.

### 2. Error Handling Patterns

**Status:** 🟡 Partial duplication (different backends)

**Current State:**

- Base: Uses `safeStringifyError` from mcp-abap-adt
- Extension: Uses `cds.log()` with custom error formatting

**Decision:** 🟡 Synchronize error message formats, keep different backends.

**TODO:** Phase 3.1 - Synchronize error handling.

### 3. Logger Adapter

**Status:** ✅ Different backends (not duplication)

**Current State:**

- Base: Custom logger implementation
- Extension: `cds.log()` adapter

**Decision:** ✅ Keep separate - different logging backends.

---

## 🔀 Synchronization Strategy

### 1. Shared Constants

**Pattern:**

```typescript
// cloud-llm-hub/srv/connections/csrfConfig.ts
export const CSRF_CONFIG = {
  RETRY_COUNT: 3,
  RETRY_DELAY: 1000,
  // ...
};
```

**Usage:**

- Extension uses shared config
- Base library has hardcoded values (synchronized manually)
- Future: Export from base library

### 2. Package Imports

**Pattern:**

```typescript
// Use shared packages from mcp-abap-adt
import { validateAuthHeaders } from '@mcp-abap-adt/header-validator';
import { createAbapConnection } from '@mcp-abap-adt/connection';
```

**Usage:**

- Direct imports for shared utilities
- No duplication of logic

### 3. Runtime Access

**Pattern:**

```typescript
// Access shared instances at runtime
const mcpUtils = require('@fr0ster/mcp-abap-adt/dist/lib/utils.js');
const sessionContext = mcpUtils.sessionContext;
```

**Usage:**

- Access singletons (sessionContext, connection cache)
- Same instance used by base library

### 4. Interface Compliance

**Pattern:**

```typescript
// Implement shared interfaces
export class CloudSdkAbapConnection implements AbapConnection {
  // Implementation using Cloud SDK
}
```

**Usage:**

- Type safety via shared interfaces
- Polymorphism for different implementations

---

## 📊 Decision Matrix

### When to Share Code

| Scenario                             | Decision           | Example                |
| ------------------------------------ | ------------------ | ---------------------- |
| Identical logic, same transport      | ✅ Share           | Header validation      |
| Identical logic, different transport | 🟡 Share constants | CSRF retry parameters  |
| Similar logic, different use case    | ❌ Don't share     | Connection creation    |
| BTP-specific functionality           | ❌ Don't share     | Destination resolution |

### When to Duplicate Code

| Scenario                           | Decision                    | Example                            |
| ---------------------------------- | --------------------------- | ---------------------------------- |
| Different transport stacks         | ✅ Duplicate                | CSRF fetching (axios vs Cloud SDK) |
| Different authentication flows     | ✅ Duplicate                | Connection creation                |
| BTP-specific requirements          | ✅ Duplicate                | Destination Service integration    |
| Identical logic, no shared package | 🟡 Extract to shared config | CSRF parameters                    |

### When to Extend Code

| Scenario               | Decision  | Example                 |
| ---------------------- | --------- | ----------------------- |
| Interface compliance   | ✅ Extend | CloudSdkAbapConnection  |
| Additional features    | ✅ Extend | BTP Destination support |
| Protocol compatibility | ✅ Extend | MCP server integration  |

---

## 🎯 Synchronization Checklist

### ✅ Completed

- [x] CSRF configuration extracted to `csrfConfig.ts`
- [x] Header validation uses `@mcp-abap-adt/header-validator`
- [x] Session context uses shared instance
- [x] Connection interface compliance

### 🟡 In Progress

- [ ] Error handling synchronization (Phase 3.1)
- [ ] Propose CSRF_CONFIG export to mcp-abap-adt

### 📋 Future

- [ ] Extract more shared constants
- [ ] Create shared error message formats
- [ ] Document synchronization process

---

## 📝 Examples

### Example 1: CSRF Config (Shared Constants)

**Before:**

```typescript
// CloudSdkAbapConnection.ts
private async fetchCsrfToken(url: string, retryCount = 3, retryDelay = 1000) {
  // Hardcoded values
}
```

**After:**

```typescript
// csrfConfig.ts
export const CSRF_CONFIG = {
  RETRY_COUNT: 3,
  RETRY_DELAY: 1000,
  // ...
};

// CloudSdkAbapConnection.ts
import { CSRF_CONFIG } from './csrfConfig';
private async fetchCsrfToken(url: string) {
  const retryCount = CSRF_CONFIG.RETRY_COUNT;
  // ...
}
```

### Example 2: Header Validation (Shared Package)

**Before:**

```typescript
// mcp-manager.ts
function extractSapContext(req) {
  // Custom validation logic
  if (!req.headers['x-sap-url']) {
    throw new Error('Missing URL');
  }
  // ...
}
```

**After:**

```typescript
// mcp-manager.ts
import { validateAuthHeaders } from '@mcp-abap-adt/header-validator';

function extractSapContext(req) {
  const validationResult = validateAuthHeaders(req.headers);
  if (!validationResult.isValid) {
    throw new Error(validationResult.errors.join('; '));
  }
  // ...
}
```

### Example 3: Connection Extension (Interface Compliance)

**Before:**

```typescript
// Custom connection class
class MyConnection {
  // Incompatible with base library
}
```

**After:**

```typescript
// CloudSdkAbapConnection.ts
import type { AbapConnection } from '@mcp-abap-adt/connection';

export class CloudSdkAbapConnection implements AbapConnection {
  // Compatible with base library
  // Can be used wherever AbapConnection is expected
}
```

---

## 🔍 Related Documentation

- [Integration Architecture](../architecture/INTEGRATION_ARCHITECTURE.md) - Overall architecture
- [MCP ABAP ADT Usage](MCP_ABAP_ADT_USAGE.md) - Library usage guide
- [MCP ABAP ADT Integration](MCP_ABAP_ADT_INTEGRATION.md) - Integration roadmap
- [Connection Architecture](CONNECTION_ARCHITECTURE.md) - Connection types

---

## 📌 Summary

### Key Takeaways

1. **Extension > Duplication**: Extend functionality when possible
2. **Different Transport = Different Implementation**: Acceptable duplication
3. **Shared Logic = Shared Code**: Extract constants and utilities
4. **BTP-Specific = cloud-llm-hub Only**: Don't pollute base library

### Current Status

- ✅ CSRF config shared
- ✅ Header validation shared
- ✅ Session context shared
- 🟡 Error handling synchronization in progress
- 📋 More synchronization opportunities identified

---

**Author:** AI Assistant  
**Last Updated:** December 2025  
**Version:** 1.0
