/**
 * Environment setup for cloud-llm-hub
 * This file MUST be imported BEFORE any imports from @fr0ster/mcp-abap-adt
 * to ensure MCP_SKIP_ENV_LOAD is set before the submodule executes its .env loading logic
 * 
 * NOTE: cloud-llm-hub always gets SAP configuration from HTTP headers (X-SAP-Destination
 * or X-SAP-URL, X-SAP-JWT-TOKEN, etc.), not from .env files. The .env file is only needed
 * when running mcp-abap-adt standalone (not through cloud-llm-hub).
 */

// Set BEFORE any imports that might load the submodule
// These flags prevent the submodule from auto-loading .env files
// All SAP configuration is passed via headers -> extractSapContext -> serverOptions.sapConfig
process.env.MCP_SKIP_AUTO_START = 'true';
process.env.MCP_SKIP_ENV_LOAD = 'true';
process.env.TLS_REJECT_UNAUTHORIZED = '0';

/**
 * Session Storage Configuration
 * 
 * MCP_ENABLE_SESSION_STORAGE: Enable persistent session storage (default: false)
 *   - When false (default): Stateless mode - sessions are not persisted to disk
 *   - When true: Stateful mode - sessions are stored in MCP_SESSION_DIR
 * 
 * MCP_SESSION_DIR: Directory for session storage files (default: ./sessions)
 *   - Only used when MCP_ENABLE_SESSION_STORAGE=true
 *   - Sessions are stored as JSON files: <session-id>.json
 * 
 * Default behavior for cloud-llm-hub:
 *   - Stateless mode (no session persistence)
 *   - Session state is maintained in memory during request lifecycle
 *   - Each request gets fresh authentication via BTP Destination Service
 */
if (!process.env.MCP_ENABLE_SESSION_STORAGE) {
  process.env.MCP_ENABLE_SESSION_STORAGE = 'false';
}

if (!process.env.MCP_SESSION_DIR) {
  process.env.MCP_SESSION_DIR = './sessions';
}
