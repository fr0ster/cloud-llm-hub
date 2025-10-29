"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = registerMcpProxyHandlers;
const cds_1 = __importDefault(require("@sap/cds"));
const DEFAULT_MODE = 'stream-http';
/**
 * AuthShim - Universal middleware for Basic (dev) and Bearer (prod) authorization
 * Maps XSUAA scopes to CAP roles
 */
async function authShim(req, res, next) {
    const log = cds_1.default.log('mcp-proxy/authShim');
    const hdr = req.headers.authorization || '';
    try {
        // Basic auth for development
        if (hdr.startsWith('Basic ')) {
            const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
            const [user] = decoded.split(':');
            const username = user || 'anonymous';
            log.debug('Basic auth detected', { username });
            // Map mock users to roles (matching package.json dev profile)
            let roles = ['MCP_Connector'];
            if (username === 'alice') {
                roles = ['MCP_Connector', 'MCP_Admin'];
            }
            req.user = new cds_1.default.User({
                id: username,
                roles,
                attr: {}
            });
            return next();
        }
        // Bearer JWT for production (XSUAA)
        if (hdr.startsWith('Bearer ')) {
            const token = hdr.slice(7);
            // Try to get XSUAA binding
            let xsuaa;
            try {
                const xsenv = require('@sap/xsenv');
                xsuaa = xsenv.getServices({ uaa: { tag: 'xsuaa' } }).uaa;
            }
            catch (err) {
                log.warn('No XSUAA binding found, falling back to dev mode');
                throw new Error('Missing XSUAA binding in production mode');
            }
            // Validate JWT token
            const xssec = require('@sap/xssec');
            const securityContext = await new Promise((resolve, reject) => {
                xssec.createSecurityContext(token, xsuaa, (err, sc) => {
                    if (err)
                        reject(err);
                    else
                        resolve(sc);
                });
            });
            // Extract scopes and map to CAP roles
            const scopes = new Set(securityContext.getScopes() || []);
            const xsappname = xsuaa.xsappname;
            const roles = [];
            if (scopes.has(`${xsappname}.MCP_Connect`))
                roles.push('MCP_Connector');
            if (scopes.has(`${xsappname}.MCP_Read`))
                roles.push('MCP_Connector');
            if (scopes.has(`${xsappname}.MCP_Admin`))
                roles.push('MCP_Admin');
            log.debug('Bearer auth validated', {
                user: securityContext.getLogonName(),
                roles,
                scopeCount: scopes.size
            });
            req.user = new cds_1.default.User({
                id: securityContext.getLogonName(),
                roles,
                attr: {}
            });
            return next();
        }
        // No valid authorization header
        log.warn('Unauthorized request - missing or invalid Authorization header');
        res.status(401).send('Unauthorized: Missing or invalid Authorization header');
    }
    catch (err) {
        log.error('Authorization failed', err);
        res.status(401).send(`Unauthorized: ${err.message}`);
    }
}
/**
 * SSE endpoint: GET /mcp/stream/sse
 * Server-Sent Events stream with heartbeat and reconnection hints
 */
async function handleSSE(req, res) {
    const log = cds_1.default.log('mcp-proxy/sse');
    const user = req.user;
    // Check authorization
    if (!user || !user.is('MCP_Connector')) {
        log.warn('Forbidden: User lacks MCP_Connector role', { user: user?.id });
        res.sendStatus(403);
        return;
    }
    log.info('SSE connection established', { user: user.id });
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    // Send reconnection hint
    res.write('retry: 15000\n\n');
    // Heartbeat every 15 seconds
    const heartbeatInterval = setInterval(() => {
        res.write(': ping\n\n');
    }, 15000);
    // Get target URL from config
    const targetUrl = cds_1.default.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070';
    try {
        log.debug('Connecting to upstream SSE', { targetUrl });
        // Forward to upstream MCP service
        const upstreamUrl = `${targetUrl}/sse`;
        const response = await fetch(upstreamUrl, {
            headers: {
                'Accept': 'text/event-stream'
            },
            signal: AbortSignal.timeout(120000) // 2 minute timeout
        });
        if (!response.ok) {
            throw new Error(`Upstream returned ${response.status}: ${response.statusText}`);
        }
        if (!response.body) {
            throw new Error('Upstream response has no body');
        }
        // Pipe upstream events to client
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                log.info('Upstream closed SSE connection', { user: user.id });
                break;
            }
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);
        }
    }
    catch (err) {
        log.error('SSE stream error', { error: err.message, user: user.id });
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    finally {
        clearInterval(heartbeatInterval);
        res.end();
        log.info('SSE connection closed', { user: user.id });
    }
    // Handle client disconnect
    req.on('close', () => {
        clearInterval(heartbeatInterval);
        log.info('Client disconnected from SSE', { user: user.id });
    });
}
/**
 * Stream-HTTP endpoint: POST /mcp/stream/http
 * NDJSON streaming for bidirectional communication
 */
