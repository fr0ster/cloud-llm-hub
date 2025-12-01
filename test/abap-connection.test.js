#!/usr/bin/env node
/**
 * Test cloud-llm-hub ABAP Connection via MCP GetTable
 *
 * This test validates cloud-llm-hub proxy functionality:
 * 1. Calls /mcp/stream/http endpoint with JWT auth
 * 2. Executes GetTable tool for T000 table
 * 3. Verifies auto-refresh works through cloud-llm-hub
 *
 * Usage:
 *   node test/abap-connection.test.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Color output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(symbol, color, message, data) {
  console.log(`${color}${symbol}${colors.reset} ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Load .env file
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const env = {};

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split('\n').forEach((line) => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;

      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        env[key] = value;
      }
    });
    log('ℹ', colors.cyan, `Loaded credentials from ${envPath}\n`);
  } else {
    log('⚠', colors.yellow, `No .env file found at ${envPath}\n`);
  }

  return env;
}

const dotenv = loadEnv();

// Configuration
const config = {
  // cloud-llm-hub server
  host: process.env.TEST_HOST || 'localhost',
  port: process.env.TEST_PORT || 4004,
  path: '/mcp/stream/http',

  // cloud-llm-hub auth (Basic auth for dev: ali:ali)
  authHeader: process.env.AUTH_HEADER || 'Basic YWxpOmFsaQ==',

  // SAP connection details (passed in headers to cloud-llm-hub)
  sapUrl: process.env.SAP_URL || dotenv.SAP_URL,
  jwtToken: process.env.SAP_JWT_TOKEN || dotenv.SAP_JWT_TOKEN,
  refreshToken: process.env.SAP_REFRESH_TOKEN || dotenv.SAP_REFRESH_TOKEN,
  uaaUrl: process.env.SAP_UAA_URL || dotenv.SAP_UAA_URL,
  uaaClientId: process.env.SAP_UAA_CLIENT_ID || dotenv.SAP_UAA_CLIENT_ID,
  uaaClientSecret: process.env.SAP_UAA_CLIENT_SECRET || dotenv.SAP_UAA_CLIENT_SECRET,
  client: process.env.SAP_CLIENT || dotenv.SAP_CLIENT,
};

console.log('============================================================');
console.log('cloud-llm-hub ABAP Connection Test - GetTable T000');
console.log('============================================================\n');

log('ℹ', colors.cyan, 'Configuration', {
  server: `${config.host}:${config.port}${config.path}`,
  sapUrl: config.sapUrl,
  hasJwtToken: !!config.jwtToken,
  jwtTokenLength: config.jwtToken?.length || 0,
  hasRefreshToken: !!config.refreshToken,
  hasUaaCredentials: !!(config.uaaUrl && config.uaaClientId && config.uaaClientSecret),
  client: config.client || '(not specified)',
});

// Validate configuration
if (!config.sapUrl) {
  log('✗', colors.red, 'SAP_URL not set in .env file');
  process.exit(1);
}

if (!config.jwtToken) {
  log('✗', colors.red, 'SAP_JWT_TOKEN not set in .env file');
  process.exit(1);
}

if (!config.refreshToken || !config.uaaUrl || !config.uaaClientId || !config.uaaClientSecret) {
  log('⚠', colors.yellow, 'UAA credentials incomplete - auto-refresh will not work', {
    hasRefreshToken: !!config.refreshToken,
    hasUaaUrl: !!config.uaaUrl,
    hasClientId: !!config.uaaClientId,
    hasClientSecret: !!config.uaaClientSecret,
  });
}

console.log('');

// Helper to make MCP request
function mcpRequest(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: config.authHeader,
      // SAP headers - passed to cloud-llm-hub
      'X-SAP-URL': config.sapUrl,
      'X-SAP-JWT-Token': config.jwtToken,
      'X-SAP-Refresh-Token': config.refreshToken,
      'X-SAP-UAA-URL': config.uaaUrl,
      'X-SAP-UAA-CLIENT-ID': config.uaaClientId,
      'X-SAP-UAA-CLIENT-SECRET': config.uaaClientSecret,
    };

    if (config.client) {
      headers['X-SAP-CLIENT'] = config.client;
    }

    const options = {
      hostname: config.host,
      port: config.port,
      path: config.path,
      method: 'POST',
      headers,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }

        try {
          const lines = data.trim().split('\n');
          const responses = lines.map((line) => JSON.parse(line));
          resolve(responses);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}\nData: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Test function
async function runTest() {
  let passed = 0;
  let failed = 0;

  try {
    // Test 1: Initialize MCP session
    log('ℹ', colors.cyan, 'Test 1: Initialize MCP session');
    try {
      const initResponse = await mcpRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'abap-connection-test',
          version: '1.0.0',
        },
      });

      const result = initResponse[0]?.result;
      if (result?.protocolVersion && result?.serverInfo?.name) {
        log('✓', colors.green, 'Initialize successful', {
          protocolVersion: result.protocolVersion,
          serverName: result.serverInfo.name,
          serverVersion: result.serverInfo.version,
        });
        passed++;
      } else {
        throw new Error('Invalid initialize response');
      }
    } catch (err) {
      log('✗', colors.red, 'Initialize failed', { error: err.message });
      failed++;
    }

    console.log('');

    // Test 2: Call GetTable for T000
    log('ℹ', colors.cyan, 'Test 2: GetTable for T000 (tests ABAP connection + auto-refresh)');
    try {
      const getTableResponse = await mcpRequest('tools/call', {
        name: 'GetTable',
        arguments: {
          table_name: 'T000',
          max_rows: 5,
        },
      });

      const result = getTableResponse[0]?.result;
      if (result?.content && result.content.length > 0) {
        const content = result.content[0];
        log('✓', colors.green, 'GetTable successful', {
          contentType: content.type,
          hasText: !!content.text,
          textLength: content.text?.length || 0,
          textPreview: content.text?.substring(0, 200) + '...',
        });
        passed++;
      } else {
        throw new Error('Invalid GetTable response');
      }
    } catch (err) {
      log('✗', colors.red, 'GetTable failed', { error: err.message });
      failed++;

      // Helpful error messages
      if (err.message.includes('401')) {
        console.log('');
        log('ℹ', colors.cyan, 'Token authentication failed. Possible reasons:');
        console.log('  1. JWT token has expired');
        console.log('  2. Auto-refresh failed (check cloud-llm-hub logs)');
        console.log('  3. UAA credentials incorrect');
        console.log('  4. Refresh token has expired (re-authenticate via mcp-abap-adt)');
      }
    }

    console.log('\n============================================================');
    if (failed === 0) {
      log('✓', colors.green, `All ${passed} tests passed!`);
    } else {
      log('✗', colors.red, `${failed} test(s) failed, ${passed} passed`);
    }
    console.log('============================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.log('');
    log('✗', colors.red, 'Unexpected error', {
      error: error.message,
      stack: error.stack,
    });

    console.log('\n============================================================');
    log('✗', colors.red, 'Tests failed');
    console.log('============================================================\n');

    process.exit(1);
  }
}

runTest();
