/**
 * Environment setup for cloud-llm-hub
 * This file MUST be imported BEFORE any imports from @fr0ster/mcp-abap-adt
 * to ensure MCP_SKIP_ENV_LOAD is set before the submodule executes its .env loading logic
 *
 * NOTE: cloud-llm-hub always gets SAP configuration from HTTP headers (X-SAP-Destination
 * or X-SAP-URL, X-SAP-JWT-TOKEN, etc.), not from .env files. The .env file is only needed
 * when running mcp-abap-adt standalone (not through cloud-llm-hub).
 *
 * LLM provider API keys configuration:
 * - Local development: Load from .env file (if exists)
 *   IMPORTANT: The .env file in project root is the same as the agent's .env file.
 *   Create .env in project root for proxy configuration.
 * - BTP deployment: Use environment variables set during deployment (via mta.yaml or CF CLI)
 * - Runtime: Can be overridden via HTTP headers (X-OpenAI-API-Key, etc.)
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

// Load .env file for LOCAL development only (not in BTP/Cloud Foundry)
// In BTP, environment variables are set via deployment configuration
const isLocal = !process.env.VCAP_APPLICATION && !process.env.CF_INSTANCE_INDEX;
if (isLocal) {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    config({ path: envPath });
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[env-setup] Loaded LLM configuration from .env file: ${envPath}`,
      );
    }
  }

  // Load VCAP_SERVICES from default-env.json for hybrid development
  // SAP AI SDK and Cloud SDK need VCAP_SERVICES in process.env
  if (!process.env.VCAP_SERVICES) {
    const defaultEnvPath = resolve(process.cwd(), 'default-env.json');
    if (existsSync(defaultEnvPath)) {
      try {
        const defaultEnv = JSON.parse(
          require('node:fs').readFileSync(defaultEnvPath, 'utf-8'),
        );
        if (defaultEnv.VCAP_SERVICES) {
          process.env.VCAP_SERVICES = JSON.stringify(
            defaultEnv.VCAP_SERVICES,
          );
          if (process.env.NODE_ENV !== 'production') {
            const services = Object.keys(defaultEnv.VCAP_SERVICES);
            console.log(
              `[env-setup] Loaded VCAP_SERVICES from default-env.json: ${services.join(', ')}`,
            );
          }
        }
      } catch (err) {
        console.warn('[env-setup] Failed to load default-env.json:', err);
      }
    }
  }
}

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
