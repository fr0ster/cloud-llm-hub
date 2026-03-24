#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function readYaml(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw);
}

function buildHeaders(config) {
  const headers = {};
  const authHeader = config?.auth?.header;
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const sap = config?.sap || {};
  const mode =
    sap.mode ||
    (sap.destination ? 'destination' : sap.direct ? 'direct' : undefined) ||
    undefined;
  if (mode === 'destination') {
    const name = sap.destination?.name || sap.destinationName;
    if (name) headers['X-SAP-Destination'] = name;
    const connectivityMode =
      sap.destination?.connectivity?.mode ||
      sap.connectivity?.mode ||
      sap.connectivityMode;
    if (connectivityMode) headers['X-SAP-Connectivity-Mode'] = connectivityMode;
    const locationId =
      sap.destination?.connectivity?.locationId ||
      sap.connectivity?.locationId ||
      sap.connectivityLocationId;
    if (locationId) headers['X-SAP-Connectivity-Location-Id'] = locationId;
  } else if (mode === 'direct') {
    const direct = sap.direct || sap;
    if (direct.url) headers['X-SAP-URL'] = direct.url;
    if (direct.client) headers['X-SAP-Client'] = String(direct.client);
    const authType = (direct.auth?.type || sap.authType || 'jwt').toLowerCase();
    headers['X-SAP-Auth-Type'] = authType;
    if (authType === 'jwt') {
      const token =
        direct.auth?.token || sap.token || sap.jwt || process.env.SAP_JWT_TOKEN;
      if (token) headers['X-SAP-JWT-Token'] = token;
    } else if (authType === 'basic') {
      const username = direct.auth?.username || sap.username;
      const password = direct.auth?.password || sap.password;
      if (username) headers['X-SAP-Username'] = username;
      if (password !== undefined) headers['X-SAP-Password'] = password;
    }
    if (direct.language) headers['X-SAP-Language'] = direct.language;
  }

  if (config?.headers && typeof config.headers === 'object') {
    for (const [k, v] of Object.entries(config.headers)) {
      if (v !== undefined && v !== null && String(v).length > 0) {
        headers[k] = String(v);
      }
    }
  }

  return headers;
}

async function run() {
  // Dynamic import for node-fetch v3 (ESM)
  const { default: fetch } = await import('node-fetch');

  const args = process.argv.slice(2);
  const argIndex = args.findIndex((a) => a === '--config' || a === '-c');
  if (argIndex === -1 || !args[argIndex + 1]) {
    console.error(
      'Usage: node test/test-cap-from-yaml.js --config <file.yaml>',
    );
    process.exit(1);
  }

  const configPath = path.resolve(process.cwd(), args[argIndex + 1]);
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    console.error(
      '   Copy template: cp test/integration.yaml.template test/integration.yaml',
    );
    process.exit(1);
  }

  const cfg = readYaml(configPath);
  const baseUrl = (cfg.baseUrl || cfg.baseURL || cfg.url || '').replace(
    /\/$/,
    '',
  );
  if (!baseUrl) {
    console.error('Config must include baseUrl');
    process.exit(1);
  }

  const headers = buildHeaders(cfg);
  const timeoutMs = Number(cfg.timeoutMs || cfg.requestTimeoutMs || 10000);

  // Helper to create fetch with timeout
  function fetchWithTimeout(url, options = {}, timeout = timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  function logResult(name, ok, status, bodyText) {
    const green = '\x1b[32m';
    const red = '\x1b[31m';
    const reset = '\x1b[0m';
    if (ok) {
      console.log(`  ${name}... ${green}✅ OK (${status})${reset}`);
    } else {
      console.log(`  ${name}... ${red}❌ FAILED (${status})${reset}`);
      if (bodyText) {
        console.log(bodyText.slice(0, 500));
      }
    }
  }

  console.log(`🧪 Testing endpoints on ${baseUrl}`);
  console.log('');

  // Health (CAP function)
  try {
    const res = await fetchWithTimeout(`${baseUrl}/odata/v4/mcp-proxy/Health()`, {
      method: 'GET',
      headers,
    });
    const text = await res.text();
    logResult('Health()', res.ok, res.status, text);
  } catch (e) {
    logResult('Health()', false, 'ERR', String(e.message || e));
  }

  // SSE (Express)
  try {
    const res = await fetchWithTimeout(`${baseUrl}/mcp/stream/sse`, {
      method: 'GET',
      headers,
    });
    const ok = res.status === 200 || res.status === 401 || res.status === 403; // availability/auth
    logResult('Stream SSE', ok, res.status, '');
  } catch (e) {
    logResult('Stream SSE', false, 'ERR', String(e.message || e));
  }

  // Stream HTTP (Express)
  try {
    const reqHeaders = { ...headers, 'Content-Type': 'application/json' };
    if (cfg?.streamTimeoutMs) {
      reqHeaders['X-MCP-Timeout'] = String(cfg.streamTimeoutMs);
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'ping' });
    const res = await fetchWithTimeout(`${baseUrl}/mcp/stream/http`, {
      method: 'POST',
      headers: reqHeaders,
      body,
    });
    const ok = [200, 202, 204, 400, 401, 403, 502].includes(res.status);
    const text = await res.text();
    logResult('Stream HTTP', ok, res.status, text);
  } catch (e) {
    logResult('Stream HTTP', false, 'ERR', String(e.message || e));
  }

  // Destination probe (optional)
  if (cfg?.sap?.destination?.name || cfg?.sap?.destinationName) {
    const name = cfg.sap.destination?.name || cfg.sap.destinationName;
    try {
      const url = `${baseUrl}/odata/v4/mcp-proxy/ProbeDestination?destination=${encodeURIComponent(name)}`;
      const res = await fetchWithTimeout(url, { method: 'GET', headers });
      const text = await res.text();
      logResult('ProbeDestination', res.ok, res.status, text);
    } catch (e) {
      logResult('ProbeDestination', false, 'ERR', String(e.message || e));
    }
  }
}

run().catch((e) => {
  console.error('❌ Test runner error:', e.message || e);
  process.exit(1);
});
