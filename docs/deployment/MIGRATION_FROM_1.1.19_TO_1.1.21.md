# Migration Guide: mcp-abap-adt v1.1.19 → v1.1.21

**Date:** December 2025  
**Version:** 1.0  
**Status:** Current

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Version Summary](#version-summary)
3. [Changes in v1.1.20](#changes-in-v1120)
4. [Changes in v1.1.21](#changes-in-v1121)
5. [Impact Analysis](#impact-analysis)
6. [Migration Steps](#migration-steps)
7. [Testing Checklist](#testing-checklist)
8. [Rollback Plan](#rollback-plan)

---

## 🎯 Overview

This guide helps you migrate `cloud-llm-hub` from `mcp-abap-adt` v1.1.19 to v1.1.21. The migration includes bug fixes, new features, and dependency updates.

### Version Summary

- **From:** mcp-abap-adt v1.1.19
- **To:** mcp-abap-adt v1.1.21
- **cloud-llm-hub:** No breaking changes expected

### Key Changes

1. **v1.1.20:** Documentation improvements in help messages
2. **v1.1.21:** 
   - Fixed `x-mcp-destination` validation
   - Added `--auth-broker-path` command-line option
   - Automatic directory creation
   - Enhanced diagnostic logging
   - Updated dependencies

---

## 📝 Changes in v1.1.20

### Documentation Improvements

**Change:** Updated help messages with detailed instructions for saving service keys

**Details:**
- Added platform-specific instructions for Linux, macOS, and Windows
- Replaced example JSON structure with instructions to copy service key from SAP BTP
- Fixed backslash escaping in Windows PowerShell commands
- Updated both launcher help and server help

**Impact on cloud-llm-hub:**
- ✅ **No code changes needed** - documentation only
- ✅ **No breaking changes**

**Action Required:**
- [ ] Review updated documentation (optional)

---

## 🆕 Changes in v1.1.21

### 1. Fixed x-mcp-destination Validation 🔴 CRITICAL

**Change:** Fixed issue where `x-mcp-destination` header was incorrectly requiring `x-sap-url`

**Before (v1.1.19):**
```typescript
// x-mcp-destination required x-sap-url header
// URL was not automatically derived from service key
```

**After (v1.1.21):**
```typescript
// x-mcp-destination now works identically to x-sap-destination
// URL is automatically derived from service key
// x-sap-url is optional (and ignored with warning if provided)
```

**Impact on cloud-llm-hub:**
- ✅ **Positive:** `x-mcp-destination` now works correctly
- ✅ **No breaking changes** - existing `x-sap-destination` usage unchanged
- ⚠️ **Note:** If cloud-llm-hub uses `x-mcp-destination`, behavior may change (improvement)

**Action Required:**
- [ ] Verify `x-mcp-destination` usage in cloud-llm-hub (if any)
- [ ] Test `x-mcp-destination` header with service keys
- [ ] Remove `x-sap-url` header if using `x-mcp-destination` (optional, but recommended)

### 2. Added --auth-broker-path Option 🟢 NEW FEATURE

**Change:** Added `--auth-broker-path` command-line option for custom service key paths

**Usage:**
```bash
mcp-abap-adt --auth-broker --auth-broker-path=~/prj/tmp/
# Creates: ~/prj/tmp/service-keys/ and ~/prj/tmp/sessions/
```

**Impact on cloud-llm-hub:**
- ✅ **No immediate impact** - cloud-llm-hub doesn't use command-line launcher
- ℹ️ **Future:** Could be useful for custom deployments
- ✅ **No breaking changes**

**Action Required:**
- [ ] Document new option (if relevant for cloud-llm-hub users)
- [ ] No code changes needed

### 3. Automatic Directory Creation 🟢 IMPROVEMENT

**Change:** Service keys and sessions directories are now created automatically

**Before (v1.1.19):**
```typescript
// Directories had to be created manually
// Errors occurred if directories didn't exist
```

**After (v1.1.21):**
```typescript
// Directories created automatically at server startup
// Works for both default and custom paths
```

**Impact on cloud-llm-hub:**
- ✅ **Positive:** Fewer errors during initialization
- ✅ **No breaking changes**

**Action Required:**
- [ ] Test directory creation (should work automatically)
- [ ] No code changes needed

### 4. Enhanced Diagnostic Logging 🟢 IMPROVEMENT

**Change:** Added platform-aware logging for better debugging

**New Logging:**
- Platform information when processing authentication headers
- All header keys that start with `x-sap` or `x-mcp`
- Search paths when creating AuthBroker instances

**Impact on cloud-llm-hub:**
- ✅ **Positive:** Better debugging capabilities
- ✅ **No breaking changes**

**Action Required:**
- [ ] Review logs for new diagnostic information
- [ ] No code changes needed

### 5. Header Validation Improvements 🟡 MINOR

**Change:** Improved validation order and case handling

**Details:**
- `x-mcp-destination` checked immediately after `x-sap-destination`
- Case-insensitive header checking for better compatibility
- Both headers check in both lowercase and original case

**Impact on cloud-llm-hub:**
- ✅ **Positive:** Better header compatibility
- ✅ **No breaking changes**

**Action Required:**
- [ ] Test with various header case combinations
- [ ] No code changes needed

### 6. Updated Dependencies 🔴 CRITICAL

**Change:** Updated package dependencies

**Updated:**
- `@mcp-abap-adt/auth-broker`: `^0.1.2` → `^0.1.3`
- `@mcp-abap-adt/header-validator`: `^0.1.2` → `^0.1.3`

**Impact on cloud-llm-hub:**
- ⚠️ **Must update:** `package.json` dependencies
- ✅ **No breaking changes expected** - patch version updates

**Action Required:**
- [x] Update `package.json` dependencies
- [ ] Run `npm install`
- [ ] Verify no dependency conflicts

---

## 🔍 Impact Analysis

### Breaking Changes

**None identified** - All changes are backward compatible.

### Code Changes Required

**Minimal:**
1. Update `package.json` dependencies
2. Test `x-mcp-destination` if used
3. Review diagnostic logs

### Configuration Changes

**None required** - No configuration changes needed.

### Behavioral Changes

1. **x-mcp-destination:** Now works without `x-sap-url` (improvement)
2. **Directory creation:** Automatic (improvement)
3. **Logging:** More diagnostic information (improvement)

---

## 🔄 Migration Steps

### Step 1: Update Dependencies

**File:** `package.json`

```json
{
  "dependencies": {
    "@mcp-abap-adt/auth-broker": "^0.1.3",
    "@mcp-abap-adt/header-validator": "^0.1.3"
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
- [ ] Run `npm install`
- [ ] Verify `npx cds build` succeeds

### Step 2: Update Submodule (if using git submodule)

**Commands:**
```bash
cd submodules/mcp-abap-adt
git fetch
git checkout v1.1.21
cd ../..
npm install
```

**Action Required:**
- [ ] Update submodule to v1.1.21
- [ ] Verify submodule version

### Step 3: Test x-mcp-destination (if used)

**Test Scenario:**
```bash
# Test with x-mcp-destination header (without x-sap-url)
curl -X POST http://localhost:3000/mcp/stream/http \
  -H "x-mcp-destination: TRIAL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "tools/list", "id": 1}'
```

**Action Required:**
- [ ] Test `x-mcp-destination` header
- [ ] Verify URL is derived from service key automatically
- [ ] Remove `x-sap-url` if previously required

### Step 4: Review Diagnostic Logs

**Check for:**
- Platform information in logs
- Header keys logged (x-sap-*, x-mcp-*)
- Search paths for AuthBroker

**Action Required:**
- [ ] Review logs during startup
- [ ] Verify diagnostic information is helpful
- [ ] No action needed if logs are correct

### Step 5: Test All Connection Types

**Test Scenarios:**
- [ ] Direct Basic auth connection
- [ ] Direct JWT auth connection
- [ ] BTP Destination (Internet) with `x-sap-destination`
- [ ] BTP Destination (Internet) with `x-mcp-destination` (if used)
- [ ] BTP Destination (On-Premise)
- [ ] Error handling with invalid headers

**Action Required:**
- [ ] Run full test suite
- [ ] Test all connection types
- [ ] Verify no regressions

---

## ✅ Testing Checklist

### Unit Tests

- [ ] Header validation with `x-sap-destination`
- [ ] Header validation with `x-mcp-destination` (without `x-sap-url`)
- [ ] Case-insensitive header checking
- [ ] Directory creation (automatic)

### Integration Tests

- [ ] Direct Basic auth connection
- [ ] Direct JWT auth connection
- [ ] BTP Destination with `x-sap-destination`
- [ ] BTP Destination with `x-mcp-destination`
- [ ] Multiple concurrent requests
- [ ] Error scenarios

### End-to-End Tests

- [ ] Full MCP request flow (Direct)
- [ ] Full MCP request flow (Destination)
- [ ] Diagnostic logging output
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
   git checkout HEAD~1 package.json package-lock.json
   npm install
   ```

2. **Revert Submodule:**
   ```bash
   cd submodules/mcp-abap-adt
   git checkout v1.1.19
   cd ../..
   npm install
   ```

3. **Verify:**
   ```bash
   npm run build
   npm start
   ```

### Rollback Checklist

- [ ] Revert `package.json` to previous version
- [ ] Revert submodule to v1.1.19 (if needed)
- [ ] Run tests to verify rollback
- [ ] Document issues encountered

---

## 📊 Migration Status

### ✅ Completed

- [x] Analyze changes in v1.1.20 and v1.1.21
- [x] Create migration guide
- [ ] Update dependencies in `package.json`

### 🟡 In Progress

- [ ] Update submodule to v1.1.21
- [ ] Run test suite
- [ ] Performance validation

### 📋 Pending

- [ ] Production deployment
- [ ] Monitoring setup
- [ ] User communication (if needed)

---

## 🔍 Related Documentation

- [Migration from 1.1.17 to 1.1.19](MIGRATION_FROM_1.1.17_TO_1.1.19.md) - Previous migration guide
- [MCP ABAP ADT Integration](../contributors/MCP_ABAP_ADT_INTEGRATION.md) - Integration roadmap
- [Integration Architecture](../architecture/INTEGRATION_ARCHITECTURE.md) - Architecture overview

---

## 📝 Notes

### Known Issues

- None identified

### Performance Impact

- Expected: No performance degradation
- Expected: Slightly faster startup (automatic directory creation)

### Breaking Changes Summary

**None** - All changes are backward compatible.

### Key Improvements

1. **x-mcp-destination:** Now works correctly without `x-sap-url`
2. **Directory creation:** Automatic, no manual setup needed
3. **Logging:** Better diagnostic information
4. **Header validation:** Improved case handling

---

**Author:** AI Assistant  
**Last Updated:** December 2025  
**Version:** 1.0

