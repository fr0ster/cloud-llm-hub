/**
 * MCP Manager - Embedded MCP server instance
 * Runs mcp-abap-adt directly in the CAP process
 */

import cds from '@sap/cds';
// @ts-ignore - ESM import path with .js extension
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';

// Set env to skip auto-start, we'll manage it manually
process.env.MCP_SKIP_AUTO_START = 'true';

// Import MCP server class
// @ts-ignore - no types in mcp-abap-adt
import { mcp_abap_adt_server } from '../submodules/mcp-abap-adt/dist/index.js';

let mcpServerInstance: any | null = null;
let streamTransport: StreamableHTTPServerTransport | null = null;
let isStarting = false;

/**
 * Get or create MCP server instance with transport
 */
export async function getMCPServer(): Promise<{ server: any; transport: StreamableHTTPServerTransport }> {
  const log = cds.log('mcp-manager');

  if (mcpServerInstance && streamTransport) {
    return { server: mcpServerInstance, transport: streamTransport };
  }

  if (isStarting) {
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 100));
    return getMCPServer();
  }

  isStarting = true;
  
  try {
    log.info('Starting embedded MCP server...');
    
    // Create MCP server instance (handlers setup happens in constructor)
    mcpServerInstance = new mcp_abap_adt_server();
    
    // Create streamable HTTP transport with options
    streamTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false,
      allowedOrigins: undefined,
      allowedHosts: undefined,
      enableDnsRebindingProtection: false
    });
    
    // Connect transport to MCP server
    await mcpServerInstance.server.connect(streamTransport);
    
    log.info('Embedded MCP server started with streamable HTTP transport');
    isStarting = false;
    
    return { server: mcpServerInstance, transport: streamTransport };
  } catch (err: any) {
    log.error('Failed to start MCP server', err);
    isStarting = false;
    throw err;
  }
}

/**
 * Stop MCP server
 */
export async function stopMCPServer(): Promise<void> {
  const log = cds.log('mcp-manager');
  
  if (!mcpServerInstance) {
    return;
  }

  try {
    log.info('Stopping embedded MCP server...');
    // MCP server doesn't have explicit stop method, just cleanup
    mcpServerInstance = null;
    log.info('Embedded MCP server stopped');
  } catch (err: any) {
    log.error('Error stopping MCP server', err);
  }
}

// Initialize on CAP bootstrap
cds.on('bootstrap', async () => {
  const log = cds.log('mcp-manager');
  log.info('Initializing embedded MCP server on bootstrap');
  await getMCPServer();
});

// Cleanup on shutdown
process.on('SIGTERM', stopMCPServer);
process.on('SIGINT', stopMCPServer);
