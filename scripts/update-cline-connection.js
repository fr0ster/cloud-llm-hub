#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const options = {
    connectionName: '',
    dryRun: false,
    updateScope: 'all'
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
      case '--env':
        options.envPath = argv[++i];
        break;
      case '--update':
      case '--scope':
        scopeArgument = (argv[++i] ?? '').toLowerCase();
        break;
      case '--sap-token':
      case '--token':
        options.sapToken = argv[++i];
        break;
      case '--sap-auth-type':
        options.sapAuthType = argv[++i];
        break;
      case '--sap-username':
        options.sapUsername = argv[++i];
        break;
      case '--sap-password':
        options.sapPassword = argv[++i];
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
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--service-key':
        options.serviceKey = argv[++i];
        break;
      case '--browser':
        options.browser = argv[++i];
        break;
      case '--sap-auth-script':
        options.sapAuthScript = argv[++i];
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
  console.log(`Update MCP connection settings for Cline

Usage: node ${entryName} --connection <name> [options]

Options:
  -c, --connection <name>   MCP connection name in Cline (required)
      --update <scope>       Update scope: sap | mcp | all (default: all, alias: --scope)
      --settings <path>      Path to cline_mcp_settings.json (defaults to the standard location)
      --env <path>           Path to the SAP .env file (defaults to submodules/mcp-abap-adt/.env or ./\\.env)
      --dry-run              Preview changes without writing the file
      --force                Skip confirmations and warnings when possible
      --service-key <path>   Refresh SAP JWT via sap-abap-auth-browser using the provided service key
      --sap-auth-script <path>  Optional path to sap-abap-auth-browser.js (defaults to bundled/submodule copy)
      --browser <name>       Pass --browser to sap-abap-auth-browser (chrome|edge|firefox|system|none)

  MCP authentication (Cline ➜ MCP proxy):
      --mcp-auth-header <value>  Override Authorization header directly (alias: --auth-header)
      --mcp-auth-type <type>     basic | jwt | bearer | none (auto-detected when possible)
      --mcp-username <value>     Username for MCP basic auth
      --mcp-password <value>     Password for MCP basic auth
      --mcp-token <value>        Token for MCP bearer authentication

  SAP backend authentication (MCP proxy ➜ ABAP):
      --sap-auth-type <type>     jwt | basic (defaults to .env or jwt)
      --sap-username <value>     SAP username for basic auth
      --sap-password <value>     SAP password for basic auth
      --sap-token <value>        SAP JWT token (alias: --token)

  -h, --help                 Show this help message
`);
}

function getDefaultSettingsPath() {
  return path.join(
    os.homedir(),
    '.config',
    'Code',
    'User',
    'globalStorage',
    'saoudrizwan.claude-dev',
    'settings',
    'cline_mcp_settings.json'
  );
}

async function getDefaultEnvPath() {
  const submoduleEnv = path.join(process.cwd(), 'submodules', 'mcp-abap-adt', '.env');
  if (await fileExists(submoduleEnv)) {
    return submoduleEnv;
  }

  const localEnv = path.join(process.cwd(), '.env');
  if (await fileExists(localEnv)) {
    return localEnv;
  }

  return submoduleEnv;
}

function getScriptDirectory() {
  return __dirname;
}

async function resolveAuthScriptPath(scriptOverride) {
  const candidates = [];

  if (scriptOverride) {
    candidates.push(scriptOverride);
  }

  const scriptDir = getScriptDirectory();
  candidates.push(path.join(scriptDir, 'sap-abap-auth-browser.js'));
  candidates.push(path.join(process.cwd(), 'sap-abap-auth-browser.js'));
  candidates.push(path.join(process.cwd(), 'tools', 'sap-abap-auth-browser.js'));
  candidates.push(path.join(process.cwd(), 'submodules', 'mcp-abap-adt', 'tools', 'sap-abap-auth-browser.js'));

  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
    if (await fileExists(absolute)) {
      return { scriptPath: absolute, cwd: path.dirname(absolute) };
    }
  }

  throw new Error(
    'sap-abap-auth-browser.js not found. Provide --sap-auth-script <path> or copy the helper next to this script.'
  );
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${error.message}`);
  }
}

async function runServiceKeyAuth(options) {
  const scriptInfo = await resolveAuthScriptPath(options.scriptOverride);
  const serviceKeyPath = await ensureFile(options.serviceKey, 'Service key');

  const args = [scriptInfo.scriptPath, 'auth', '--key', serviceKeyPath];
  if (options.browser) {
    args.push('--browser', options.browser);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: scriptInfo.cwd,
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sap-abap-auth-browser exited with code ${code}`));
      }
    });
  });
}

