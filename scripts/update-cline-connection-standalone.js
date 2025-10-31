#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const {
  applySapConfigToHeaders,
  applyMcpAuth,
  applyDestinationHeaders
} = require('./update-cline-connection');

function parseArgs(argv) {
  const options = {
    connectionName: '',
    updateScope: 'all',
    dryRun: false
  };

  let scopeArgument;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-c':
      case '--connection':
        options.connectionName = argv[++i] ?? '';
        break;
      case '--settings':
        options.settingsPath = argv[++i];
        break;
      case '--update':
      case '--scope':
        scopeArgument = (argv[++i] ?? '').toLowerCase();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--sap-url':
        options.sapUrl = argv[++i];
        break;
      case '--sap-client':
        options.sapClient = argv[++i];
        break;
      case '--sap-auth-type':
        options.sapAuthType = argv[++i];
        break;
      case '--sap-token':
      case '--token':
        options.sapToken = argv[++i];
        break;
      case '--sap-username':
        options.sapUsername = argv[++i];
        break;
      case '--sap-password':
        options.sapPassword = argv[++i];
        break;
      case '--destination-name':
        options.destinationName = argv[++i];
        break;
      case '--connectivity-mode':
        options.connectivityMode = argv[++i];
        break;
      case '--connectivity-location-id':
        options.connectivityLocationId = argv[++i];
        break;
      case '--mcp-auth-header':
      case '--auth-header':
        options.mcpAuthHeader = argv[++i];
        break;
      case '--mcp-auth-type':
        options.mcpAuthType = argv[++i];
        break;
      case '--mcp-username':
        options.mcpUsername = argv[++i];
        break;
      case '--mcp-password':
        options.mcpPassword = argv[++i];
        break;
      case '--mcp-token':
        options.mcpToken = argv[++i];
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('-') && !options.connectionName) {
          options.connectionName = arg;
        }
        break;
    }
  }

  if (!options.settingsPath) {
    console.error('❌  --settings <path> is required for the standalone script.');
    printHelp();
    process.exit(1);
  }

  if (!options.connectionName) {
    console.error('❌  Connection name is required (--connection <name>).');
    printHelp();
    process.exit(1);
  }

  if (scopeArgument) {
    if (scopeArgument === 'both' || scopeArgument === 'all') {
      options.updateScope = 'all';
    } else if (scopeArgument === 'sap' || scopeArgument === 'mcp') {
      options.updateScope = scopeArgument;
    } else {
      console.error('❌  Invalid value for --update. Use sap, mcp, or all.');
      process.exit(1);
    }
  }

  return options;
}

function printHelp() {
  const entryName = path.basename(__filename);
  console.log(`Standalone update of MCP connection settings for Cline

Usage: node ${entryName} --connection <name> --settings <path> [options]

Options:
  -c, --connection <name>   MCP connection name in Cline (required)
      --settings <path>      Path to cline_mcp_settings.json (required)
      --update <scope>       Update scope: sap | mcp | all (default: all, alias: --scope)
      --dry-run              Preview changes without writing the file
      --force                Skip confirmations when possible

  Destination usage:
      --destination-name <name>      Destination to reference via X-SAP-Destination header
      --connectivity-mode <mode>     onprem | internet (default: internet)
      --connectivity-location-id <id>  Cloud Connector location id for on-premise destinations

  SAP headers (direct mode):
      --sap-url <url>        SAP system URL (required unless destination is used)
      --sap-client <id>      SAP client (optional)
      --sap-auth-type <type> jwt | basic (default: jwt)
      --sap-token <value>    SAP JWT token (jwt mode)
      --sap-username <value> SAP username (basic mode)
      --sap-password <value> SAP password (basic mode)

  MCP authentication:
      --mcp-auth-header <value>  Override Authorization header directly (alias: --auth-header)
      --mcp-auth-type <type>     basic | jwt | bearer | none (auto-detected when possible)
      --mcp-username <value>     Username for MCP basic auth
      --mcp-password <value>     Password for MCP basic auth
      --mcp-token <value>        Token for MCP bearer authentication

  -h, --help                 Show this help message
`);
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${error.message}`);
  }
}

async function writeJsonFile(filePath, content) {
  const formatted = `${JSON.stringify(content, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, formatted, 'utf8');
}

async function confirmPrompt(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(message, resolve);
  });
  rl.close();
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

