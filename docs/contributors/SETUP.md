# Development Setup Guide

Complete guide for setting up a development environment for Cloud LLM Hub.

## 📋 Prerequisites

### Required

- **Node.js** 18+ ([Download](https://nodejs.org/))
- **npm** (comes with Node.js)
- **Git** ([Download](https://git-scm.com/))
- **Code editor** (VS Code recommended)

### Optional (for deployment testing)

- **SAP BTP account** with Cloud Foundry access
- **CF CLI** ([Install](https://docs.cloudfoundry.org/cf-cli/install-go-cli.html))
- **MTA Build Tool** (`npm install -g mbt`)

### SAP System Access (Optional)

- Access to SAP ABAP system (for testing)
- SAP Cloud Connector (for on-premise testing)

## 🚀 Initial Setup

### 1. Fork and Clone

```bash
# Fork the repository on GitHub first, then:
git clone https://github.com/YOUR_USERNAME/cloud-llm-hub.git
cd cloud-llm-hub

# Add upstream remote
git remote add upstream https://github.com/fr0ster/cloud-llm-hub.git
```

### 2. Install Dependencies

```bash
# Install root dependencies
npm install

# Initialize and update git submodules
git submodule update --init --recursive

# Install submodule dependencies
cd submodules/mcp-abap-adt
npm install
cd ../..
```

### 3. Build Submodules

The `mcp-abap-adt` submodule needs to be built:

```bash
# Build the submodule
cd submodules/mcp-abap-adt
npm run build
cd ../..
```

### 4. Verify Setup

```bash
# Type check
npm exec -- tsc --noEmit

# Check Node.js version
node -v  # Should be 18+

# Check npm version
npm -v
```

## 🛠️ Development Environment

### Local Development Server

Start the CAP development server:

```bash
cds watch --profile development
```

The server will start on `http://localhost:4004` with:

- Mock authentication (users: `alice`, `bob`)
- Hot reload on file changes
- Development profile enabled

### Environment Variables

Create `.env` file (optional, for local testing):

```env
# SAP System (for direct mode testing)
SAP_URL=https://your-sap-system.com
SAP_CLIENT=200
SAP_JWT_TOKEN=your-jwt-token

# MCP Configuration
MCP_ENDPOINT=http://localhost:4004/mcp/stream/http
```

### Local Authentication

Development mode uses mocked authentication:

- **User:** `alice` (password: empty)
  - Roles: `MCP_Connector`, `MCP_Admin`
- **User:** `bob` (password: empty)
  - Roles: `MCP_Connector`

**Test authentication:**

```bash
# Basic auth (Base64 encoded "alice:")
curl -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/odata/v4/mcp/Health\(\)
```

## 📁 Project Structure

```
cloud-llm-hub/
├── srv/                    # Service implementation
│   ├── mcp-proxy.ts       # MCP proxy endpoints
│   ├── mcp-manager.ts     # MCP server lifecycle
│   ├── connections/       # Connection handlers
│   └── server.ts          # CAP server setup
├── tools/                  # Utility scripts
│   ├── update-cline-connection.js
│   ├── copy-mcp-submodule.js
│   └── update-default-env.js
├── test/                   # Test scripts
│   ├── test-cap-from-yaml.js
│   └── smoke/             # Smoke tests
├── docs/                   # Documentation
│   └── contributors/      # Contributor guides
├── submodules/             # Git submodules
│   └── mcp-abap-adt/      # ABAP MCP server
├── app/                    # Approuter (SAP BTP)
├── db/                     # CAP data models (reserved)
└── mta.yaml                # MTA deployment descriptor
```

## 🧪 Testing Setup

### Integration Tests

1. **Copy test template:**

   ```bash
   cp test/integration.yaml.template test/integration.yaml
   ```

2. **Configure test settings:**
   Edit `test/integration.yaml` with your values:

   ```yaml
   baseUrl: http://localhost:4004
   auth:
     header: 'Basic YWxpY2U6' # alice (mocked dev)
   ```

3. **Run tests:**
   ```bash
   npm test
   ```

### Smoke Tests

Manual smoke tests in `test/smoke/`:

```bash
cd test/smoke
./run-all.sh
```

### Type Checking

```bash
npm exec -- tsc --noEmit
```

## 🏗️ Build Process

### Local Build

```bash
# Build CAP service
npx cds build --production

# Build submodule
cd submodules/mcp-abap-adt
npm run build
cd ../..

# Copy submodule to gen/srv
node tools/copy-mcp-submodule.js
```

### MTA Build (for deployment)

```bash
# Install MTA Build Tool (if not installed)
npm install -g mbt

# Build MTA archive
mbt build

# Output: mta_archives/cloud-llm-hub_1.0.0.mtar
```

## 🔧 Common Tasks

### Update Submodule

```bash
# Update submodule to latest
cd submodules/mcp-abap-adt
git pull origin main
npm install
npm run build
cd ../..
```

### Reset Development Environment

```bash
# Clean build artifacts
rm -rf gen/ dist/ node_modules/

# Reinstall
npm install
cd submodules/mcp-abap-adt && npm install && npm run build && cd ../..
```

### Sync with Upstream

```bash
# Fetch upstream changes
git fetch upstream

# Merge upstream/main into your branch
git checkout main
git merge upstream/main

# Push to your fork
git push origin main
```

## 🐛 Troubleshooting

### Port Already in Use

```bash
# Find process using port 4004
lsof -i :4004
# or (Linux)
netstat -tulpn | grep 4004

# Kill process
kill -9 <PID>
```

### Submodule Issues

```bash
# Reinitialize submodules
git submodule deinit --all
git submodule update --init --recursive
```

### Node Version Issues

Use `nvm` (Node Version Manager) to switch versions:

```bash
# Install nvm (if not installed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Use Node.js 18+
nvm install 18
nvm use 18
```

### TypeScript Errors

```bash
# Clean and rebuild
rm -rf dist/ node_modules/@types
npm install
npm exec -- tsc --noEmit
```

## 📚 Next Steps

- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Workflow:** [WORKFLOW.md](WORKFLOW.md)
- **Code Style:** [CODE_STYLE.md](CODE_STYLE.md)
- **Testing:** [TESTING.md](TESTING.md)

## 💡 Tips

- Use VS Code with TypeScript extension for better development experience
- Enable `cds watch` for hot reload during development
- Check `docs/DEBUGGING.md` for debugging tips
- Use `npm run update:env` to sync local `default-env.json` from deployed app

---

**Questions?** Open an issue or check other contributor guides!
