# Cross-Platform Development Guide

## Overview

This project is configured to ensure consistent behavior across different operating systems (Linux, macOS, Windows). This document explains the configuration and best practices.

## Configuration Files

### `.npmrc`
Both root project and submodules (`mcp-abap-adt`) have identical `.npmrc` files that ensure:
- Consistent `package-lock.json` generation across all OS
- Legacy peer dependencies mode to prevent `peer: true` appearing on Windows
- Disabled audit and fund messages for cleaner output
- Error-only logging to reduce noise

**Key settings:**
```properties
legacy-peer-deps=true
strict-peer-deps=false
auto-install-peers=false
package-lock=true
install-strategy=nested
prefer-dedupe=false
```

These settings prevent:
- `peer: true` appearing on Windows
- Hoisting differences that cause `node_modules/@sap/cds-dk/node_modules/@eslint/js` to appear/disappear
- Inconsistent package-lock.json across operating systems

### `.editorconfig`
Ensures consistent code formatting:
- LF line endings (Unix-style) on all platforms
- UTF-8 encoding
- Consistent indentation (2 spaces)
- Trailing whitespace removal

Present in: root, `mcp-abap-adt`

### `.gitattributes`
Enforces consistent line endings in Git:
- All text files use LF endings
- `package-lock.json` explicitly set to LF
- Binary files marked correctly

Present in: root, `mcp-abap-adt`

### `tsconfig.json`
All projects have:
- `forceConsistentCasingInFileNames: true` - ensures case-sensitive file imports work on all OS

Present in: root, `mcp-abap-adt`

## Best Practices

### For Windows Developers

1. **Git Configuration:**
   ```bash
   # Configure Git to use LF line endings
   git config --global core.autocrlf input
   git config --global core.eol lf
   ```

2. **Before First Build:**
   ```bash
   # Re-normalize line endings if you cloned before setting up Git
   git rm -rf --cached .
   git reset --hard HEAD
   ```

3. **NPM Commands:**
   - Always run `npm install` and `npm run build` with the existing `.npmrc` in place
   - Do not modify `.npmrc` settings
   - If you see `peer: true` in `package-lock.json`, something is wrong with your `.npmrc`

### For Linux/macOS Developers

1. **Git Configuration:**
   ```bash
   # These are typically default, but ensure consistency
   git config --global core.autocrlf input
   git config --global core.eol lf
   ```

2. **Verification:**
   - Line endings should already be correct
   - No special setup needed beyond git config

### For All Developers

1. **Editor Setup:**
   - Install EditorConfig plugin for your editor/IDE
   - VS Code: `editorconfig.editorconfig` extension
   - JetBrains IDEs: built-in support
   - Vim/Neovim: `editorconfig/editorconfig-vim`

2. **Before Committing:**
   ```bash
   # Verify no CRLF line endings
   git diff --check
   
   # Check package-lock.json hasn't changed unexpectedly
   git diff package-lock.json
   ```

3. **Testing Builds:**
   ```bash
   # In root (CAP project)
   cds build
   
   # LLM proxy is installed from npm
   npm install @mcp-abap-adt/llm-proxy
   
   # In submodules/mcp-abap-adt
   cd submodules/mcp-abap-adt
   npm run build
   cd ../..

   # Verify no changes to package-lock.json
   git status
   ```

## Troubleshooting

### `peer: true` appears in `package-lock.json` on Windows

**Cause:** `.npmrc` is missing or has wrong settings

**Solution:**
1. Verify `.npmrc` exists in root and `submodules/mcp-abap-adt/`
2. Verify `legacy-peer-deps=true` is set in all `.npmrc` files
3. Delete `node_modules` and `package-lock.json` in affected directories
4. Run `npm install` again

### Line ending issues

**Cause:** Git autocrlf settings or missing `.gitattributes`

**Solution:**
```bash
# Fix Git config
git config core.autocrlf input
git config core.eol lf

# Re-checkout files
git rm -rf --cached .
git reset --hard HEAD
```

### Different `package-lock.json` on different OS

**Cause:** Missing or different `.npmrc` settings, or npm hoisting differences

**Solution:**
1. Ensure `.npmrc` is identical in all projects (root, mcp-abap-adt)
2. Verify `install-strategy=nested` is set (prevents hoisting differences)
3. Use same npm version (>=9.0.0)
4. Use same Node.js version (>=18.0.0)
5. Check `engines` field in all `package.json` files
6. Delete `node_modules` and `package-lock.json`, then run `npm install`

**Common issue:** `@eslint/js` appearing in nested `node_modules` paths
- This happens when npm's hoisting algorithm behaves differently on Windows vs Unix
- `install-strategy=nested` forces consistent structure

## CI/CD Considerations

- CI runners should use Linux with standard line endings (LF)
- All configuration files are committed to repository
- No special setup needed for CI environments
- `.npmrc` ensures consistent npm behavior in pipelines

## Version Requirements

All projects require:
- Node.js >= 18.0.0
- npm >= 9.0.0

These are enforced in `package.json` `engines` field for: root, `llm-agent`, `mcp-abap-adt`

## Verification Script

To verify your setup is correct:

```bash
# Run the automated verification
npm run verify:setup
```

The script checks:
- Configuration files existence (.npmrc, .editorconfig, .gitattributes)
- Git settings (core.autocrlf, core.eol)
- Line endings in source files
- package-lock.json for `peer: true` entries
- Deeply nested node_modules that may differ across platforms
- Node.js and npm versions

Manual checks (if needed):
```bash
# Check Git settings
git config --get core.autocrlf  # Should be: input
git config --get core.eol       # Should be: lf

# Check for CRLF
find . -name "*.ts" -o -name "*.js" -o -name "*.json" | xargs file | grep CRLF

# Check package-lock.json
grep -n "peer.*true" package-lock.json
```