async function writeJsonFile(filePath, data) {
  const formatted = `${JSON.stringify(data, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, formatted, 'utf8');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(filePath, description) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!(await fileExists(absolutePath))) {
    throw new Error(`${description} not found: ${absolutePath}`);
  }
  return absolutePath;
}

async function readEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .reduce((acc, line) => {
        const [key, ...rest] = line.split('=');
        if (!key) {
          return acc;
        }
        acc[key.trim()] = rest.join('=').trim();
        return acc;
      }, {});
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read .env (${filePath}): ${error.message}`);
  }
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function getJwtExpiration(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    return undefined;
  }
  return payload.exp * 1000;
}

function formatTimestamp(ts) {
  return new Date(ts).toISOString();
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

function getHeaderValue(headers, key) {
  const normalizedKey = key.toLowerCase();
  const existingKey = Object.keys(headers).find((k) => k.toLowerCase() === normalizedKey);
  return existingKey ? headers[existingKey] : undefined;
}

function setHeaderValue(headers, key, value, updated) {
  const normalizedKey = key.toLowerCase();
  const existingKey = Object.keys(headers).find((k) => k.toLowerCase() === normalizedKey);

  if (typeof value === 'string' && value.length > 0) {
    if (existingKey && existingKey !== normalizedKey) {
      delete headers[existingKey];
      if (!updated.includes(existingKey)) {
        updated.push(existingKey);
      }
    }
    headers[normalizedKey] = value;
    if (!updated.includes(normalizedKey)) {
      updated.push(normalizedKey);
    }
  } else if (existingKey) {
    delete headers[existingKey];
    if (!updated.includes(existingKey)) {
      updated.push(existingKey);
    }
  }
}

function applySapConfigToHeaders(headers, sapConfig, overrides) {
  const updatedKeys = [];

  setHeaderValue(headers, 'x-sap-url', sapConfig.SAP_URL, updatedKeys);
  setHeaderValue(headers, 'x-sap-client', sapConfig.SAP_CLIENT, updatedKeys);

  const authTypeSource =
    overrides.authType ?? sapConfig.SAP_AUTH_TYPE ?? getHeaderValue(headers, 'x-sap-auth-type') ?? 'jwt';
  const authType = authTypeSource.toLowerCase();

  if (!['jwt', 'basic'].includes(authType)) {
    throw new Error(`Unsupported SAP authentication type "${authTypeSource}". Use jwt or basic.`);
  }

  setHeaderValue(headers, 'x-sap-auth-type', authType, updatedKeys);

  if (authType === 'jwt') {
    const tokenSource = overrides.token ? 'arg' : 'env';
    const token = overrides.token ?? sapConfig.SAP_JWT_TOKEN;
    if (!token) {
      throw new Error('JWT token not found. Provide --sap-token or add SAP_JWT_TOKEN to the .env file.');
    }
    setHeaderValue(headers, 'x-sap-jwt-token', token, updatedKeys);
    setHeaderValue(headers, 'x-sap-username', undefined, updatedKeys);
    setHeaderValue(headers, 'x-sap-password', undefined, updatedKeys);
    return { updated: updatedKeys, jwt: { value: token, source: tokenSource } };
  }

  const username = overrides.username ?? sapConfig.SAP_USERNAME;
  const password = overrides.password ?? sapConfig.SAP_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'Basic auth requires both username and password. Provide --sap-username/--sap-password or set SAP_USERNAME/SAP_PASSWORD in the .env file.'
    );
  }

  setHeaderValue(headers, 'x-sap-username', username, updatedKeys);
  setHeaderValue(headers, 'x-sap-password', password, updatedKeys);
  setHeaderValue(headers, 'x-sap-jwt-token', undefined, updatedKeys);

  return { updated: updatedKeys };
}

