# Windows Setup Instructions

## First-Time Setup

After cloning the repository on Windows, follow these steps to ensure consistent behavior:

### 1. Configure Git (One-time setup)

```powershell
# Configure line endings
git config --global core.autocrlf input
git config --global core.eol lf

# Refresh repository to apply line ending settings
git rm -rf --cached .
git reset --hard HEAD
```

### 2. Verify Configuration

```powershell
# Run verification script
npm run verify:setup
```

This will check:
- ✓ All configuration files are present
- ✓ Git is configured correctly
- ✓ No CRLF line endings
- ✓ No `peer: true` in package-lock.json
- ✓ Consistent node_modules structure

### 3. Install Dependencies

```powershell
# Root project
npm install

# Submodule (if needed separately)
cd submodules\llm-agent
npm install
cd ..\..
```

## Common Issues

### Issue: `peer: true` appears in package-lock.json after `npm install`

**Cause:** `.npmrc` is missing or has incorrect settings

**Solution:**
1. Verify `.npmrc` exists in root, `submodules/llm-agent/`, and `submodules/mcp-abap-adt/`
2. Run `npm run verify:setup` to check configuration
3. Delete `node_modules` and `package-lock.json` in affected directories
4. Run `npm install` again

### Issue: `@eslint/js` appears/disappears in nested node_modules

**Cause:** Different npm hoisting behavior on Windows vs Linux

**Solution:**
1. Verify `.npmrc` contains `install-strategy=nested`
2. Delete `node_modules` and `package-lock.json`
3. Run `npm install`
4. Verify with `npm run verify:setup`

### Issue: CRLF line endings in committed files

**Cause:** Git not configured for LF line endings

**Solution:**
```powershell
# Fix Git config
git config core.autocrlf input
git config core.eol lf

# Re-checkout files
git rm -rf --cached .
git reset --hard HEAD
```

### Issue: Build differences between Windows and Linux

**Cause:** Missing `.editorconfig` or `.gitattributes`

**Solution:**
1. Run `npm run verify:setup`
2. Check that all config files are present
3. Install EditorConfig plugin for your IDE:
   - VS Code: `editorconfig.editorconfig`
   - Visual Studio: built-in support

## Development Workflow

### Building

```powershell
# Build main project (CAP project)
cds build

# Build llm-agent submodule
cd submodules\llm-agent
npm run build
cd ..\..

# Build mcp-abap-adt submodule
cd submodules\mcp-abap-adt
npm run build
cd ..\..
```

### Running

```powershell
# Start development server
npm start

# Or with cds watch
npm run cds-watch
```

### Before Committing

```powershell
# Verify no unwanted changes
npm run verify:setup

# Check git status
git status

# Verify package-lock.json hasn't changed unexpectedly
git diff package-lock.json
git diff submodules/llm-agent/package-lock.json
git diff submodules/mcp-abap-adt/package-lock.json
```

## PowerShell vs Command Prompt

These instructions work in both PowerShell and Command Prompt. For PowerShell:
- Use `\` for paths (as shown above)
- Commands like `cd`, `npm`, `git` work the same

For Command Prompt (cmd.exe):
- Same commands apply
- Use `\` for paths

## Editor Configuration

### VS Code

Install recommended extensions:
```powershell
code --install-extension editorconfig.editorconfig
```

The workspace should automatically pick up `.editorconfig` settings.

### Visual Studio

EditorConfig is supported out of the box. No additional setup needed.

### JetBrains IDEs (WebStorm, IntelliJ IDEA)

EditorConfig is supported out of the box. Ensure it's enabled in:
Settings → Editor → Code Style → Enable EditorConfig support

## Need Help?

- Run `npm run verify:setup` to diagnose issues
- See [docs/CROSS_PLATFORM_GUIDE.md](CROSS_PLATFORM_GUIDE.md) for detailed troubleshooting
- Check [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) for general issues
