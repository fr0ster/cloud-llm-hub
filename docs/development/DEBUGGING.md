# Debugging Guide

## Local Debugging

### VS Code Debugging

1. **Standard Debug Mode**
   - Use the "cds serve" configuration from `.vscode/launch.json`
   - Press F5 or go to Run and Debug → "cds serve"

2. **Debug Mode with Inspector**
   - Use the "cds serve (with debug)" configuration
   - Node.js inspector will be available on port 9229
   - Connect Chrome DevTools to `chrome://inspect`

## Hybrid Debugging (Local Development with Cloud Services)

Hybrid debugging in SAP CAP means running your application locally (`cds watch` or `cds serve`) while connecting to real Cloud Foundry services (XSUAA, Destination, Connectivity) through `default-env.json`. This allows you to test locally with production-like service configurations without deploying to Cloud Foundry.

### Prerequisites

- `default-env.json` file with real Cloud Foundry service credentials
- Access to Cloud Foundry services (XSUAA, Destination, optionally Connectivity)
- VS Code with Node.js debugging support

### Setup Steps

1. **Prepare `default-env.json`**

   Copy service credentials from Cloud Foundry to `default-env.json`:

   ```bash
   # Get service credentials
   cf env cloud-llm-hub-srv > vcap-services.json

   # Or manually copy from cf env output to default-env.json
   ```

   The `default-env.json` should contain:
   - XSUAA service with `tag: ["xsuaa"]`
   - Destination service with `tag: ["destination"]`
   - Connectivity service (optional) with `tag: ["connectivity"]`

2. **Start local development with debug**

   Use the VS Code configuration "cds watch (Hybrid - Local + Cloud Services)" or manually:

   ```bash
   NODE_OPTIONS="--inspect=9229" cds watch --profile production
   ```

   This will:
   - Run locally on `http://localhost:4004`
   - Use real XSUAA for authentication (not mock)
   - Connect to real Destination service
   - Connect to real Connectivity service (if configured)

3. **Connect VS Code Debugger**
   - Open VS Code
   - Go to Run and Debug (Ctrl+Shift+D)
   - Select "cds watch (Hybrid - Local + Cloud Services)"
   - Press F5
   - Set breakpoints in your TypeScript code

4. **Test with real services**
   - Use real XSUAA tokens for authentication
   - Test destination resolution with real destinations
   - Verify on-premise connectivity (if configured)

### Benefits of Hybrid Debugging

- **Fast iteration**: No need to deploy to Cloud Foundry for testing
- **Real services**: Use actual XSUAA, Destination, and Connectivity services
- **Better debugging**: Full VS Code debugger support with breakpoints
- **Cost effective**: No Cloud Foundry instance required for development

### Remote Debugging (Cloud Foundry Application)

If you need to debug the actual deployed Cloud Foundry application (not hybrid):

#### Enable SSH for Cloud Foundry app

```bash
cf enable-ssh cloud-llm-hub-srv
cf set-env cloud-llm-hub-srv NODE_OPTIONS "--inspect=0.0.0.0:9229"
cf restage cloud-llm-hub-srv
```

#### Create SSH tunnel

```bash
cf ssh cloud-llm-hub-srv -N -T -L 9229:127.0.0.1:9229
```

#### Connect VS Code

Use "Attach to Cloud Foundry (via SSH tunnel)" configuration.

**Note:** Only enable remote debugging in development/test environments. Never enable in production!

## Troubleshooting

### Inspector not connecting

1. Check firewall rules - port 9229 must be accessible
2. Verify `NODE_OPTIONS` environment variable is set correctly
3. Check application logs: `cf logs cloud-llm-hub-srv --recent`
4. Ensure SSH tunnel is active and forwarding correctly

### Source maps not working

1. Ensure `cds build --production` generates source maps
2. Verify `tsconfig.json` has `"sourceMap": true`
3. Check that `remoteRoot` in launch.json matches CF app path: `/home/vcap/app`

### Breakpoints not hitting

1. Verify source maps are enabled and generated
2. Check that file paths match between local and remote
3. Try using `debugger;` statements instead of breakpoints
4. Check that TypeScript files are compiled correctly

## MCP-Specific Debugging

For debugging MCP server internals:

```bash
# Set MCP debug flags
export MCP_DEBUG=true
export DEBUG=mcp-abap-adt:*

# Run with inspector
NODE_OPTIONS="--inspect=9229" cds watch
```

## Logging

### CAP Logging

CAP uses standard logging levels. Set via environment:

```bash
export CDS_LOG_LEVEL=debug
cds watch
```

### MCP Logging

MCP submodule uses its own logger:

```bash
export DEBUG=mcp-abap-adt:*
```

### Application Logs in Cloud Foundry

```bash
# Stream logs
cf logs cloud-llm-hub-srv --recent

# Tail logs
cf logs cloud-llm-hub-srv
```