function buildSapEnv(options) {
  const env = {};
  if (options.sapUrl) {
    env.SAP_URL = options.sapUrl;
  }
  if (options.sapClient) {
    env.SAP_CLIENT = options.sapClient;
  }
  if (options.sapAuthType) {
    env.SAP_AUTH_TYPE = options.sapAuthType;
  }
  if (options.sapToken) {
    env.SAP_JWT_TOKEN = options.sapToken;
  }
  if (options.sapUsername) {
    env.SAP_USERNAME = options.sapUsername;
  }
  if (options.sapPassword) {
    env.SAP_PASSWORD = options.sapPassword;
  }
  return env;
}

function ensureSapInputs(env, overrides, destinationName) {
  if (destinationName) {
    return;
  }

  const authType = (overrides.authType ?? env.SAP_AUTH_TYPE ?? 'jwt').toLowerCase();

  if (!env.SAP_URL) {
    throw new Error('--sap-url is required when destination is not used.');
  }

  if (authType === 'jwt') {
    if (!overrides.token && !env.SAP_JWT_TOKEN) {
      throw new Error('Provide --sap-token for JWT authentication.');
    }
  } else if (authType === 'basic') {
    if (!overrides.username && !env.SAP_USERNAME) {
      throw new Error('Provide --sap-username for basic authentication.');
    }
    if (!overrides.password && !env.SAP_PASSWORD) {
      throw new Error('Provide --sap-password for basic authentication.');
    }
  } else {
    throw new Error('Unsupported --sap-auth-type. Use jwt or basic.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const updateSap = options.updateScope === 'sap' || options.updateScope === 'all';
  const updateMcp = options.updateScope === 'mcp' || options.updateScope === 'all';

  const config = await readJsonFile(options.settingsPath);
  if (!config.mcpServers) {
    throw new Error('Configuration file is missing the mcpServers section.');
  }

  const connection = config.mcpServers[options.connectionName];
  if (!connection) {
    const available = Object.keys(config.mcpServers).length
      ? Object.keys(config.mcpServers).join(', ')
      : 'none';
    throw new Error(`Connection "${options.connectionName}" not found. Available: ${available}`);
  }

  connection.headers = connection.headers ?? {};
  const updatedHeaders = [];
  let jwt;

  if (updateSap) {
    if (options.destinationName) {
      const destinationUpdated = applyDestinationHeaders(connection.headers, {
        destinationName: options.destinationName,
        connectivityMode: options.connectivityMode,
        connectivityLocationId: options.connectivityLocationId
      });
      updatedHeaders.push(...destinationUpdated);
    } else {
      const sapEnv = buildSapEnv(options);
      ensureSapInputs(sapEnv, {
        token: options.sapToken,
        authType: options.sapAuthType,
        username: options.sapUsername,
        password: options.sapPassword
      });

      const result = applySapConfigToHeaders(connection.headers, sapEnv, {
        token: options.sapToken,
        authType: options.sapAuthType,
        username: options.sapUsername,
        password: options.sapPassword
      });
      updatedHeaders.push(...result.updated);
      if (result.jwt) {
        jwt = result.jwt;
      }
    }
  }

  if (updateMcp) {
    const mcpUpdated = applyMcpAuth(connection.headers, {
      authType: options.mcpAuthType,
      username: options.mcpUsername,
      password: options.mcpPassword,
      token: options.mcpToken,
      authHeader: options.mcpAuthHeader
    });
    updatedHeaders.push(...mcpUpdated);
  }

  if (updateSap && jwt && !options.force) {
    console.warn('⚠️  Standalone mode cannot validate JWT expiration. Ensure the provided token is valid.');
    const confirmed = await confirmPrompt('Continue with the provided token? [y/N] ');
    if (!confirmed) {
      console.log('Operation cancelled.');
      process.exit(0);
    }
  }

  if (options.dryRun) {
    console.log('🛈 Dry-run mode (--dry-run). The file will not be modified.');
  } else {
    await writeJsonFile(options.settingsPath, config);
    console.log(`✅ File updated: ${options.settingsPath}`);
  }

  const uniqueUpdated = [...new Set(updatedHeaders)]
    .filter(Boolean)
    .sort();
  console.log(`ℹ️  Updated headers: ${uniqueUpdated.length ? uniqueUpdated.join(', ') : 'none'}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌  ${error.message}`);
    process.exit(1);
  });
}
