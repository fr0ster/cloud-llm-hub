"use strict";
/**
 * MCP Manager - Embedded MCP server instance
 * Runs mcp-abap-adt directly in the CAP process
 * Creates per-request instances with SAP config from headers
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMCPServer = getMCPServer;
exports.clearCache = clearCache;
// CRITICAL: Set env vars BEFORE importing submodule
// The submodule has top-level code that reads these on import
process.env.MCP_SKIP_AUTO_START = 'true';
process.env.MCP_SKIP_ENV_LOAD = 'true';
process.env.TLS_REJECT_UNAUTHORIZED = '0';
const cds_1 = __importDefault(require("@sap/cds"));
// @ts-ignore - ESM import path with .js extension
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const crypto_1 = require("crypto");
// Import MCP server class
// @ts-ignore - no types in mcp-abap-adt
const index_js_1 = require("../submodules/mcp-abap-adt/dist/index.js");
// Cache of MCP server instances by SAP URL
const instanceCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
/**
 * Extract SAP configuration from request headers
 */
function extractSapConfig(req) {
    const log = cds_1.default.log('mcp-manager');
    const sapUrl = req.headers['x-sap-url'];
    const sapAuthType = req.headers['x-sap-auth-type'] || 'jwt';
    const sapJwtToken = req.headers['x-sap-jwt-token'];
    const sapClient = req.headers['x-sap-client'];
    const sapUsername = req.headers['x-sap-username'];
    const sapPassword = req.headers['x-sap-password'];
    if (!sapUrl) {
        throw new Error('Missing X-SAP-URL header');
    }
    const config = {
        url: sapUrl,
        authType: sapAuthType === 'xsuaa' ? 'jwt' : sapAuthType
    };
    if (sapClient) {
        config.client = sapClient;
    }
    if (sapAuthType === 'basic') {
        if (!sapUsername || !sapPassword) {
            throw new Error('Basic auth requires X-SAP-USERNAME and X-SAP-PASSWORD headers');
        }
        config.username = sapUsername;
        config.password = sapPassword;
    }
    else if (sapAuthType === 'jwt' || sapAuthType === 'xsuaa') {
        if (!sapJwtToken) {
            throw new Error('JWT auth requires X-SAP-JWT-TOKEN header');
        }
        config.jwtToken = sapJwtToken;
    }
    // Log config with token preview
    const tokenPreview = config.jwtToken
        ? `${config.jwtToken.substring(0, 20)}...${config.jwtToken.substring(config.jwtToken.length - 20)}`
        : 'none';
    log.info('SAP config extracted from headers', {
        url: config.url,
        authType: config.authType,
        client: config.client || 'none',
        tokenPreview,
        tokenLength: config.jwtToken?.length || 0
    });
    return config;
}
/**
 * Get cache key for MCP instance
 */
function getCacheKey(sapConfig) {
    return `${sapConfig.url}:${sapConfig.authType}`;
}
/**
 * Clean expired instances from cache
 */
function cleanCache() {
    const now = Date.now();
    for (const [key, value] of instanceCache.entries()) {
        if (now - value.created > CACHE_TTL) {
            instanceCache.delete(key);
        }
    }
}
/**
 * Get or create MCP server instance with transport for given SAP config
 */
async function getMCPServer(req) {
    const log = cds_1.default.log('mcp-manager');
    try {
        // Extract SAP config from headers
        const sapConfig = extractSapConfig(req);
        const cacheKey = getCacheKey(sapConfig);
        // Clean old instances periodically
        cleanCache();
        // Check cache
        const cached = instanceCache.get(cacheKey);
        if (cached) {
            log.debug('Using cached MCP instance', { cacheKey });
            return cached;
        }
        log.info('Creating new MCP server instance', {
            sapUrl: sapConfig.url,
            authType: sapConfig.authType
        });
        // ВАЖЛИВО: Очищаємо env перед створенням інстансу
        // Субмодуль може все ще мати cached config з .env файлу
        // Тому ми явно передаємо sapConfig через options
        const oldEnv = {
            SAP_URL: process.env.SAP_URL,
            SAP_CLIENT: process.env.SAP_CLIENT,
            SAP_AUTH_TYPE: process.env.SAP_AUTH_TYPE,
            SAP_JWT_TOKEN: process.env.SAP_JWT_TOKEN,
            SAP_USERNAME: process.env.SAP_USERNAME,
            SAP_PASSWORD: process.env.SAP_PASSWORD
        };
        // Clear env vars to prevent submodule from using them
        delete process.env.SAP_URL;
        delete process.env.SAP_CLIENT;
        delete process.env.SAP_AUTH_TYPE;
        delete process.env.SAP_JWT_TOKEN;
        delete process.env.SAP_USERNAME;
        delete process.env.SAP_PASSWORD;
        // Create MCP server instance with SAP config
        const mcpServerInstance = new index_js_1.mcp_abap_adt_server({
            sapConfig,
            allowProcessExit: false,
            registerSignalHandlers: false
        });
        // Restore env vars (for other code that might need them)
        Object.assign(process.env, oldEnv);
        // Create streamable HTTP transport
        const streamTransport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: () => (0, crypto_1.randomUUID)(),
            enableJsonResponse: false,
            allowedOrigins: undefined,
            allowedHosts: undefined,
            enableDnsRebindingProtection: false
        });
        // Connect transport to MCP server
        await mcpServerInstance.server.connect(streamTransport);
        const instance = { server: mcpServerInstance, transport: streamTransport, created: Date.now() };
        // Cache instance
        instanceCache.set(cacheKey, instance);
        log.info('MCP server instance created and cached', { cacheKey });
        return instance;
    }
    catch (err) {
        log.error('Failed to create MCP server instance', err);
        throw err;
    }
}
/**
 * Clear all cached MCP instances
 */
function clearCache() {
    const log = cds_1.default.log('mcp-manager');
    log.info('Clearing MCP instance cache', { count: instanceCache.size });
    instanceCache.clear();
}
// Cleanup cache on shutdown
process.on('SIGTERM', clearCache);
process.on('SIGINT', clearCache);
//# sourceMappingURL=mcp-manager.js.map