async function handleStreamHTTP(req, res) {
    const log = cds_1.default.log('mcp-proxy/stream-http');
    const user = req.user;
    // Check authorization
    if (!user || !user.is('MCP_Connector')) {
        log.warn('Forbidden: User lacks MCP_Connector role', { user: user?.id });
        res.sendStatus(403);
        return;
    }
    log.info('Stream-HTTP connection established', { user: user.id });
    // Get target URL from config
    const targetUrl = cds_1.default.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070';
    try {
        log.debug('Forwarding to upstream stream', { targetUrl });
        // Forward POST to upstream
        const upstreamUrl = `${targetUrl}/stream`;
        const response = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': req.headers['content-type'] || 'application/x-ndjson',
            },
            // @ts-ignore - Express Request is stream-compatible
            body: req,
            signal: AbortSignal.timeout(120000), // 2 minute timeout
            // @ts-ignore - Node.js fetch supports duplex
            duplex: 'half'
        });
        if (!response.ok) {
            throw new Error(`Upstream returned ${response.status}: ${response.statusText}`);
        }
        if (!response.body) {
            throw new Error('Upstream response has no body');
        }
        // Set response headers
        const contentType = response.headers.get('Content-Type') || 'application/x-ndjson';
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
        // Pipe upstream response to client
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                log.info('Upstream closed stream-http connection', { user: user.id });
                break;
            }
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);
        }
    }
    catch (err) {
        log.error('Stream-HTTP error', { error: err.message, user: user.id });
        res.status(500).json({ error: err.message });
    }
    finally {
        res.end();
        log.info('Stream-HTTP connection closed', { user: user.id });
    }
    // Handle client disconnect
    req.on('close', () => {
        log.info('Client disconnected from stream-http', { user: user.id });
    });
}
/**
 * Bootstrap custom Express routes for streaming endpoints.
 * This runs BEFORE service handlers are registered.
 */
cds_1.default.on('bootstrap', (app) => {
    const log = cds_1.default.log('mcp-proxy/bootstrap');
    log.info('Registering custom streaming endpoints');
    // Note: We use authShim instead of cds.auth() because:
    // 1. cds.auth() doesn't work well with streaming responses
    // 2. We need to support both Basic (dev) and Bearer (prod) in one middleware
    // 3. Custom role mapping from XSUAA scopes to CAP roles
    // SSE endpoint with authShim
    app.get('/mcp/stream/sse', authShim, handleSSE);
    // Stream-HTTP endpoint with authShim
    app.post('/mcp/stream/http', authShim, handleStreamHTTP);
    log.info('Streaming endpoints registered', {
        sse: 'GET /mcp/stream/sse',
        streamHttp: 'POST /mcp/stream/http'
    });
});
/**
 * CAP service handler for McpProxyService.
 * CAP enforces the `@requires: 'proxyAccess'` annotation defined in the CDS model.
 */
async function registerMcpProxyHandlers(srv) {
    const log = cds_1.default.log('mcp-proxy');
    // Health check endpoint
    srv.on('Health', async () => {
        const now = new Date().toISOString();
        log.debug('Health check responded', { now });
        return {
            status: 'UP',
            timestamp: now,
        };
    });
    // Legacy action for backward compatibility
    srv.on('InvokeTool', async (req) => {
        const { toolId, mode = DEFAULT_MODE } = req.data;
        log.info('Proxy request received', { toolId, mode });
        return {
            status: 'DEPRECATED',
            mode,
            message: 'Use /mcp/stream/sse or /mcp/stream/http endpoints instead.',
            receivedAt: new Date().toISOString(),
        };
    });
}
// CommonJS compatibility for CAP
module.exports = registerMcpProxyHandlers;
//# sourceMappingURL=mcp-proxy.js.map