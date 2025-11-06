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
 *   Copy it from agent: cp submodules/llm-agent/.env .env
 * - BTP deployment: Use environment variables set during deployment (via mta.yaml or CF CLI)
 * - Runtime: Can be overridden via HTTP headers (X-OpenAI-API-Key, etc.)
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Load .env file for LOCAL development only (not in BTP/Cloud Foundry)
// In BTP, environment variables are set via deployment configuration
const isLocal = !process.env.VCAP_APPLICATION && !process.env.CF_INSTANCE_INDEX;
if (isLocal) {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    config({ path: envPath });
    // Only log in development mode
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[env-setup] Loaded LLM configuration from .env file: ${envPath}`);
    }
  }
}

// Set BEFORE any imports that might load the submodule
// These flags prevent the submodule from auto-loading .env files
// All SAP configuration is passed via headers -> extractSapContext -> serverOptions.sapConfig
process.env.MCP_SKIP_AUTO_START = 'true';
process.env.MCP_SKIP_ENV_LOAD = 'true';
process.env.TLS_REJECT_UNAUTHORIZED = '0';

