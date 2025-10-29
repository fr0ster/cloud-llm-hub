"use strict";
/**
 * MCP Manager - Embedded MCP server instance
 * Runs mcp-abap-adt directly in the CAP process
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMCPServer = getMCPServer;
exports.stopMCPServer = stopMCPServer;
const cds_1 = __importDefault(require("@sap/cds"));
// @ts-ignore - ESM import path with .js extension
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const crypto_1 = require("crypto");
// Set env to skip auto-start, we'll manage it manually
process.env.MCP_SKIP_AUTO_START = 'true';
// Import MCP server class
// @ts-ignore - no types in mcp-abap-adt
const index_js_1 = require("../submodules/mcp-abap-adt/dist/index.js");
let mcpServerInstance = null;
let streamTransport = null;
let isStarting = false;
/**
 * Get or create MCP server instance with transport
 */
async function getMCPServer() {
    const log = cds_1.default.log('mcp-manager');
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
        mcpServerInstance = new index_js_1.mcp_abap_adt_server();
        // Create streamable HTTP transport with options
        streamTransport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: () => (0, crypto_1.randomUUID)(),
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
    }
    catch (err) {
        log.error('Failed to start MCP server', err);
        isStarting = false;
        throw err;
    }
}
/**
 * Stop MCP server
 */
async function stopMCPServer() {
    const log = cds_1.default.log('mcp-manager');
    if (!mcpServerInstance) {
        return;
    }
    try {
        log.info('Stopping embedded MCP server...');
        // MCP server doesn't have explicit stop method, just cleanup
        mcpServerInstance = null;
        log.info('Embedded MCP server stopped');
    }
    catch (err) {
        log.error('Error stopping MCP server', err);
    }
}
// Initialize on CAP bootstrap
cds_1.default.on('bootstrap', async () => {
    const log = cds_1.default.log('mcp-manager');
    log.info('Initializing embedded MCP server on bootstrap');
    await getMCPServer();
});
// Cleanup on shutdown
process.on('SIGTERM', stopMCPServer);
process.on('SIGINT', stopMCPServer);
//# sourceMappingURL=mcp-manager.js.map