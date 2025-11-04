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

