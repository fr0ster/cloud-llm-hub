# Migration Guide

**Version:** 1.0.0  
**Last Updated:** 2025-11-05

Guide for upgrading between versions of Cloud LLM Hub.

## 📋 Table of Contents

- [General Upgrade Instructions](#general-upgrade-instructions)
- [Version-Specific Migrations](#version-specific-migrations)
- [Breaking Changes](#breaking-changes)
- [Configuration Changes](#configuration-changes)
- [Deprecation Notices](#deprecation-notices)

---

## 🚀 General Upgrade Instructions

### Before Upgrading

1. **Backup Current Configuration:**
   ```bash
   # Backup service configurations
   cf service cloud-llm-hub-auth > backups/xsuaa-config.json
   cf service-key cloud-llm-hub-auth mcp > backups/xsuaa-key.json
   cf service cloud-llm-hub-destination > backups/destination-config.json
   
   # Backup MTA configuration
   cp mta.yaml backups/mta.yaml.backup
   cp xs-security.json backups/xs-security.json.backup
   ```

2. **Review Release Notes:**
   - Check `CHANGELOG.md` for breaking changes
   - Review this migration guide
   - Check GitHub releases for version-specific notes

3. **Test in Development:**
   - Deploy to development environment first
   - Test all endpoints
   - Verify service bindings
   - Check authentication flow

### Upgrade Process

1. **Pull Latest Changes:**
   ```bash
   git pull origin main
   git checkout v1.0.0  # or latest version
   ```

2. **Update Dependencies:**
   ```bash
   npm install
   cd submodules/mcp-abap-adt && npm install && npm run build && cd ../..
   ```

3. **Rebuild:**
   ```bash
   npm run copy:mcp-submodule
   npx cds build --production
   mbt build
   ```

4. **Deploy:**
   ```bash
   cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar
   ```

5. **Verify:**
   ```bash
   # Check health
   curl -H "Authorization: Bearer $TOKEN" \
        https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)
   
   # Check logs
   cf logs cloud-llm-hub-srv --recent
   ```

### Rollback Procedure

If issues occur after upgrade:

1. **Redeploy Previous Version:**
   ```bash
   cf deploy backups/cloud-llm-hub_0.2.0.mtar
   ```

2. **Verify Rollback:**
   ```bash
   # Check health
   # Test endpoints
   # Monitor logs
   ```

---

## 📦 Version-Specific Migrations

### Upgrading from 0.2.0 to 1.0.0

#### Breaking Changes

**1. Scripts Reorganization**
- **Old:** Scripts in `scripts/` directory
- **New:** Scripts moved to `tools/` (utilities) and `test/` (testing)
- **Action Required:**
  ```bash
  # Update any scripts that reference old paths
  # Old: scripts/update-cline-connection.js
  # New: tools/update-cline-connection.js
  ```

**2. Test Command Changes**
- **Old:** `npm run test:smoke` or `npm run test:btp`
- **New:** `npm test` (YAML-driven integration tests)
- **Action Required:**
  ```bash
  # Copy test template
  cp test/integration.yaml.template test/integration.yaml
  # Configure test/integration.yaml with your values
  ```

**3. Update Script Consolidation**
- **Old:** Multiple scripts (`update-cline-connection.js`, `update-cline-from-yaml.js`)
- **New:** Single unified script `tools/update-cline-connection.js` with CLI and YAML modes
- **Action Required:**
  ```bash
  # Old YAML usage (if you had it):
  # node scripts/update-cline-from-yaml.js --config config.yaml
  
  # New unified usage:
  node tools/update-cline-connection.js --config config.yaml
  ```

#### Configuration Changes

**1. XSUAA Scopes**
- No changes to scopes
- Existing role collections remain valid

**2. Destination Configuration**
- No changes to destination structure
- Existing destinations continue to work

**3. MTA Configuration**
- `mta.yaml` structure unchanged
- Build hooks updated (new path: `tools/copy-mcp-submodule.js`)

#### Migration Steps

1. **Update Script References:**
   ```bash
   # Find and update any scripts/custom tools that reference old paths
   grep -r "scripts/" . --exclude-dir=node_modules --exclude-dir=.git
   ```

2. **Update Test Configuration:**
   ```bash
   # Create new integration test config
   cp test/integration.yaml.template test/integration.yaml
   # Fill in your values
   ```

3. **Update CI/CD Scripts:**
   ```bash
   # Update any CI/CD scripts that use old paths
   # Update GitHub Actions, GitLab CI, etc.
   ```

4. **Rebuild and Deploy:**
   ```bash
   npm install
   npm run copy:mcp-submodule
   npx cds build --production
   mbt build
   cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar
   ```

---

### Upgrading from 0.1.0 to 1.0.0

#### Major Changes

**1. Authentication System**
- **Old:** Basic `proxyAccess` scope
- **New:** MCP-specific scopes (`MCP_Connect`, `MCP_Read`, `MCP_Admin`)
- **Action Required:**
  ```bash
  # Update xs-security.json
  # Update role collections in BTP Cockpit
  # Reassign users to new role collections
  ```

**2. Endpoint Changes**
- **Old:** `/mcp/Health` (CAP endpoint)
- **New:** `/odata/v4/mcp/Health()` (CAP function)
- **Action Required:**
  ```bash
  # Update any client code that calls health endpoint
  # Old: GET /mcp/Health
  # New: GET /odata/v4/mcp/Health()
  ```

**3. Streaming Endpoints**
- **Old:** Not available
- **New:** `/mcp/stream/sse` and `/mcp/stream/http`
- **Action Required:**
  - Update clients to use new streaming endpoints
  - Review [MCP_PROXY_USAGE.md](MCP_PROXY_USAGE.md) for usage

#### Migration Steps

1. **Update Security Configuration:**
   ```bash
   # Backup old xs-security.json
   cp xs-security.json backups/xs-security.json.0.1.0
   
   # Update to new version
   git checkout v1.0.0 xs-security.json
   
   # Update XSUAA service
   cf update-service cloud-llm-hub-auth -c xs-security.json
   ```

2. **Update Role Collections:**
   - In BTP Cockpit: Go to Security → Role Collections
   - Create `MCP_Connector` role collection
   - Create `MCP_Admin` role collection
   - Assign users to new role collections

3. **Update Client Code:**
   ```bash
   # Update health endpoint calls
   # Old: GET /mcp/Health
   # New: GET /odata/v4/mcp/Health()
   ```

4. **Deploy:**
   ```bash
   cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar
   ```

---

## ⚠️ Breaking Changes

### Current Version (1.0.0)

No breaking changes from 0.2.0 (only organizational changes).

### Future Versions

Breaking changes will be documented here as they occur.

**Planned for v2.0:**
- TBD (will be documented when v2.0 is planned)

---

## 🔧 Configuration Changes

### Service Bindings

**No Changes Required:**
- XSUAA service binding remains the same
- Destination service binding remains the same
- Connectivity service binding remains the same

### Environment Variables

**No Changes:**
- All environment variables remain the same
- No new required environment variables

### MTA Configuration

**Build Hooks Updated:**
```yaml
# Old path (0.2.0 and earlier)
- node scripts/copy-mcp-submodule.js

# New path (1.0.0+)
- node tools/copy-mcp-submodule.js
```

**Action:** If you customized `mta.yaml`, update the path.

---

## 📝 Deprecation Notices

### Deprecated in 1.0.0

**1. Legacy Test Scripts**
- `scripts/test-cap-endpoints.sh` - Deprecated
- `scripts/test-cap-btp.sh` - Deprecated
- **Replacement:** Use `npm test` with YAML configuration

**2. Separate Update Scripts**
- `scripts/update-cline-from-yaml.js` - Deprecated
- **Replacement:** Use unified `tools/update-cline-connection.js` with `--config` flag

### Removal Timeline

- **1.0.0:** Deprecated features marked
- **1.1.0:** Deprecated features may be removed (TBD)
- **2.0.0:** Deprecated features will be removed

---

## 🔍 Troubleshooting Upgrades

### Common Issues

#### Issue: Service Binding Errors

**Symptoms:**
- Service bindings fail after upgrade
- "Service not found" errors

**Solution:**
```bash
# Verify services exist
cf services

# Rebind if needed
cf bind-service cloud-llm-hub-srv cloud-llm-hub-auth
cf restage cloud-llm-hub-srv
```

#### Issue: Authentication Failures

**Symptoms:**
- 401 Unauthorized errors
- Token validation fails

**Solution:**
```bash
# Update XSUAA service with new xs-security.json
cf update-service cloud-llm-hub-auth -c xs-security.json
cf restage cloud-llm-hub-srv

# Verify role collections
# In BTP Cockpit: Security → Role Collections
```

#### Issue: Script Path Errors

**Symptoms:**
- "Script not found" errors
- Build failures

**Solution:**
```bash
# Verify new paths
ls -la tools/copy-mcp-submodule.js
ls -la test/test-cap-from-yaml.js

# Update mta.yaml if you customized it
```

---

## 📚 Additional Resources

- [Deployment Checklist](DEPLOYMENT_CHECKLIST.md) - Deployment procedures
- [Troubleshooting Guide](TROUBLESHOOTING.md) - Common issues
- [CHANGELOG.md](../CHANGELOG.md) - Detailed change log
- [Operations Guide](OPERATIONS.md) - Production operations

---

## 🆘 Getting Help

If you encounter issues during migration:

1. **Check Documentation:**
   - Review this guide
   - Check [Troubleshooting Guide](TROUBLESHOOTING.md)
   - Review [CHANGELOG.md](../CHANGELOG.md)

2. **Search Issues:**
   - Check GitHub Issues for similar problems
   - Search closed issues for solutions

3. **Report Issues:**
   - Create a new issue with migration details
   - Include version numbers and error messages

---

**Last Updated:** 2025-11-05  
**Current Version:** 1.0.0  
**Next Version:** TBD

