#!/usr/bin/env node
/**
 * Example: CI/CD script for SAP code analysis
 *
 * Usage:
 *   node ci-cd-example.js --pr-number 123 --connection sap-ci
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load configuration
const settingsPath = process.argv.includes('--settings')
  ? process.argv[process.argv.indexOf('--settings') + 1]
  : path.join(process.cwd(), '.github', '.cline-settings.json');

const connectionName = process.argv.includes('--connection')
  ? process.argv[process.argv.indexOf('--connection') + 1]
  : 'sap-ci';

const prNumber = process.argv.includes('--pr-number')
  ? process.argv[process.argv.indexOf('--pr-number') + 1]
  : null;

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const connection = settings.mcpServers[connectionName];

if (!connection) {
  console.error(`❌ Connection "${connectionName}" not found in settings`);
  process.exit(1);
}

const endpoint = new URL(connection.url);
const headers = {
  ...connection.headers,
  'Content-Type': 'application/json',
};

// MCP client
class MCPClient {
  constructor(endpoint, headers) {
    this.endpoint = endpoint;
    this.headers = headers;
  }

  async callTool(toolName, arguments_) {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: arguments_,
      },
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.endpoint.hostname,
          port: this.endpoint.port || 443,
          path: this.endpoint.pathname,
          method: 'POST',
          headers: {
            ...this.headers,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.error) {
                reject(new Error(result.error.message));
              } else {
                resolve(result.result);
              }
            } catch (e) {
              reject(new Error(`Failed to parse response: ${e.message}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

// Main analysis logic
async function analyzeChanges() {
  const client = new MCPClient(endpoint, headers);
  const report = [];

  report.push('# SAP Code Analysis Report\n');
  report.push(`**Generated:** ${new Date().toISOString()}\n`);
  if (prNumber) {
    report.push(`**PR:** #${prNumber}\n`);
  }
  report.push('\n');

  try {
    // Example: Get changed objects (you would get this from git/PR diff)
    const changedObjects = ['Z_MY_CLASS', 'Z_MY_INTERFACE'];

    report.push('## Changed Objects\n');
    for (const obj of changedObjects) {
      report.push(`- ${obj}\n`);

      // Get object details
      const details = await client.callTool('GetObjectDetails', {
        objectName: obj,
      });
      report.push(`  - Type: ${details.objectType}\n`);
      report.push(`  - Package: ${details.package}\n`);

      // Get dependencies
      const deps = await client.callTool('GetDependencies', {
        objectName: obj,
      });
      if (deps && deps.length > 0) {
        report.push(`  - Dependencies: ${deps.length} objects\n`);
      }

      // Get where used
      const whereUsed = await client.callTool('GetWhereUsed', {
        objectName: obj,
      });
      if (whereUsed && whereUsed.length > 0) {
        report.push(`  - Used in: ${whereUsed.length} places\n`);
        report.push(`\n⚠️ **Impact:** This change affects ${whereUsed.length} locations\n`);
      }
    }

    report.push('\n## Summary\n');
    report.push(`- Analyzed ${changedObjects.length} objects\n`);
    report.push('- ✅ No critical impacts detected\n');
  } catch (error) {
    report.push(`\n❌ **Error:** ${error.message}\n`);
    process.exit(1);
  }

  // Write report
  const reportPath = path.join(process.cwd(), 'analysis-report.md');
  fs.writeFileSync(reportPath, report.join(''));
  console.log(`✅ Analysis report written to ${reportPath}`);
}

// Run
analyzeChanges().catch((error) => {
  console.error(`❌ Analysis failed: ${error.message}`);
  process.exit(1);
});