function applyMcpAuth(headers, options) {
  const updated = [];

  if (!options.authHeader && !options.authType && !options.username && !options.password && !options.token) {
    return updated;
  }

  if (options.authHeader) {
    setHeaderValue(headers, 'authorization', options.authHeader, updated);
    return updated;
  }

  let authType = options.authType ? options.authType.toLowerCase() : undefined;
  if (!authType) {
    if (options.username && options.password) {
      authType = 'basic';
    } else if (options.token) {
      authType = 'jwt';
    }
  }

  switch (authType) {
    case 'basic': {
      const { username, password } = options;
      if (!username || !password) {
        throw new Error('MCP basic auth requires both --mcp-username and --mcp-password.');
      }
      const encoded = Buffer.from(`${username}:${password}`).toString('base64');
      setHeaderValue(headers, 'authorization', `Basic ${encoded}`, updated);
      break;
    }
    case 'jwt':
    case 'bearer': {
      const token = options.token;
      if (!token) {
        throw new Error('MCP JWT authentication requires --mcp-token.');
      }
      setHeaderValue(headers, 'authorization', `Bearer ${token}`, updated);
      break;
    }
    case 'none':
      setHeaderValue(headers, 'authorization', undefined, updated);
      break;
    default:
      throw new Error('Unsupported MCP auth type. Use basic, jwt, bearer, none, or provide --mcp-auth-header.');
  }

  return updated;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const updateSap = options.updateScope === 'sap' || options.updateScope === 'all';
  const updateMcp = options.updateScope === 'mcp' || options.updateScope === 'all';

  const settingsPath = options.settingsPath ?? getDefaultSettingsPath();
  const defaultEnvPath = await getDefaultEnvPath();
  const envPath = options.envPath ?? defaultEnvPath;

  if (options.serviceKey) {
    if (!updateSap) {
      console.warn('⚠️  Ignoring --service-key because the update scope does not include SAP credentials.');
    } else {
      console.log('🔄  Running sap-abap-auth-browser to refresh the JWT...');
      await runServiceKeyAuth({
        serviceKey: options.serviceKey,
        browser: options.browser,
        scriptOverride: options.sapAuthScript
      });
      console.log('✅  JWT updated using the provided service key.');
      if (options.envPath && path.resolve(process.cwd(), envPath) !== defaultEnvPath) {
        console.warn('⚠️  sap-abap-auth-browser refreshed the token in the submodule default .env. Pass the same --env path if you need a different file.');
      }
    }
  }

  const configPromise = readJsonFile(settingsPath);
  const sapConfigPromise = updateSap ? readEnvFile(envPath) : Promise.resolve({});
  const [config, sapConfig] = await Promise.all([configPromise, sapConfigPromise]);

  if (updateSap) {
    const envFilePresent = await fileExists(envPath);
    if (!envFilePresent && !options.sapToken) {
      console.warn(`⚠️  .env file not found (${envPath}). Provide --sap-token or refresh the file via the authorization utility.`);
    }
  }

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
    const result = applySapConfigToHeaders(connection.headers, sapConfig, {
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

  if (updateSap && jwt && jwt.source === 'env' && !options.force) {
    const expiration = getJwtExpiration(jwt.value);
    if (!expiration) {
      console.warn('⚠️  Unable to determine SAP JWT expiration from .env.');
    } else if (expiration <= Date.now()) {
      console.warn(`⚠️  SAP JWT from .env has already expired (exp: ${formatTimestamp(expiration)}).`);
      const confirmed = await confirmPrompt('Continue with this token? [y/N] ');
      if (!confirmed) {
        console.log('Operation cancelled. Refresh the token or provide it via --sap-token.');
        process.exit(0);
      }
    }
  }

  if (options.dryRun) {
    console.log('🛈 Dry-run mode (--dry-run). The file will not be modified.');
  } else {
    await writeJsonFile(settingsPath, config);
    console.log(`✅ File updated: ${settingsPath}`);
  }

  const uniqueUpdated = [...new Set(updatedHeaders)];
  console.log(`ℹ️  Updated headers: ${uniqueUpdated.length ? uniqueUpdated.join(', ') : 'none'}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌  ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, applySapConfigToHeaders, applyMcpAuth };
