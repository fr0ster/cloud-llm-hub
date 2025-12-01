# Migration Guide: mcp-abap-adt v1.1.17 → v1.1.19

**Date:** December 2025  
**Version:** 1.0  
**Status:** Current

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Breaking Changes](#breaking-changes)
3. [New Features](#new-features)
4. [Migration Steps](#migration-steps)
5. [Configuration Changes](#configuration-changes)
6. [Code Changes](#code-changes)
7. [Testing Checklist](#testing-checklist)
8. [Rollback Plan](#rollback-plan)

---

## 🎯 Overview

This guide helps you migrate `cloud-llm-hub` from `mcp-abap-adt` v1.1.17 to v1.1.19. The migration includes dependency updates, code refactoring, and new features.

### Version Summary

- **From:** mcp-abap-adt v1.1.17
- **To:** mcp-abap-adt v1.1.19
- **cloud-llm-hub:** v1.0.0 → v1.1.0 (planned)

### Key Changes

1. Handler refactoring to use `CrudClient` and `SharedBuilder`
2. URL handling simplification (removed aggressive cleaning)
3. Lazy AuthBroker initialization
4. ES Module compatibility fixes
5. Optional session storage (stateless by default)
6. New packages: `@mcp-abap-adt/auth-broker`, `@mcp-abap-adt/header-validator`

---

## ⚠️ Breaking Changes

### 1. URL Handling

**Change:** Removed aggressive URL cleaning

**Before (v1.1.17):**
```typescript
// mcp-abap-adt cleaned URLs aggressively
url = url.replace(/\/+$/, '').replace(/^\/+/, '');
// Multiple cleaning operations
```

**After (v1.1.19):**
```typescript
// Only basic trimming
url = url.trim();
```

**Impact on cloud-llm-hub:**
- ✅ No changes needed - cloud-llm-hub already uses clean URLs
- ✅ Verify URLs from Destinations are clean

**Action Required:**
- [ ] Verify Destination URLs are clean (no trailing slashes, etc.)
- [ ] Test with various URL formats

### 2. Session Storage

**Change:** Session storage disabled by default (stateless mode)

**Before (v1.1.17):**
```typescript
// Session storage enabled by default
// Sessions persisted to disk
```

**After (v1.1.19):**
```typescript
// Session storage disabled by default
// Enable via MCP_ENABLE_SESSION_STORAGE=true
```

**Impact on cloud-llm-hub:**
- ✅ Already configured in `srv/env-setup.ts`
- ✅ Default: stateless mode (no session persistence)

**Action Required:**
- [x] Verify `MCP_ENABLE_SESSION_STORAGE` is set in `env-setup.ts`
- [ ] Test with session storage enabled (if needed)
- [ ] Test with session storage disabled (default)

### 3. AuthBroker Initialization

**Change:** Lazy initialization per destination

**Before (v1.1.17):**
```typescript
// AuthBroker created at startup
// Single instance for all requests
```

**After (v1.1.19):**
```typescript
// AuthBroker created on-demand per destination
// Map-based caching: authBrokers: Map<string, AuthBroker>
```

**Impact on cloud-llm-hub:**
- ✅ No changes needed - handled by base library
- ✅ Benefits automatically (reduced memory usage)

**Action Required:**
- [x] Verify no custom AuthBroker creation in cloud-llm-hub
- [ ] Monitor memory usage (should be lower)

---

## 🆕 New Features

### 1. Header Validator Package

**Package:** `@mcp-abap-adt/header-validator`

**Usage:**
```typescript
import { validateAuthHeaders } from '@mcp-abap-adt/header-validator';

const validationResult = validateAuthHeaders(req.headers);
if (!validationResult.isValid) {
  throw new Error(validationResult.errors.join('; '));
}
```

**Benefits:**
- Centralized header validation
- Consistent error messages
- Priority-based selection (SAP Destination > MCP Destination > JWT > Basic)

**Action Required:**
- [x] Update `srv/mcp-manager.ts` to use `validateAuthHeaders`
- [ ] Remove duplicated validation logic (if any)

### 2. Auth Broker Package

**Package:** `@mcp-abap-adt/auth-broker`

**Usage:**
- Used internally by mcp-abap-adt
- No direct usage in cloud-llm-hub needed

**Benefits:**
- Automatic token refresh
- Per-destination caching

**Action Required:**
- [x] Add to `package.json` dependencies
- [ ] Verify token refresh works correctly

### 3. Updated ADT Clients

**Package:** `@mcp-abap-adt/adt-clients` v0.1.32

**Changes:**
- Migration to `CrudClient` and `SharedBuilder`
- Eliminates manual URL construction
- Improved code consistency

**Impact on cloud-llm-hub:**
- ✅ No changes needed - used through public API
- ✅ Benefits automatically (better consistency)

**Action Required:**
- [x] Update `package.json` to `^0.1.32`
- [ ] Test ADT tool handlers

---

## 🔄 Migration Steps

### Step 1: Update Dependencies

**File:** `package.json`

```json
{
  "dependencies": {
    "@mcp-abap-adt/adt-clients": "^0.1.32",
    "@mcp-abap-adt/auth-broker": "^0.1.2",
    "@mcp-abap-adt/header-validator": "^0.1.2",
    "@modelcontextprotocol/sdk": "^1.23.0"
  }
}
```

**Commands:**
```bash
npm install
npm run build
```

**Action Required:**
- [x] Update `package.json`
- [x] Run `npm install`
- [x] Verify `npx cds build` succeeds

### Step 2: Update Code

#### 2.1. Use Header Validator

**File:** `srv/mcp-manager.ts`

**Before:**
```typescript
// Custom validation logic
if (!req.headers['x-sap-url']) {
  throw new Error('Missing URL');
}
```

**After:**
```typescript
import { validateAuthHeaders } from '@mcp-abap-adt/header-validator';

const validationResult = validateAuthHeaders(req.headers);
if (!validationResult.isValid) {
  throw new Error(validationResult.errors.join('; '));
}
const config = validationResult.config;
```

**Action Required:**
- [x] Update `extractSapContext()` to use `validateAuthHeaders`
- [ ] Remove duplicated validation logic

#### 2.2. Verify Session Storage Configuration

**File:** `srv/env-setup.ts`

**Verify:**
```typescript
if (!process.env.MCP_ENABLE_SESSION_STORAGE) {
  process.env.MCP_ENABLE_SESSION_STORAGE = 'false';
}

if (!process.env.MCP_SESSION_DIR) {
  process.env.MCP_SESSION_DIR = './sessions';
}
```

**Action Required:**
- [x] Verify `env-setup.ts` has session storage config
- [ ] Test with session storage enabled/disabled

#### 2.3. Create CSRF Config (Optional but Recommended)

**File:** `srv/connections/csrfConfig.ts`

**Create shared config:**
```typescript
export const CSRF_CONFIG = {
  RETRY_COUNT: 3,
  RETRY_DELAY: 1000,
  ENDPOINT: '/sap/bc/adt/discovery',
  // ...
};
```

**Update:** `srv/connections/CloudSdkAbapConnection.ts`

```typescript
import { CSRF_CONFIG } from './csrfConfig';

private async fetchCsrfToken(url: string): Promise<string> {
  const retryCount = CSRF_CONFIG.RETRY_COUNT;
  // ...
}
```

**Action Required:**
- [x] Create `csrfConfig.ts`
- [x] Update `CloudSdkAbapConnection` to use shared config

### Step 3: Update Documentation

**Files:**
- `docs/architecture/INTEGRATION_ARCHITECTURE.md` (new)
- `docs/contributors/MCP_ABAP_ADT_USAGE.md` (new)
- `docs/contributors/CODE_SHARING_POLICY.md` (new)
- `docs/contributors/MCP_ABAP_ADT_INTEGRATION.md` (update)

**Action Required:**
- [x] Create new documentation files
- [ ] Update existing docs with references

### Step 4: Testing

**Test Scenarios:**
- [ ] Direct Basic auth connection
- [ ] Direct JWT auth connection
- [ ] BTP Destination (Internet)
- [ ] BTP Destination (On-Premise)
- [ ] CSRF token fetching with retries
- [ ] Session storage enabled
- [ ] Session storage disabled (default)
- [ ] Header validation with various headers
- [ ] Error handling with invalid headers

**Action Required:**
- [ ] Run full test suite
- [ ] Test all connection types
- [ ] Verify no regressions

---

## ⚙️ Configuration Changes

### Environment Variables

**New Variables:**
```bash
# Session storage (optional)
MCP_ENABLE_SESSION_STORAGE=false  # Default: false (stateless)
MCP_SESSION_DIR=./sessions         # Default: ./sessions
```

**Existing Variables (unchanged):**
```bash
MCP_SKIP_AUTO_START=true
MCP_SKIP_ENV_LOAD=true
```

**Action Required:**
- [x] Verify `env-setup.ts` sets new variables
- [ ] Update deployment documentation
- [ ] Update `.env` template (if used)

### Package Dependencies

**Updated:**
- `@mcp-abap-adt/adt-clients`: `^0.1.27` → `^0.1.32`
- `@modelcontextprotocol/sdk`: `^1.17.2` → `^1.23.0`

**New:**
- `@mcp-abap-adt/auth-broker`: `^0.1.2`
- `@mcp-abap-adt/header-validator`: `^0.1.2`

**Action Required:**
- [x] Update `package.json`
- [x] Run `npm install`
- [ ] Verify no dependency conflicts

---

## 💻 Code Changes

### Summary of Changes

1. **Header Validation:**
   - ✅ Use `validateAuthHeaders()` from `@mcp-abap-adt/header-validator`
   - ✅ Remove duplicated validation logic

2. **CSRF Configuration:**
   - ✅ Create `srv/connections/csrfConfig.ts`
   - ✅ Update `CloudSdkAbapConnection` to use shared config

3. **Session Storage:**
   - ✅ Configure in `srv/env-setup.ts`
   - ✅ Default to stateless mode

4. **Connection Factory:**
   - ✅ Already implemented
   - ✅ No changes needed

### Files Modified

- `package.json` - Updated dependencies
- `srv/mcp-manager.ts` - Use `validateAuthHeaders`
- `srv/env-setup.ts` - Session storage config
- `srv/connections/csrfConfig.ts` - New file
- `srv/connections/CloudSdkAbapConnection.ts` - Use shared CSRF config

### Files Created

- `docs/architecture/INTEGRATION_ARCHITECTURE.md`
- `docs/contributors/MCP_ABAP_ADT_USAGE.md`
- `docs/contributors/CODE_SHARING_POLICY.md`
- `srv/connections/csrfConfig.ts`

---

## ✅ Testing Checklist

### Unit Tests

- [ ] Header validation with valid headers
- [ ] Header validation with invalid headers
- [ ] CSRF token fetching with retries
- [ ] CSRF token timeout scenarios
- [ ] Session storage enabled
- [ ] Session storage disabled

### Integration Tests

- [ ] Direct Basic auth connection
- [ ] Direct JWT auth connection
- [ ] BTP Destination (Internet)
- [ ] BTP Destination (On-Premise)
- [ ] Multiple concurrent requests
- [ ] Token refresh scenarios

### End-to-End Tests

- [ ] Full MCP request flow (Direct)
- [ ] Full MCP request flow (Destination)
- [ ] Error handling scenarios
- [ ] Performance benchmarks

### Regression Tests

- [ ] All existing functionality works
- [ ] No breaking changes in API
- [ ] Backward compatibility maintained

---

## 🔙 Rollback Plan

### If Migration Fails

1. **Revert Dependencies:**
   ```bash
   git checkout HEAD~1 package.json
   npm install
   ```

2. **Revert Code Changes:**
   ```bash
   git checkout HEAD~1 srv/
   ```

3. **Verify:**
   ```bash
   npm run build
   npm start
   ```

### Rollback Checklist

- [ ] Revert `package.json` to previous version
- [ ] Revert code changes in `srv/`
- [ ] Remove new documentation files (if needed)
- [ ] Run tests to verify rollback
- [ ] Document issues encountered

---

## 📊 Migration Status

### ✅ Completed

- [x] Update dependencies
- [x] Use `validateAuthHeaders`
- [x] Create CSRF config
- [x] Configure session storage
- [x] Create documentation

### 🟡 In Progress

- [ ] Full test suite
- [ ] Performance validation
- [ ] Documentation review

### 📋 Pending

- [ ] Production deployment
- [ ] Monitoring setup
- [ ] User communication

---

## 🔍 Related Documentation

- [MCP ABAP ADT Integration Roadmap](../contributors/MCP_ABAP_ADT_INTEGRATION.md) - Detailed roadmap
- [Integration Architecture](../architecture/INTEGRATION_ARCHITECTURE.md) - Architecture overview
- [MCP ABAP ADT Usage](../contributors/MCP_ABAP_ADT_USAGE.md) - Library usage guide
- [Code Sharing Policy](../contributors/CODE_SHARING_POLICY.md) - Duplication policy

---

## 📝 Notes

### Known Issues

- None identified yet

### Performance Impact

- Expected: Reduced memory usage (lazy AuthBroker)
- Expected: Faster startup (no session storage by default)
- Expected: No performance degradation

### Breaking Changes Summary

1. URL cleaning removed (verify URLs are clean)
2. Session storage disabled by default (enable if needed)
3. AuthBroker lazy initialization (automatic, no changes needed)

---

**Author:** AI Assistant  
**Last Updated:** December 2025  
**Version:** 1.0

