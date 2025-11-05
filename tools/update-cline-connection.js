#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const https = require('https');
const yaml = require('js-yaml');


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
      case '--destination-name':
        options.destinationName = argv[++i];
        break;
      case '--connectivity-mode':
        options.connectivityMode = (argv[++i] ?? '').toLowerCase();
        break;
      case '--connectivity-location-id':
        options.connectivityLocationId = argv[++i];
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

  Destination usage:
    --destination-name <name>      Destination to reference via X-SAP-Destination header
    --connectivity-mode <mode>     onprem | internet (default: internet)
    --connectivity-location-id <id>  Cloud Connector location id for on-premise destinations

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
      if (!username) {
        throw new Error('MCP basic auth requires --mcp-username.');
      }
      if (password === undefined || password === null) {
        throw new Error('MCP basic auth requires --mcp-password (use an empty string if needed).');
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

function normalizeConnectivityMode(mode) {
  if (!mode) {
    return undefined;
  }
  const normalized = mode.toLowerCase();
  if (normalized === 'onprem' || normalized === 'internet') {
    return normalized;
  }
  return undefined;
}

function applyDestinationHeaders(headers, options) {
  const updated = [];
  const destinationName = options.destinationName?.trim();
  const locationId = options.connectivityLocationId?.trim();

  if (destinationName) {
    setHeaderValue(headers, 'x-sap-destination', destinationName, updated);
  } else {
    setHeaderValue(headers, 'x-sap-destination', undefined, updated);
  }

  let connectivityMode = normalizeConnectivityMode(options.connectivityMode);
  if (!connectivityMode && locationId) {
    connectivityMode = 'onprem';
  }
  if (connectivityMode === 'onprem') {
    setHeaderValue(headers, 'x-sap-connectivity-mode', 'onprem', updated);
    if (locationId) {
      setHeaderValue(headers, 'x-sap-connectivity-location-id', locationId, updated);
    } else {
      setHeaderValue(headers, 'x-sap-connectivity-location-id', undefined, updated);
    }
  } else if (connectivityMode === 'internet') {
    setHeaderValue(headers, 'x-sap-connectivity-mode', 'internet', updated);
    setHeaderValue(headers, 'x-sap-connectivity-location-id', undefined, updated);
  } else {
    setHeaderValue(headers, 'x-sap-connectivity-mode', undefined, updated);
    setHeaderValue(headers, 'x-sap-connectivity-location-id', undefined, updated);
  }

  return updated;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const updateSap = options.updateScope === 'sap' || options.updateScope === 'all';
  const updateMcp = options.updateScope === 'mcp' || options.updateScope === 'all';

  // Standalone mode: if --settings is explicitly provided, skip automatic .env discovery
  const isStandalone = !!options.settingsPath;
  const settingsPath = options.settingsPath ?? getDefaultSettingsPath();
  const defaultEnvPath = isStandalone ? null : await getDefaultEnvPath();
  const envPath = options.envPath ?? defaultEnvPath;

  if (options.serviceKey) {
    if (isStandalone) {
      console.warn('⚠️  --service-key is not supported in standalone mode (requires repository structure). Use --sap-token instead.');
    } else if (!updateSap) {
      console.warn('⚠️  Ignoring --service-key because the update scope does not include SAP credentials.');
    } else {
      console.log('🔄  Running sap-abap-auth-browser to refresh the JWT...');
      await runServiceKeyAuth({
        serviceKey: options.serviceKey,
        browser: options.browser,
        scriptOverride: options.sapAuthScript
      });
      console.log('✅  JWT updated using the provided service key.');
      if (options.envPath && defaultEnvPath && path.resolve(process.cwd(), envPath) !== defaultEnvPath) {
        console.warn('⚠️  sap-abap-auth-browser refreshed the token in the submodule default .env. Pass the same --env path if you need a different file.');
      }
    }
  }

  const configPromise = readJsonFile(settingsPath);
  const sapConfigPromise = updateSap ? readEnvFile(envPath) : Promise.resolve({});
  const [config, sapConfig] = await Promise.all([configPromise, sapConfigPromise]);

  if (updateSap && !options.destinationName) {
    if (isStandalone) {
      // In standalone mode, require explicit SAP credentials
      if (!options.sapToken && !options.sapUsername) {
        throw new Error('Standalone mode requires explicit SAP credentials. Provide --sap-token (or --sap-username/--sap-password for basic auth).');
      }
    } else {
      const envFilePresent = envPath && await fileExists(envPath);
      if (!envFilePresent && !options.sapToken) {
        console.warn(`⚠️  .env file not found (${envPath}). Provide --sap-token or refresh the file via the authorization utility.`);
      }
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

  if (updateSap && options.destinationName) {
    const destinationUpdated = applyDestinationHeaders(connection.headers, {
      destinationName: options.destinationName,
      connectivityMode: options.connectivityMode,
      connectivityLocationId: options.connectivityLocationId
    });
    updatedHeaders.push(...destinationUpdated);
  } else if (updateSap) {
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



// ===== YAML MODE FUNCTIONS =====

const HEADER_CANONICAL_NAMES = {
  authorization: 'Authorization'
};

function canonicalizeHeaderName(key) {
  if (!key) {
    return key;
  }
  const normalized = String(key).toLowerCase();
  return HEADER_CANONICAL_NAMES[normalized] || key;
}

function canonicalizeHeadersInPlace(headers) {
  if (!headers || typeof headers !== 'object') {
    return;
  }
  const canonicalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const canonicalKey = canonicalizeHeaderName(key);
    canonicalized[canonicalKey] = value;
  }
  for (const key of Object.keys(headers)) {
    delete headers[key];
  }
  Object.assign(headers, canonicalized);
}

const TEMPLATE_RENDERERS = {
  'direct-basic': renderDirectBasicTemplate,
  'direct-jwt': renderDirectJwtTemplate,
  'cloud-internet': renderCloudInternetTemplate,
  'cloud-destination': renderCloudDestinationTemplate
};

const TEMPLATE_ENDPOINT_SUFFIX = {
  'direct-basic': '/mcp/stream/sse',
  'direct-jwt': '/mcp/stream/http',
  'cloud-internet': '/mcp/stream/http',
  'cloud-destination': '/mcp/stream/sse'
};

const DEFAULT_ABAP_CLIENT = '210';

const ABAP_URL_PATH = 'endpoints.abap';

const TEMPLATE_ALIAS_HINTS = {
  'direct-basic': {},
  'direct-jwt': {
    abap: ['sapAbapXsuaa', 'sapAbap']
  },
  'cloud-internet': {
    mcp: ['mcpXsuaa', 'mcpAuth'],
    abap: ['sapAbap', 'abap']
  },
  'cloud-destination': {
    mcp: ['mcpXsuaa', 'mcpAuth']
  }
};

const TEMPLATE_TOKEN_REQUIREMENTS = {
  'direct-basic': { mcp: false, abap: false },
  'direct-jwt': { mcp: false, abap: true },
  'cloud-internet': { mcp: true, abap: true },
  'cloud-destination': { mcp: true, abap: false }
};

const TEMPLATE_NAMES = Object.keys(TEMPLATE_RENDERERS);

function formatYamlScalar(value) {
  if (value === undefined || value === null) {
    return "''";
  }
  if (typeof value === 'string' && value.length === 0) {
    return "''";
  }
  const dumped = yaml.dump(value, { lineWidth: 240 }).trim();
  if (!dumped) {
    return "''";
  }
  if (dumped.includes('\n')) {
    return JSON.stringify(value);
  }
  return dumped;
}

function normalizeInlineServiceKeyDefinition(definition) {
  if (!definition || typeof definition !== 'object') {
    return undefined;
  }
  const normalized = { ...definition };
  if (normalized.templatePath) {
    normalized.path = normalized.templatePath;
  }
  delete normalized.templatePath;
  delete normalized.origin;
  return normalized;
}

function renderServiceKeysSection(definitions, placeholders = {}) {
  const aliases = new Set([
    ...Object.keys(definitions || {}),
    ...Object.keys(placeholders || {})
  ]);
  if (aliases.size === 0) {
    return '';
  }
  const rendered = {};
  for (const alias of Array.from(aliases).sort((a, b) => a.localeCompare(b))) {
    const definition = definitions?.[alias];
    if (definition) {
      const entry = normalizeInlineServiceKeyDefinition(definition);
      if (entry) {
        rendered[alias] = entry;
        continue;
      }
    }
    const placeholder = placeholders?.[alias];
    if (placeholder) {
      rendered[alias] = cloneDeep(placeholder);
    }
  }
  if (Object.keys(rendered).length === 0) {
    return '';
  }
  const block = yaml.dump({ serviceKeys: rendered }, { lineWidth: 240 }).trimEnd();
  return block ? `${block}
` : '';
}

function renderCfSection(options) {
  if (!options || typeof options !== 'object') {
    return '';
  }
  const normalized = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null && String(value).trim().length > 0) {
      normalized[key] = value;
    }
  }
  if (Object.keys(normalized).length === 0) {
    return '';
  }
  const block = yaml.dump({ cf: normalized }, { lineWidth: 240 }).trimEnd();
  return block ? `${block}
` : '';
}

function dedupeAliases(list) {
  const seen = new Set();
  const result = [];
  for (const item of list || []) {
    if (!item) {
      continue;
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function determineTokenAlias({
  explicit,
  preferred = [],
  available = [],
  keywords = []
}) {
  if (explicit) {
    return explicit;
  }
  const combined = dedupeAliases([...preferred, ...available]);
  if (combined.length === 0) {
    return undefined;
  }
  let lowerKeywords;
  if (keywords && keywords.length > 0) {
    lowerKeywords = keywords.map((keyword) => String(keyword).toLowerCase());
    for (const alias of combined) {
      const lowerAlias = alias.toLowerCase();
      if (lowerKeywords.some((keyword) => lowerAlias.includes(keyword))) {
        return alias;
      }
    }
  }
  if (combined.length === 1) {
    if (!lowerKeywords || lowerKeywords.length === 0) {
      return combined[0];
    }
    const lowerAlias = combined[0].toLowerCase();
    if (lowerKeywords.some((keyword) => lowerAlias.includes(keyword))) {
      return combined[0];
    }
  }
  return undefined;
}

function renderDirectBasicTemplate(options = {}) {
  const endpoint = options.mcpEndpoint || 'http://localhost:4004/mcp/stream/sse';
  const abapUrl = options.abapUrl || 'https://my.sap.system.example.com';
  const serviceKeysSection = options.serviceKeysSection || '';
  const cfBlock = options.cfBlock || '';
  const connectionNameLine = options.connectionName ? `  name: ${options.connectionName}\n` : '';
  return `# Template: Direct SAP connection using basic authentication
settingsPath: ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
${cfBlock}${serviceKeysSection}mcpConnection:
${connectionNameLine}  endpoint: ${endpoint}
  definition:
    type: sse
    description: Direct SAP via basic auth
  auth:
    type: basic
    username:
      source:
        type: const
        value: mcp-user@example.com
    password:
      source:
        type: const
        value: change-me
abapConnection:
  mode: direct
  direct:
    url: ${abapUrl}
    client: 200
  auth:
    type: basic
    username:
      source:
        type: const
        value: sap-user@example.com
    password:
      source:
        type: const
        value: change-me-too
`;
}

function renderDirectJwtTemplate(options = {}) {
  const endpoint = options.mcpEndpoint || 'https://example.proxy.local/mcp/stream/http';
  const abapUrl = options.abapUrl || 'https://my.sap.system.example.com';
  const abapClient = options.abapClient || DEFAULT_ABAP_CLIENT;
  const serviceKeysSection = options.serviceKeysSection || '';
  const cfBlock = options.cfBlock || '';
  const connectionNameLine = options.connectionName ? `  name: ${options.connectionName}\n` : '';
  const connectionType = options.mcpType || 'stream | sse';
  const connectionDescription = options.mcpDescription || 'Direct SAP via JWT';
  const desiredAuthType = options.mcpAuthType ? String(options.mcpAuthType).toLowerCase() : undefined;
  const hasBasicHints = options.mcpUsername !== undefined || options.mcpPassword !== undefined;
  let resolvedAuthType;

  if (options.mcpAuthHeader) {
    resolvedAuthType = 'header';
  } else if (desiredAuthType) {
    resolvedAuthType = desiredAuthType;
  } else if (hasBasicHints) {
    resolvedAuthType = 'basic';
  }

  let mcpAuthSection;

  switch (resolvedAuthType) {
    case 'header': {
      const headerValue = options.mcpAuthHeader !== undefined ? options.mcpAuthHeader : '<authorization-header>';
      const headerLiteral = formatYamlScalar(headerValue);
      mcpAuthSection = `  auth:\n    type: header\n    header:\n      source:\n        type: const\n        value: ${headerLiteral}`;
      break;
    }
    case 'bearer':
    case 'jwt': {
      const tokenValue = options.mcpToken !== undefined ? options.mcpToken : '<bearer-token>';
      const tokenLiteral = formatYamlScalar(tokenValue);
      mcpAuthSection = `  auth:\n    type: bearer\n    token:\n      source:\n        type: const\n        value: ${tokenLiteral}`;
      break;
    }
    case 'none': {
      mcpAuthSection = `  auth:\n    type: none`;
      break;
    }
    case 'basic': {
      const usernameValue = options.mcpUsername !== undefined ? options.mcpUsername : 'mcp-user@example.com';
      const passwordValue = options.mcpPassword !== undefined ? options.mcpPassword : 'change-me';
      const usernameLiteral = formatYamlScalar(usernameValue);
      const passwordLiteral = formatYamlScalar(passwordValue);
      mcpAuthSection = `  auth:\n    type: basic\n    username:\n      source:\n        type: const\n        value: ${usernameLiteral}\n    password:\n      source:\n        type: const\n        value: ${passwordLiteral}`;
      break;
    }
    default: {
      const defaultUsername = formatYamlScalar('mcp-user@example.com');
      const defaultPassword = formatYamlScalar('change-me');
      mcpAuthSection = `  auth:\n    type: basic\n    username:\n      source:\n        type: const\n        value: ${defaultUsername}\n    password:\n      source:\n        type: const\n        value: ${defaultPassword}`;
      break;
    }
  }

  const abapAlias = options.abapTokenAlias || 'sapAbapXsuaa';
  const abapTokenBlock = abapAlias
    ? `      source:
        type: serviceKey
        name: ${abapAlias}
      jsonPath: access_token
      auto: xsuaaToken`
    : `      source:
        type: serviceKey
        name: <abap-service-alias>
      jsonPath: access_token
      auto: xsuaaToken`;

  return `# Template: Direct SAP connection using JWT authentication
settingsPath: ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
${cfBlock}${serviceKeysSection}mcpConnection:
${connectionNameLine}  endpoint: ${endpoint}
  definition:
    type: ${connectionType}
    description: ${connectionDescription}
${mcpAuthSection}
abapConnection:
  mode: direct
  direct:
    url: ${abapUrl}
    client: ${abapClient}
  auth:
    type: jwt
    token:
${abapTokenBlock}
`;
}
function renderCloudInternetTemplate(options = {}) {
  const endpoint = options.mcpEndpoint || 'https://<your-approuter-host>/mcp/stream/http';
  const abapUrl = options.abapUrl || 'https://my.sap.system.example.com';
  const abapClient = options.abapClient || DEFAULT_ABAP_CLIENT;
  const serviceKeysSection = options.serviceKeysSection || '';
  const cfBlock = options.cfBlock || '';
  const connectionNameLine = options.connectionName ? `  name: ${options.connectionName}\n` : '';

  const mcpAlias = options.mcpTokenAlias || 'mcpXsuaa';
  const mcpTokenBlock = mcpAlias
    ? `      source:
        type: serviceKey
        name: ${mcpAlias}
      jsonPath: access_token
      auto: xsuaaToken`
    : `      source:
        type: serviceKey
        name: <xsuaa-service-alias>
      jsonPath: access_token
      auto: xsuaaToken`;

  const abapAlias = options.abapTokenAlias || 'sapAbap';
  const abapTokenBlock = abapAlias
    ? `      source:
        type: serviceKey
        name: ${abapAlias}
      jsonPath: access_token
      auto: xsuaaToken`
    : `      source:
        type: serviceKey
        name: <abap-service-alias>
      jsonPath: access_token
      auto: xsuaaToken`;

  return `# Template: Cloud deployment with direct ABAP URL (JWT)
settingsPath: ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
${cfBlock}${serviceKeysSection}mcpConnection:
${connectionNameLine}  endpoint: ${endpoint}
  definition:
    type: stream
    description: Cloud MCP → ABAP via direct URL
  auth:
    type: bearer
    token:
${mcpTokenBlock}
abapConnection:
  mode: direct
  direct:
    url: ${abapUrl}
    client: ${abapClient}
  auth:
    type: jwt
    token:
${abapTokenBlock}
`;
}

function renderCloudDestinationTemplate(options = {}) {
  const serviceKeysSection = options.serviceKeysSection || '';
  const cfBlock = options.cfBlock || '';
  const connectionNameLine = options.connectionName ? `  name: ${options.connectionName}\n` : '';
  const endpoint = options.mcpEndpoint || 'https://<your-approuter-host>/mcp/stream/sse';
  const mcpAlias = options.mcpTokenAlias || 'mcpXsuaa';
  const destinationName = options.destinationName || 'SAP_CLOUD_DEST';
  const mcpTokenBlock = mcpAlias
    ? `      source:
        type: serviceKey
        name: ${mcpAlias}
      jsonPath: access_token
      auto: xsuaaToken`
    : `      source:
        type: serviceKey
        name: <xsuaa-service-alias>
      jsonPath: access_token
      auto: xsuaaToken`;

  return `# Template: Cloud deployment with ABAP Destination service
settingsPath: ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
${cfBlock}${serviceKeysSection}mcpConnection:
${connectionNameLine}  endpoint: ${endpoint}
  definition:
    type: sse
    description: Cloud MCP → ABAP via Destination service
  auth:
    type: bearer
    token:
${mcpTokenBlock}
abapConnection:
  mode: destination
  destination:
    name: ${destinationName}
`;
}
function mergeConnections(primary, secondary) {
  if (!primary && !secondary) {
    return undefined;
  }
  const combineArray = [];
  const hasArray = Array.isArray(primary) || Array.isArray(secondary);
  if (hasArray) {
    if (Array.isArray(secondary)) {
      combineArray.push(...secondary);
    }
    if (Array.isArray(primary)) {
      combineArray.push(...primary);
    }
    return combineArray;
  }
  return { ...(secondary || {}), ...(primary || {}) };
}

function mergeObjects(base, override) {
  return { ...(base || {}), ...(override || {}) };
}

function isNewSchema(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    return false;
  }
  if ('mcpConnection' in rawConfig || 'abapConnection' in rawConfig || 'tools' in rawConfig) {
    return true;
  }
  if (!rawConfig.connections && (rawConfig.mcpConnection || rawConfig.abapConnection)) {
    return true;
  }
  return false;
}

function buildConnectionConfigFromNewSchema(rawConfig, connectionName) {
  const connection = {};
  const mcp = rawConfig.mcpConnection || {};
  const definition = cloneDeep(mcp.definition || {});
  const endpoint = mcp.endpoint || mcp.url || definition.endpoint;
  if (!endpoint) {
    throw new Error(`mcpConnection.endpoint (or definition.endpoint) is required for "${connectionName}".`);
  }
  definition.endpoint = endpoint;
  if (!definition.type && (mcp.type || mcp.transport)) {
    definition.type = mcp.type || mcp.transport;
  }
  if (mcp.description && !definition.description) {
    definition.description = mcp.description;
  }
  if (mcp.metadata && definition.metadata === undefined) {
    definition.metadata = cloneDeep(mcp.metadata);
  }
  connection.definition = definition;

  if (mcp.patch) {
    connection.patch = cloneDeep(mcp.patch);
  }
  if (rawConfig.patch) {
    connection.patch = mergeObjects(connection.patch, rawConfig.patch);
  }

  if (mcp.settingsPath) {
    connection.settingsPath = mcp.settingsPath;
  }

  let headers = {};
  if (rawConfig.headers && typeof rawConfig.headers === 'object') {
    headers = mergeObjects(headers, rawConfig.headers);
  }
  if (mcp.headers && typeof mcp.headers === 'object') {
    headers = mergeObjects(headers, mcp.headers);
  }

  if (mcp.auth) {
    connection.mcp = { auth: cloneDeep(mcp.auth) };
  } else {
    connection.mcp = {};
  }

  const abap = rawConfig.abapConnection || {};
  if (abap.patch) {
    connection.patch = mergeObjects(connection.patch, abap.patch);
  }

  const sap = {};
  const mode = abap.mode || (abap.destination ? 'destination' : undefined);
  if (mode) {
    sap.mode = mode;
  }

  if (abap.destination && typeof abap.destination === 'object') {
    if (abap.destination.name) {
      sap.destinationName = abap.destination.name;
    }
    if (abap.destination.connectivity) {
      sap.connectivity = cloneDeep(abap.destination.connectivity);
    }
  }

  const direct = abap.direct && typeof abap.direct === 'object' ? abap.direct : {};
  const directUrl = direct.url || abap.url;
  if (directUrl) {
    sap.url = directUrl;
  }

  const directClient = direct.client !== undefined ? direct.client : abap.client;
  if (directClient !== undefined) {
    sap.client = directClient;
  }

  const directLanguage = direct.language !== undefined ? direct.language : abap.language;
  if (directLanguage !== undefined) {
    sap.language = directLanguage;
  }

  const authSpec = abap.auth || direct.auth;
  if (authSpec) {
    sap.auth = cloneDeep(authSpec);
  }

  if (!sap.mode) {
    sap.mode = sap.destinationName ? 'destination' : 'direct';
  }

  if (abap.headers && typeof abap.headers === 'object') {
    headers = mergeObjects(headers, abap.headers);
  }

  const sapHasValues = Object.keys(sap).some((key) => sap[key] !== undefined);
  if (sapHasValues) {
    connection.sap = sap;
  }

  if (headers && Object.keys(headers).length > 0) {
    connection.headers = headers;
  }

  if (rawConfig.updateScope) {
    connection.updateScope = rawConfig.updateScope;
  }

  return connection;
}

function normalizeNewSchema(rawConfig, options = {}) {
  const configPath = options.configPath;
  const derivedName = configPath ? path.basename(configPath, path.extname(configPath)) : undefined;
  const candidate = options.primaryConnection || rawConfig.connectionName || (rawConfig.mcpConnection && rawConfig.mcpConnection.name) || derivedName;
  const connectionName = candidate ? String(candidate).trim() : undefined;

  if (!connectionName) {
    throw new Error('Unable to determine the MCP connection name. Provide --connection <name>, set mcpConnection.name, or rename the YAML file.');
  }

  const normalized = {
    settingsPath: rawConfig.settingsPath ?? rawConfig.mcpConnection?.settingsPath ?? rawConfig.tools?.settingsPath,
    serviceKeys: mergeObjects(rawConfig.serviceKeys, rawConfig.tools?.serviceKeys),
    cf: mergeObjects(rawConfig.cf, rawConfig.tools?.cf),
    defaults: rawConfig.defaults || {},
    connections: {}
  };

  normalized.connections[connectionName] = buildConnectionConfigFromNewSchema(rawConfig, connectionName);

  return normalized;
}

function normalizeRootConfig(rawConfig, options = {}) {
  if (isNewSchema(rawConfig)) {
    return normalizeNewSchema(rawConfig, options);
  }

  const cloudSection = rawConfig && typeof rawConfig.cloud === 'object' ? rawConfig.cloud : {};
  return {
    settingsPath: rawConfig.settingsPath ?? cloudSection.settingsPath,
    serviceKeys: mergeObjects(cloudSection.serviceKeys, rawConfig.serviceKeys),
    cf: mergeObjects(cloudSection.cf, rawConfig.cf),
    defaults: mergeObjects(cloudSection.defaults, rawConfig.defaults),
    connections: mergeConnections(rawConfig.connections, cloudSection.connections)
  };
}

function parseYamlArgs(argv) {
  const options = {
    dryRun: false,
    connectionFilters: [],
    primaryConnection: undefined,
    inlineServiceKeys: {},
    mcpApp: undefined,
    destinationName: undefined,
    mcpEndpoint: undefined,
    mcpType: undefined,
    mcpDescription: undefined,
    mcpAuthType: undefined,
    mcpAuthHeader: undefined,
    mcpUsername: undefined,
    mcpPassword: undefined,
    mcpToken: undefined
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--config':
      case '-c':
        options.configPath = argv[++i];
        break;
      case '--connection': {
        const value = argv[++i];
        if (value) {
          const names = value.split(',').map((item) => item.trim()).filter(Boolean);
          options.connectionFilters.push(...names);
          if (!options.primaryConnection && names.length) {
            options.primaryConnection = names[0];
          }
        }
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--service-key-file': {
        const value = argv[++i];
        if (!value) {
          console.error('❌  --service-key-file requires alias=/path/to/key.json.');
          process.exit(1);
        }
        const separator = value.indexOf('=');
        if (separator === -1) {
          console.error('❌  --service-key-file expects alias=/path/to/key.json.');
          process.exit(1);
        }
        const alias = value.slice(0, separator).trim();
        const rawPath = value.slice(separator + 1).trim();
        if (!alias || !rawPath) {
          console.error('❌  --service-key-file expects alias=/path/to/key.json.');
          process.exit(1);
        }
        const resolvedPath = path.resolve(process.cwd(), rawPath);
        options.inlineServiceKeys[alias] = {
          type: 'file',
          path: resolvedPath,
          templatePath: rawPath,
          origin: 'inline'
        };
        break;
      }
      case '--template-output':
      case '--template-out':
        options.templateOutput = argv[++i];
        break;
      case '--mcp-app':
        options.mcpApp = argv[++i];
        break;
      case '--mcp-endpoint':
        options.mcpEndpoint = argv[++i];
        break;
      case '--mcp-type':
      case '--mcp-transport':
        options.mcpType = argv[++i];
        break;
      case '--mcp-description':
        options.mcpDescription = argv[++i];
        break;
      case '--mcp-auth-type':
        options.mcpAuthType = argv[++i];
        break;
      case '--mcp-auth-header':
        options.mcpAuthHeader = argv[++i];
        break;
      case '--mcp-username':
        options.mcpUsername = argv[++i] ?? '';
        break;
      case '--mcp-password':
        options.mcpPassword = argv[++i] ?? '';
        break;
      case '--mcp-token':
        options.mcpToken = argv[++i];
        break;
      case '--destination-name':
        options.destinationName = argv[++i];
        if (!options.destinationName) {
          console.error('❌  --destination-name requires a value.');
          process.exit(1);
        }
        break;
      case '--template':
        options.templateName = argv[++i];
        break;
      case '--help':
      case '-h':
        printYamlHelp();
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('-') && !options.configPath) {
          options.configPath = arg;
        } else {
          console.warn(`⚠️  Ignoring unknown argument: ${arg}`);
        }
        break;
    }
  }

  if (!options.configPath && !options.templateName) {
    console.error('❌  Provide --config <path> to the YAML configuration file.');
    printYamlHelp();
    process.exit(1);
  }

  return options;
}

function printYamlHelp() {
  console.log(`Update Cline MCP settings using a declarative YAML plan

Usage: node scripts/update-cline-from-yaml.js --config <file> [options]

Options:
  --config, -c <file>    YAML descriptor with connection instructions (required)
  --connection <names>   Comma-separated subset of connection names to process
  --dry-run              Preview updates without writing files
  --service-key-file <alias=path>
                        Register an additional service key JSON file for template auto-fill
  --mcp-app <name>       Resolve MCP endpoint via cf env <name> when printing a template
  --mcp-endpoint <url>   Override the MCP endpoint in template output
  --mcp-type <type>      Override the MCP transport/type (e.g. streamableHttp | sse)
  --mcp-description <text>
                        Override the MCP connection description in templates
  --mcp-auth-type <type> Set MCP auth block (basic | header | bearer | jwt | none)
  --mcp-auth-header <value>
                        Authorization header value when using header auth
  --mcp-username <value> Username for MCP basic auth templates
  --mcp-password <value> Password for MCP basic auth templates (use "" for empty)
  --mcp-token <value>    Token value when using bearer/jwt auth templates
    --destination-name <name>
                          Override the ABAP destination name in cloud-destination templates
  --template <name>      Write a YAML template (${TEMPLATE_NAMES.join(' | ')}) and echo it
  --template-output <path>
                        When used with --template, override the output file (defaults to <connection>.yaml)
  --help, -h             Show this help message
`);
}

function determineTemplateOutputPath(templateName, cliOptions = {}) {
  if (cliOptions.templateOutput) {
    return cliOptions.templateOutput;
  }
  const connectionName = cliOptions.primaryConnection || (cliOptions.connectionFilters && cliOptions.connectionFilters[0]);
  if (connectionName) {
    return `${connectionName}.yaml`;
  }
  return undefined;
}

async function printTemplate(name, cliOptions = {}) {
  if (!name) {
    console.error('❌  Template name is required.');
    console.error(`Available templates: ${TEMPLATE_NAMES.join(', ')}`);
    process.exit(1);
  }
  const key = name.toLowerCase();
  const renderer = TEMPLATE_RENDERERS[key];
  if (!renderer) {
    console.error(`❌  Unknown template "${name}".`);
    console.error(`Available templates: ${TEMPLATE_NAMES.join(', ')}`);
    process.exit(1);
  }
  const derivedValues = await deriveTemplateValues(key, cliOptions);
  const connectionName = cliOptions.primaryConnection || (cliOptions.connectionFilters && cliOptions.connectionFilters[0]) || undefined;
  const serviceKeysSection = renderServiceKeysSection(derivedValues.serviceKeyDefinitions, derivedValues.placeholderServiceKeys);
  const cfBlock = renderCfSection(derivedValues.cfOptions);
  const content = renderer({
    cfBlock,
    serviceKeysSection,
    mcpEndpoint: derivedValues.mcpEndpoint || cliOptions.mcpEndpoint,
    mcpType: cliOptions.mcpType,
    mcpDescription: cliOptions.mcpDescription,
    mcpAuthType: cliOptions.mcpAuthType,
    mcpAuthHeader: cliOptions.mcpAuthHeader,
    mcpUsername: cliOptions.mcpUsername,
    mcpPassword: cliOptions.mcpPassword,
    mcpToken: cliOptions.mcpToken,
    abapUrl: derivedValues.abapUrl,
    abapClient: derivedValues.abapClient,
    mcpTokenAlias: derivedValues.mcpTokenAlias,
    abapTokenAlias: derivedValues.abapTokenAlias,
    connectionName,
    destinationName: derivedValues.abapDestinationName
  });
  const outputPath = determineTemplateOutputPath(name, cliOptions);
  if (!outputPath) {
    console.error('❌  Provide --connection <name> or --template-output <file> when using --template.');
    process.exit(1);
  }
  const finalContent = content.endsWith('\n') ? content : `${content}\n`;
  if (outputPath) {
    const resolvedPath = path.resolve(process.cwd(), outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, finalContent, 'utf8');
    const relativePath = path.relative(process.cwd(), resolvedPath) || resolvedPath;
    console.log(`✅  Template written to ${relativePath}`);
    console.log('   Adjust placeholders before running with --config.');
  } else {
    console.log(finalContent);
  }
}

function resolvePath(baseDir, targetPath) {
  if (!targetPath) {
    return undefined;
  }
  let normalized = targetPath;
  if (normalized === '~') {
    normalized = os.homedir();
  } else if (normalized.startsWith('~/')) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }
  return path.isAbsolute(normalized) ? normalized : path.resolve(baseDir, normalized);
}

async function readYamlFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return yaml.load(raw);
  } catch (error) {
    throw new Error(`Failed to read YAML config (${filePath}): ${error.message}`);
  }
}

async function readJsonFileYaml(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read ${filePath}: ${error.message}`);
  }
}

async function writeJsonFileYaml(filePath, data) {
  const formatted = `${JSON.stringify(data, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, formatted, 'utf8');
}

function extractJsonPath(target, jsonPath) {
  if (!jsonPath) {
    return target;
  }
  const segments = jsonPath.split('.').map((segment) => segment.trim()).filter(Boolean);
  let current = target;
  for (const segment of segments) {
    if (current === undefined || current === null) {
      return undefined;
    }
    if (Array.isArray(current) && /^[0-9]+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (typeof current === 'object') {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function cloneDeep(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

async function runCommand(command, args, options = {}) {
  const effectiveCommand = command;
  const effectiveArgs = Array.isArray(args) ? args : [];

  return new Promise((resolve, reject) => {
    const child = spawn(effectiveCommand, effectiveArgs, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell === true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    if (options.stdin !== undefined && options.stdin !== null) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString(options.encoding || 'utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString(options.encoding || 'utf8');
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command ${effectiveCommand} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}

async function loadServiceKey(alias, context) {
  if (context.serviceKeyCache.has(alias)) {
    return cloneDeep(context.serviceKeyCache.get(alias));
  }

  const definition = context.serviceKeys?.[alias];
  if (!definition) {
    throw new Error(`Service key alias "${alias}" is not defined in the YAML file.`);
  }

  let value;
  switch (definition.type) {
    case 'inline':
      value = definition.value ?? {};
      break;
    case 'file': {
      const filePath = resolvePath(context.configDir, definition.path);
      if (!filePath) {
        throw new Error(`Service key alias "${alias}" uses type file but path is missing.`);
      }
      const raw = await fs.readFile(filePath, 'utf8');
      value = JSON.parse(raw);
      break;
    }
    case 'cf': {
      const cfBinary = definition.binary || context.cf?.binary || 'cf';
      const instance = definition.instance;
      const key = definition.key;
      if (!instance || !key) {
        throw new Error(`Service key alias "${alias}" must provide instance and key for type cf.`);
      }
      const { stdout } = await runCommand(cfBinary, ['service-key', instance, key]);
      const firstBrace = stdout.indexOf('{');
      const lastBrace = stdout.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        throw new Error(`Unable to extract JSON from cf service-key output for alias "${alias}".`);
      }
      const json = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
      value = json.credentials ?? json;
      break;
    }
    default:
      throw new Error(`Unsupported service key type "${definition.type}" for alias "${alias}".`);
  }

  value = cloneDeep(value);
  context.serviceKeyCache.set(alias, value);
  return cloneDeep(value);
}

function normalizeServiceKeyCredentials(data) {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  if (data.clientid && data.clientsecret) {
    return data;
  }
  if (data.credentials && typeof data.credentials === 'object') {
    const nested = data.credentials;
    if (nested.clientid && nested.clientsecret) {
      return nested;
    }
  }
  if (data.uaa && typeof data.uaa === 'object') {
    const uaa = { ...data.uaa };
    if (uaa.clientid && uaa.clientsecret) {
      if (!uaa.tokenurl && uaa.url) {
        uaa.tokenurl = uaa.url;
      }
      if (!uaa.url && data.url) {
        uaa.url = data.url;
      }
      return uaa;
    }
  }
  return data;
}

function buildXsuaaTokenUrl(credentials) {
  const rawUrl = credentials.tokenurl || credentials.token_url || credentials.oauthTokenUrl || credentials.oauth_token_url || credentials.url;
  if (!rawUrl) {
    throw new Error('XSUAA service key is missing token URL.');
  }
  const base = rawUrl.endsWith('/oauth/token') ? rawUrl : `${rawUrl.replace(/\/$/u, '')}/oauth/token`;
  return base;
}

async function fetchXsuaaToken(credentials, options = {}) {
  const tokenUrl = new URL(buildXsuaaTokenUrl(credentials));
  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  if (options.scope) {
    params.set('scope', options.scope);
  }
  const auth = Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`, 'utf8').toString('base64');

  const requestOptions = {
    method: 'POST',
    hostname: tokenUrl.hostname,
    port: tokenUrl.port || 443,
    path: `${tokenUrl.pathname}${tokenUrl.search}`,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };

  const body = params.toString();

  return new Promise((resolve, reject) => {
    const req = https.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Token request failed with status ${res.statusCode}: ${responseBody}`));
          return;
        }
        try {
          const json = JSON.parse(responseBody);
          resolve(json.access_token);
        } catch (error) {
          reject(new Error(`Unable to parse XSUAA token response: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function resolveSource(source, context, options = {}) {
  if (!source || typeof source !== 'object') {
    throw new Error('Value source must be an object.');
  }

  switch (source.type) {
    case 'const':
    case 'literal':
      return source.value;
    case 'env':
      return process.env[source.name];
    case 'file': {
      const filePath = resolvePath(context.configDir, source.path);
      if (!filePath) {
        throw new Error('File source requires a path.');
      }
      const raw = await fs.readFile(filePath, source.encoding || 'utf8');
      if (source.json === true) {
        return JSON.parse(raw);
      }
      return raw;
    }
    case 'serviceKey': {
      if (!source.name) {
        throw new Error('serviceKey source requires a name property.');
      }
  const keyData = await loadServiceKey(source.name, context);
  return source.clone === true ? cloneDeep(keyData) : keyData;
    }
    case 'command': {
      if (!source.command) {
        throw new Error('command source requires a command property.');
      }
      let stdin;
      if (source.stdin) {
        if (source.stdin.type === 'serviceKey') {
          const keyData = await loadServiceKey(source.stdin.name, context);
          stdin = JSON.stringify(keyData);
        } else if (source.stdin.type === 'file') {
          const stdinPath = resolvePath(context.configDir, source.stdin.path);
          stdin = await fs.readFile(stdinPath, source.stdin.encoding || 'utf8');
        } else if (source.stdin.type === 'value') {
          stdin = String(source.stdin.value ?? '');
        } else {
          throw new Error(`Unsupported stdin type for command source: ${source.stdin.type}`);
        }
      }
      const env = source.env ? { ...process.env, ...source.env } : process.env;
      const { stdout } = await runCommand(source.command, source.args || [], {
        cwd: source.cwd ? resolvePath(context.configDir, source.cwd) : undefined,
        env,
        shell: source.shell === true,
        stdin
      });
      if (source.json === true) {
        return JSON.parse(stdout);
      }
      return stdout;
    }
    default:
      throw new Error(`Unsupported source type: ${source.type}`);
  }
}

async function resolveString(spec, context, options = {}) {
  if (spec === undefined || spec === null) {
    if (options.required) {
      throw new Error(`Missing required value for ${options.name || 'unknown field'}.`);
    }
    return undefined;
  }

  const allowEmpty = options.allowEmpty === true;

  if (typeof spec === 'string' || typeof spec === 'number' || typeof spec === 'boolean') {
    const raw = String(spec);
    const trimmed = options.trim === false ? raw : raw.trim();
    if (options.required && !allowEmpty && !trimmed) {
      throw new Error(`Value for ${options.name || 'unknown field'} cannot be empty.`);
    }
    return options.trim === false ? raw : trimmed;
  }

  if (typeof spec !== 'object') {
    throw new Error(`Unsupported value specification for ${options.name || 'unknown field'}.`);
  }

  if (spec.value !== undefined && spec.source === undefined) {
    return resolveString(spec.value, context, options);
  }

  if (!spec.source) {
    throw new Error(`Value specification for ${options.name || 'unknown field'} must include a source.`);
  }

  const raw = await resolveSource(spec.source, context, options);
  let resolved = raw;

  if (spec.jsonPath) {
    let target = resolved;
    if (typeof target === 'string') {
      target = JSON.parse(target);
    }
    resolved = extractJsonPath(target, spec.jsonPath);
  }

  if ((resolved === undefined || resolved === null) && spec.source?.type === 'serviceKey') {
    const credentials = normalizeServiceKeyCredentials(raw);
    const wantsXsuaaToken = (spec.auto && spec.auto === 'xsuaaToken') || (!spec.auto && spec.jsonPath && spec.jsonPath.toLowerCase().includes('access_token'));
    if (wantsXsuaaToken && credentials && credentials.clientid && credentials.clientsecret) {
      try {
        resolved = await fetchXsuaaToken(credentials, spec.tokenOptions || {});
      } catch (error) {
        if (options.required) {
          throw new Error(`Failed to fetch XSUAA token for ${options.name || 'unknown field'}: ${error.message}`);
        }
        resolved = undefined;
      }
    }
  }

  if (resolved === undefined || resolved === null) {
    if (options.required) {
      throw new Error(`Resolved value for ${options.name || 'unknown field'} is empty.`);
    }
    return undefined;
  }

  if (typeof resolved === 'object') {
    if (spec.stringify === true) {
      resolved = JSON.stringify(resolved);
    } else {
      throw new Error(`Resolved value for ${options.name || 'unknown field'} is an object; set stringify: true if you need JSON text.`);
    }
  }

  let text = String(resolved);
  if (spec.trim !== false) {
    text = text.trim();
  }
  if (spec.decode === 'base64') {
    text = Buffer.from(text, 'base64').toString('utf8');
  }
  if (spec.prefix) {
    text = `${spec.prefix}${text}`;
  }
  if (spec.suffix) {
    text = `${text}${spec.suffix}`;
  }

  if (options.required && !allowEmpty && !text) {
    throw new Error(`Resolved value for ${options.name || 'unknown field'} cannot be empty.`);
  }

  return text;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /^https?:\/\//i.test(value.trim());
}

function pickUrlCandidate(value) {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return isHttpUrl(trimmed) ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = pickUrlCandidate(entry);
      if (candidate) {
        return candidate;
      }
    }
  }
  return undefined;
}

function extractAbapUrl(target) {
  return pickUrlCandidate(extractJsonPath(target, ABAP_URL_PATH));
}

function getTemplateEndpointSuffix(templateName) {
  return TEMPLATE_ENDPOINT_SUFFIX[templateName] || '';
}

function combineEndpoint(baseUrl, suffix) {
  if (!baseUrl) {
    return undefined;
  }
  if (!suffix) {
    return baseUrl;
  }
  const normalizedBase = baseUrl.replace(/\/+$/u, '');
  if (normalizedBase.includes('/mcp/stream')) {
    return normalizedBase;
  }
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (normalizedBase.endsWith(normalizedSuffix)) {
    return normalizedBase;
  }
  return `${normalizedBase}${normalizedSuffix}`;
}

async function buildTemplateServiceKeyContext(cliOptions) {
  let configDir = process.cwd();
  let serviceKeys = {};
  let cf = {};

  if (cliOptions.configPath) {
    const resolvedConfigPath = path.resolve(process.cwd(), cliOptions.configPath);
    const rawConfig = await readYamlFile(resolvedConfigPath);
    const rootConfig = normalizeRootConfig(rawConfig, {
      configPath: resolvedConfigPath,
      primaryConnection: cliOptions.primaryConnection
    });
    configDir = path.dirname(resolvedConfigPath);
    serviceKeys = rootConfig.serviceKeys || {};
    cf = rootConfig.cf || {};
  }

  if (cliOptions.inlineServiceKeys && Object.keys(cliOptions.inlineServiceKeys).length > 0) {
    serviceKeys = { ...serviceKeys };
    for (const [alias, definition] of Object.entries(cliOptions.inlineServiceKeys)) {
      serviceKeys[alias] = definition;
    }
  }

  return {
    configDir,
    serviceKeys,
    serviceKeyCache: new Map(),
    cf
  };
}

function extractBalancedJson(text, startIndex) {
  if (startIndex === -1) {
    return undefined;
  }
  let depth = 0;
  let endBrace = -1;
  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        endBrace = i;
        break;
      }
    }
  }
  if (endBrace === -1) {
    return undefined;
  }
  return text.slice(startIndex, endBrace + 1);
}

function parseCfEnvSection(text, label) {
  const labelIndex = text.indexOf(`${label}:`);
  if (labelIndex === -1) {
    return undefined;
  }
  const startBrace = text.indexOf('{', labelIndex);
  if (startBrace === -1) {
    return undefined;
  }
  const jsonText = extractBalancedJson(text, startBrace);
  if (!jsonText) {
    return undefined;
  }
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    console.warn(`⚠️  Failed to parse ${label} section: ${error.message}`);
    return undefined;
  }
}

function parseCfEnvTextOutput(text) {
  if (!text || typeof text !== 'string') {
    return undefined;
  }
  const result = {};
  const services = parseCfEnvSection(text, 'VCAP_SERVICES');
  if (services) {
    result.VCAP_SERVICES = services;
  }
  const application = parseCfEnvSection(text, 'VCAP_APPLICATION');
  if (application) {
    result.VCAP_APPLICATION = application;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function fetchCfAppEnv(appName, context) {
  if (!appName) {
    return undefined;
  }
  const cfBinary = context.cf?.binary || 'cf';
  const { stdout } = await runCommand(cfBinary, ['env', appName]);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    data = parseCfEnvTextOutput(stdout);
  }
  if (!data) {
    throw new Error(`Unable to parse cf env ${appName} output.`);
  }
  return {
    data,
    binary: cfBinary
  };
}

function normalizeApplicationUri(uri) {
  if (!uri || typeof uri !== 'string') {
    return undefined;
  }
  const trimmed = uri.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function guessAppNameFromServiceKeyCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') {
    return undefined;
  }
  const rawCandidates = [];
  const pushCandidate = (value) => {
    if (value && typeof value === 'string') {
      rawCandidates.push(value);
    }
  };

  pushCandidate(credentials.xsappname);
  pushCandidate(credentials.clientid);
  if (credentials.uaa && typeof credentials.uaa === 'object') {
    pushCandidate(credentials.uaa.xsappname);
    pushCandidate(credentials.uaa.clientid);
  }

  for (const raw of rawCandidates) {
    const withoutTenant = raw.split('!')[0];
    const withoutPrefix = withoutTenant.replace(/^sb-/i, '');
    const parts = withoutPrefix.split('-').filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const remaining = parts.length - index;
      if (remaining < 5) {
        continue;
      }
      const [p1, p2, p3, p4, p5] = parts.slice(index, index + 5);
      const looksLikeGuid =
        /^[0-9a-f]{8}$/i.test(p1) &&
        /^[0-9a-f]{4}$/i.test(p2) &&
        /^[0-9a-f]{4}$/i.test(p3) &&
        /^[0-9a-f]{4}$/i.test(p4) &&
        /^[0-9a-f]{12}$/i.test(p5);
      if (looksLikeGuid && index > 0) {
        const nameParts = parts.slice(0, index);
        if (nameParts.length > 0) {
          const base = nameParts.join('-');
          if (base.endsWith('-srv')) {
            return base;
          }
          return `${base}-srv`;
        }
      }
    }
  }

  return undefined;
}

function findServiceEntry(vcapServices, keywords, fallbackPredicate) {
  if (!vcapServices || typeof vcapServices !== 'object') {
    return undefined;
  }
  const lowerKeywords = (keywords || []).map((keyword) => String(keyword).toLowerCase());
  for (const [label, entries] of Object.entries(vcapServices)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const text = [
        label,
        entry?.name,
        entry?.service_instance_name,
        Array.isArray(entry?.tags) ? entry.tags.join(' ') : undefined,
        entry?.plan
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (lowerKeywords.some((keyword) => text.includes(keyword))) {
        return { label, entry };
      }
    }
  }
  if (typeof fallbackPredicate === 'function') {
    for (const [label, entries] of Object.entries(vcapServices)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        if (fallbackPredicate(entry, label)) {
          return { label, entry };
        }
      }
    }
  }
  return undefined;
}

async function deriveTemplateValues(templateName, cliOptions) {
  const context = await buildTemplateServiceKeyContext(cliOptions);
  const aliasHints = TEMPLATE_ALIAS_HINTS[templateName] || {};
  const requirements = TEMPLATE_TOKEN_REQUIREMENTS[templateName] || {};
  const configuredAliases = Object.keys(context.serviceKeys || {});
  const inlineAliases = Object.keys(cliOptions.inlineServiceKeys || {});
  const aliasPool = dedupeAliases([...inlineAliases, ...configuredAliases]);
  const usedAliases = new Set();

  function chooseAlias(hints = [], keywords = [], excludeKeywords = []) {
    const remainingPool = aliasPool.filter((alias) => !usedAliases.has(alias));
    const filteredPool = excludeKeywords && excludeKeywords.length
      ? remainingPool.filter((alias) => {
          const lower = alias.toLowerCase();
          return !excludeKeywords.some((keyword) => lower.includes(keyword));
        })
      : remainingPool;
    const poolToUse = filteredPool.length > 0 ? filteredPool : remainingPool;
    const keywordMatches = keywords && keywords.length
      ? poolToUse.filter((alias) => {
          const lower = alias.toLowerCase();
          return keywords.some((keyword) => lower.includes(keyword));
        })
      : poolToUse.slice();

    if (keywordMatches.length === 1) {
      const match = keywordMatches[0];
      usedAliases.add(match);
      return match;
    }

    if (keywordMatches.length > 1) {
      const candidate = determineTokenAlias({
        preferred: keywordMatches,
        available: hints,
        keywords
      });
      if (candidate) {
        usedAliases.add(candidate);
        return candidate;
      }
    }

    if (poolToUse.length === 1) {
      const onlyAlias = poolToUse[0];
      usedAliases.add(onlyAlias);
      return onlyAlias;
    }

    if (hints && hints.length) {
      const candidate = determineTokenAlias({
        preferred: [],
        available: hints,
        keywords
      });
      if (candidate) {
        usedAliases.add(candidate);
        return candidate;
      }
      if (hints.length > 0) {
        const fallback = hints[0];
        usedAliases.add(fallback);
        return fallback;
      }
    }

    return undefined;
  }

  const mcpAlias = (requirements.mcp || (aliasHints.mcp && aliasHints.mcp.length))
    ? chooseAlias(aliasHints.mcp || [], ['mcp', 'xsuaa', 'proxy', 'auth'], ['abap', 'backend'])
    : undefined;
  const abapAlias = (requirements.abap || (aliasHints.abap && aliasHints.abap.length))
    ? chooseAlias(aliasHints.abap || [], ['abap', 'sap', 'backend', 's4'], ['mcp', 'xsuaa', 'proxy', 'auth'])
    : undefined;

  const relevantAliases = new Set([mcpAlias, abapAlias].filter(Boolean));
  const serviceKeyDefinitions = {};
  for (const alias of relevantAliases) {
    if (alias && context.serviceKeys[alias]) {
      serviceKeyDefinitions[alias] = context.serviceKeys[alias];
    }
  }

  const placeholderServiceKeys = {};

  const isCloudTemplate = templateName === 'cloud-internet' || templateName === 'cloud-destination';
  let mcpEndpoint;
  let abapUrl;
  let detectedXsuaaInstance;
  let detectedAbapInstance;
  let cfBinary = context.cf?.binary || 'cf';
  const cfAppCandidates = [];
  if (cliOptions.mcpApp) {
    cfAppCandidates.push(cliOptions.mcpApp);
  }
  if (context.cf?.app) {
    cfAppCandidates.push(context.cf.app);
  }
  let guessedCfAppName;
  let cfAppName;
  let cfAppData;
  const destinationOverride = cliOptions.destinationName;
  const cfDestinationName = context.cf?.destination?.name || context.cf?.destinationName || context.cf?.destination;

  async function tryLoadKey(alias) {
    if (!alias || !context.serviceKeys[alias]) {
      return undefined;
    }
    try {
      return await loadServiceKey(alias, context);
    } catch (error) {
      console.warn(`⚠️  Failed to load service key "${alias}": ${error.message}`);
      return undefined;
    }
  }

  if (mcpAlias) {
    const data = await tryLoadKey(mcpAlias);
    if (data) {
      if (isCloudTemplate) {
        const guessed = guessAppNameFromServiceKeyCredentials(data);
        if (guessed) {
          guessedCfAppName = guessedCfAppName || guessed;
          cfAppCandidates.push(guessed);
        }
      }
    }
  }

  if (abapAlias) {
    const data = await tryLoadKey(abapAlias);
    if (data) {
      const url = extractAbapUrl(data);
      if (url) {
        abapUrl = url;
      }
    }
  }

  if (isCloudTemplate) {
    const candidates = dedupeAliases(cfAppCandidates.filter(Boolean));
    for (const candidate of candidates) {
      try {
        const envInfo = await fetchCfAppEnv(candidate, context);
        cfAppName = candidate;
        cfAppData = envInfo?.data;
        if (envInfo?.binary) {
          cfBinary = envInfo.binary;
        }
        break;
      } catch (error) {
        console.warn(`⚠️  cf env ${candidate} failed: ${error.message}`);
      }
    }
    if (!cfAppName && candidates.length > 0) {
      cfAppName = candidates[0];
    }
  }

  if (cfAppData) {
    const applicationUris = cfAppData?.VCAP_APPLICATION?.application_uris;
    const appUri = Array.isArray(applicationUris) ? applicationUris.find((item) => typeof item === 'string' && item.trim().length > 0) : undefined;
    if (appUri) {
      const normalized = normalizeApplicationUri(appUri);
      if (normalized) {
        mcpEndpoint = combineEndpoint(normalized, getTemplateEndpointSuffix(templateName));
      }
    }

    const xsuaaInfo = findServiceEntry(cfAppData?.VCAP_SERVICES, ['xsuaa', 'auth']);
    if (xsuaaInfo) {
      detectedXsuaaInstance = xsuaaInfo.entry?.name || xsuaaInfo.entry?.service_instance_name;
    }

    const abapInfo = findServiceEntry(
      cfAppData?.VCAP_SERVICES,
      ['abap'],
      (entry, label) => {
        const urlCandidate = entry?.credentials?.url || entry?.credentials?.uri;
        return Boolean(urlCandidate && String(urlCandidate).toLowerCase().includes('.abap.')) || String(label).toLowerCase().includes('abap');
      }
    );
    if (abapInfo) {
      detectedAbapInstance = abapInfo.entry?.name || abapInfo.entry?.service_instance_name;
      if (!abapUrl) {
        const candidate = extractAbapUrl(abapInfo.entry?.credentials || {});
        if (candidate) {
          abapUrl = candidate;
        }
      }
    }
  }

  if (cliOptions.mcpEndpoint) {
    mcpEndpoint = cliOptions.mcpEndpoint;
  }

  if (mcpAlias && !serviceKeyDefinitions[mcpAlias]) {
    placeholderServiceKeys[mcpAlias] = {
      type: 'cf',
      instance: detectedXsuaaInstance || '<xsuaa-instance-name>',
      key: '<service-key-name>'
    };
  }

  if (abapAlias && !serviceKeyDefinitions[abapAlias]) {
    placeholderServiceKeys[abapAlias] = {
      type: 'cf',
      instance: detectedAbapInstance || '<abap-service-instance>',
      key: '<service-key-name>'
    };
  }

  const cfOptions = {};
  if (isCloudTemplate) {
    cfOptions.app = cfAppName || guessedCfAppName || '<cf-app-name>';
    if (cfBinary && cfBinary !== 'cf') {
      cfOptions.binary = cfBinary;
    }
  }

  const abapClient = DEFAULT_ABAP_CLIENT;

  return {
    serviceKeyDefinitions,
    placeholderServiceKeys,
    mcpTokenAlias: mcpAlias,
    abapTokenAlias: abapAlias,
    mcpEndpoint,
    abapUrl,
    cfOptions,
    abapDestinationName: destinationOverride || cfDestinationName,
    abapClient
  };
}

function setHeaderValue(headers, key, value, updated) {
  const canonicalKey = canonicalizeHeaderName(key);
  const normalizedKey = canonicalKey ? canonicalKey.toLowerCase() : key.toLowerCase();
  const existingKey = Object.keys(headers).find((candidate) => candidate.toLowerCase() === normalizedKey);

  if (typeof value === 'string' && value.length > 0) {
    if (existingKey && existingKey !== canonicalKey) {
      delete headers[existingKey];
    }
    for (const candidate of Object.keys(headers)) {
      if (candidate !== canonicalKey && candidate.toLowerCase() === normalizedKey) {
        delete headers[candidate];
      }
    }
    headers[canonicalKey] = value;
    if (!updated.includes(canonicalKey)) {
      updated.push(canonicalKey);
    }
  } else if (existingKey) {
    delete headers[existingKey];
    if (!updated.includes(existingKey)) {
      updated.push(existingKey);
    }
  }
}

function removeSapDirectHeaders(headers, updated) {
  ['x-sap-url', 'x-sap-client', 'x-sap-auth-type', 'x-sap-jwt-token', 'x-sap-username', 'x-sap-password'].forEach((key) => {
    setHeaderValue(headers, key, undefined, updated);
  });
}

function removeDestinationHeaders(headers, updated) {
  ['x-sap-destination', 'x-sap-connectivity-mode', 'x-sap-connectivity-location-id'].forEach((key) => {
    setHeaderValue(headers, key, undefined, updated);
  });
}

function convertDefinitionToClineConnection(definition = {}, connectionConfig = {}) {
  const result = {};
  const endpoint = definition.endpoint || definition.url || connectionConfig.url || connectionConfig.endpoint;
  if (endpoint) {
    result.url = endpoint;
  }

  const rawType = definition.transport || definition.type || connectionConfig.transport || connectionConfig.type;
  if (rawType) {
    const normalized = String(rawType).toLowerCase();
    if (normalized === 'sse') {
      result.type = 'sse';
    } else if (normalized.includes('stream') || normalized.includes('http')) {
      result.type = 'streamableHttp';
    } else {
      result.type = rawType;
    }
  } else {
    result.type = 'streamableHttp';
  }

  if (definition.description || connectionConfig.description) {
    result.description = definition.description ?? connectionConfig.description;
  }

  const timeout = definition.timeout ?? connectionConfig.timeout;
  result.timeout = timeout !== undefined ? timeout : 60;

  const disabled = definition.disabled ?? connectionConfig.disabled;
  if (disabled !== undefined) {
    result.disabled = Boolean(disabled);
  } else {
    result.disabled = true;
  }

  if (definition.headers && typeof definition.headers === 'object') {
    result.headers = cloneDeep(definition.headers);
  }

  return result;
}

async function applyCustomHeaders(headers, headerSpec, context, options) {
  const updated = [];
  const entries = Object.entries(headerSpec || {});
  for (const [key, valueSpec] of entries) {
    if (valueSpec === null) {
      setHeaderValue(headers, key, undefined, updated);
      continue;
    }
    const value = await resolveString(valueSpec, context, { name: `${options.connection}.headers.${key}` });
    if (value === undefined) {
      continue;
    }
    setHeaderValue(headers, key, value, updated);
  }
  return updated;
}

function resolveSapMode(sapConfig, connectionName) {
  const explicit = sapConfig.mode ? String(sapConfig.mode).toLowerCase() : undefined;
  const hasDestinationSignals = Boolean(
    sapConfig.destinationName ?? sapConfig.destination?.name ?? sapConfig.destination ?? sapConfig.connectivityMode ?? sapConfig.connectivityLocationId ?? sapConfig.connectivity
  );
  const hasDirectSignals = Boolean(
    sapConfig.url ?? sapConfig.auth ?? sapConfig.client ?? sapConfig.language
  );

  if (explicit && !['direct', 'destination'].includes(explicit)) {
    throw new Error(`Connection "${connectionName}" uses unsupported sap.mode "${sapConfig.mode}".`);
  }

  if (explicit === 'destination') {
    if (hasDirectSignals) {
      throw new Error(`Connection "${connectionName}" cannot combine sap.mode=destination with direct SAP parameters (url/auth/client).`);
    }
    return 'destination';
  }

  if (explicit === 'direct') {
    if (hasDestinationSignals) {
      throw new Error(`Connection "${connectionName}" cannot combine sap.mode=direct with destination-specific parameters.`);
    }
    return 'direct';
  }

  if (hasDestinationSignals && hasDirectSignals) {
    throw new Error(`Connection "${connectionName}" mixes direct SAP parameters with destination configuration. Set sap.mode explicitly or remove the conflicting values.`);
  }

  return hasDestinationSignals ? 'destination' : 'direct';
}

async function buildSapDirectConfig(sapConfig, context, options) {
  const env = {};
  env.SAP_URL = await resolveString(sapConfig.url, context, {
    required: true,
    name: `${options.connection}.sap.url`
  });
  if (sapConfig.client !== undefined) {
    env.SAP_CLIENT = await resolveString(sapConfig.client, context, {
      name: `${options.connection}.sap.client`
    });
  }
  env.SAP_AUTH_TYPE = sapConfig.auth?.type ? String(sapConfig.auth.type).toLowerCase() : 'jwt';

  const overrides = {
    authType: env.SAP_AUTH_TYPE
  };

  if (env.SAP_AUTH_TYPE === 'basic') {
    env.SAP_USERNAME = await resolveString(sapConfig.auth?.username, context, {
      required: true,
      name: `${options.connection}.sap.auth.username`
    });
    env.SAP_PASSWORD = await resolveString(sapConfig.auth?.password, context, {
      required: true,
      name: `${options.connection}.sap.auth.password`
    });
    overrides.username = env.SAP_USERNAME;
    overrides.password = env.SAP_PASSWORD;
    env.SAP_JWT_TOKEN = undefined;
  } else {
    env.SAP_JWT_TOKEN = await resolveString(sapConfig.auth?.token, context, {
      required: true,
      name: `${options.connection}.sap.auth.token`
    });
    overrides.token = env.SAP_JWT_TOKEN;
    env.SAP_USERNAME = undefined;
    env.SAP_PASSWORD = undefined;
  }

  if (sapConfig.language !== undefined) {
    env.SAP_LANGUAGE = await resolveString(sapConfig.language, context, {
      name: `${options.connection}.sap.language`
    });
  }

  return { env, overrides };
}

async function handleSapConfiguration(connectionConfig, connectionState, context, options) {
  const updated = [];
  const scope = options.scope;

  if (scope !== 'sap' && scope !== 'all') {
    return updated;
  }

  if (!connectionConfig.sap) {
    throw new Error(`Connection "${options.connection}" requires a sap section for update scope ${scope}.`);
  }

  const mode = resolveSapMode(connectionConfig.sap, options.connection);

  if (mode === 'destination') {
    removeSapDirectHeaders(connectionState.headers, updated);
    const destinationName = await resolveString(connectionConfig.sap.destinationName ?? connectionConfig.sap.destination?.name, context, {
      required: true,
      name: `${options.connection}.sap.destination.name`
    });
    const connectivityMode = await resolveString(connectionConfig.sap.connectivityMode ?? connectionConfig.sap.destination?.connectivityMode ?? connectionConfig.sap.connectivity?.mode, context, {
      name: `${options.connection}.sap.connectivity.mode`
    });
    const locationId = await resolveString(connectionConfig.sap.connectivityLocationId ?? connectionConfig.sap.destination?.connectivityLocationId ?? connectionConfig.sap.connectivity?.locationId, context, {
      name: `${options.connection}.sap.connectivity.locationId`
    });
    const destUpdated = applyDestinationHeaders(connectionState.headers, {
      destinationName,
      connectivityMode: connectivityMode || undefined,
      connectivityLocationId: locationId || undefined
    });
    updated.push(...destUpdated);
  } else if (mode === 'direct') {
    removeDestinationHeaders(connectionState.headers, updated);
    const { env, overrides } = await buildSapDirectConfig(connectionConfig.sap, context, options);
    const result = applySapConfigToHeaders(connectionState.headers, env, overrides);
    updated.push(...result.updated);
  } else {
    throw new Error(`Unsupported sap.mode "${mode}" for connection "${options.connection}".`);
  }

  return updated;
}

async function handleMcpConfiguration(connectionConfig, connectionState, context, options) {
  const updated = [];
  const scope = options.scope;

  if (scope !== 'mcp' && scope !== 'all') {
    return updated;
  }

  const authConfig = connectionConfig.mcp?.auth;
  if (!authConfig) {
    return updated;
  }

  const type = authConfig.type ? String(authConfig.type).toLowerCase() : 'none';
  const authOptions = {};

  switch (type) {
    case 'header':
      authOptions.authHeader = await resolveString(authConfig.header ?? authConfig.value, context, {
        required: true,
        name: `${options.connection}.mcp.auth.header`
      });
      break;
    case 'basic':
      authOptions.authType = 'basic';
      authOptions.username = await resolveString(authConfig.username, context, {
        required: true,
        name: `${options.connection}.mcp.auth.username`
      });
      authOptions.password = await resolveString(authConfig.password, context, {
        required: true,
        allowEmpty: true,
        name: `${options.connection}.mcp.auth.password`
      });
      break;
    case 'bearer':
    case 'jwt':
      authOptions.authType = 'jwt';
      authOptions.token = await resolveString(authConfig.token, context, {
        required: true,
        name: `${options.connection}.mcp.auth.token`
      });
      break;
    case 'none':
      authOptions.authType = 'none';
      break;
    default:
      throw new Error(`Unsupported MCP auth type "${type}" for connection "${options.connection}".`);
  }

    const mcpUpdated = applyMcpAuth(connectionState.headers, authOptions);
    updated.push(...mcpUpdated);

  return updated;
}

function ensureConnection(settings, connectionName, connectionConfig) {
  settings.mcpServers = settings.mcpServers ?? {};
  const definition = connectionConfig?.definition ? cloneDeep(connectionConfig.definition) : {};
  const desiredBase = convertDefinitionToClineConnection(definition, connectionConfig);
  let connection = settings.mcpServers[connectionName];
  let created = false;

  if (!connection) {
    connection = desiredBase;
    connection.headers = connection.headers ?? {};
    settings.mcpServers[connectionName] = connection;
    created = true;
  } else {
    if (desiredBase.url) {
      connection.url = desiredBase.url;
    }
    if (desiredBase.type) {
      connection.type = desiredBase.type;
    }
    if (desiredBase.description !== undefined) {
      connection.description = desiredBase.description;
    }
    const explicitTimeout = connectionConfig.definition?.timeout !== undefined || connectionConfig.timeout !== undefined;
    if (explicitTimeout || connection.timeout === undefined) {
      if (desiredBase.timeout !== undefined) {
        connection.timeout = desiredBase.timeout;
      }
    }
    const explicitDisabled = connectionConfig.definition?.disabled !== undefined || connectionConfig.disabled !== undefined;
    if ((explicitDisabled || connection.disabled === undefined) && desiredBase.disabled !== undefined) {
      connection.disabled = desiredBase.disabled;
    }
    if (!connection.headers) {
      connection.headers = {};
    }
  }

  if (connection.endpoint && !connection.url) {
    connection.url = connection.endpoint;
    delete connection.endpoint;
  }

  return { connection, created };
}

async function applyConnectionPatch(connection, patchSpec, context, options) {
  if (!patchSpec || typeof patchSpec !== 'object') {
    return;
  }
  for (const [key, valueSpec] of Object.entries(patchSpec)) {
    if (key === 'headers') {
      continue;
    }
    if (valueSpec === null) {
      delete connection[key];
      continue;
    }
    if (valueSpec && typeof valueSpec === 'object' && ('source' in valueSpec || 'value' in valueSpec)) {
      connection[key] = await resolveString(valueSpec, context, {
        name: `${options.connection}.patch.${key}`
      });
    } else {
      connection[key] = cloneDeep(valueSpec);
    }
  }
}

function determineScope(connectionConfig, rootConfig) {
  const scope = connectionConfig.updateScope || rootConfig.defaults?.updateScope || 'all';
  const normalized = String(scope).toLowerCase();
  if (!['all', 'sap', 'mcp'].includes(normalized)) {
    throw new Error(`Invalid update scope "${scope}".`);
  }
  return normalized;
}

function selectConnections(rootConfig, filters) {
  const entries = [];
  if (!rootConfig.connections) {
    return entries;
  }

  if (Array.isArray(rootConfig.connections)) {
    for (const item of rootConfig.connections) {
      if (!item || typeof item !== 'object' || !item.name) {
        throw new Error('Connections array entries must include a name property.');
      }
      if (filters.length === 0 || filters.includes(item.name)) {
        entries.push([item.name, item]);
      }
    }
  } else {
    for (const [name, config] of Object.entries(rootConfig.connections)) {
      if (filters.length === 0 || filters.includes(name)) {
        entries.push([name, config || {}]);
      }
    }
  }

  return entries;
}

function resolveSettingsPath(connectionConfig, rootConfig, context) {
  const candidate = connectionConfig.settingsPath || rootConfig.settingsPath;
  return candidate ? resolvePath(context.configDir, candidate) : getDefaultSettingsPath();
}

async function mainYaml() {
  const cli = parseYamlArgs(process.argv.slice(2));
  if (cli.templateName) {
    await printTemplate(cli.templateName, cli);
    if (!cli.configPath) {
      return;
    }
  }

  if (!cli.configPath) {
    throw new Error('Configuration path is required when no template is requested.');
  }

  const configPath = path.resolve(process.cwd(), cli.configPath);
  const rawConfig = await readYamlFile(configPath);
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('YAML configuration must produce an object at the top level.');
  }

  const rootConfig = normalizeRootConfig(rawConfig, {
    configPath,
    primaryConnection: cli.primaryConnection
  });

  const combinedServiceKeys = { ...(rootConfig.serviceKeys || {}) };
  if (cli.inlineServiceKeys && Object.keys(cli.inlineServiceKeys).length > 0) {
    for (const [alias, definition] of Object.entries(cli.inlineServiceKeys)) {
      combinedServiceKeys[alias] = definition;
    }
  }

  const context = {
    configDir: path.dirname(configPath),
    serviceKeys: combinedServiceKeys,
    serviceKeyCache: new Map(),
    cf: rootConfig.cf || {}
  };

  const targets = selectConnections(rootConfig, cli.connectionFilters);
  if (targets.length === 0) {
    throw new Error('No matching connections found in the YAML configuration.');
  }

  const settingsCache = new Map();
  const updates = [];

  for (const [connectionName, connectionConfig] of targets) {
    const settingsPath = resolveSettingsPath(connectionConfig, rootConfig, context);
    const cacheKey = settingsPath;

    if (!settingsCache.has(cacheKey)) {
      const configData = await readJsonFileYaml(settingsPath);
      settingsCache.set(cacheKey, configData);
    }

    const settingsData = settingsCache.get(cacheKey);
    const { connection, created } = ensureConnection(settingsData, connectionName, connectionConfig);
    const scope = determineScope(connectionConfig, rootConfig);
    const perConnectionContext = { ...context, connection: connectionName };

    await applyConnectionPatch(connection, connectionConfig.patch, perConnectionContext, {
      connection: connectionName
    });

    const headerUpdates = [];

    const sapUpdated = await handleSapConfiguration(connectionConfig, connection, perConnectionContext, {
      scope,
      connection: connectionName
    });
    headerUpdates.push(...sapUpdated);

    const mcpUpdated = await handleMcpConfiguration(connectionConfig, connection, perConnectionContext, {
      scope,
      connection: connectionName
    });
    headerUpdates.push(...mcpUpdated);

    if (connectionConfig.headers) {
      const customUpdated = await applyCustomHeaders(connection.headers, connectionConfig.headers, perConnectionContext, {
        connection: connectionName
      });
      headerUpdates.push(...customUpdated);
    }

    canonicalizeHeadersInPlace(connection.headers);

    updates.push({
      connectionName,
      settingsPath,
      created,
      updatedHeaders: [...new Set(headerUpdates.filter(Boolean).map((name) => canonicalizeHeaderName(name)))]
    });
  }

  if (cli.dryRun) {
    console.log('🛈 Dry-run mode: no files were written.');
  } else {
    for (const [settingsPath, config] of settingsCache.entries()) {
      await writeJsonFileYaml(settingsPath, config);
      console.log(`✅ Wrote ${settingsPath}`);
    }
  }

  for (const update of updates) {
    const status = update.created ? 'created' : 'updated';
    const headers = update.updatedHeaders.length ? update.updatedHeaders.join(', ') : 'none';
    console.log(`ℹ️  ${update.connectionName} (${status}) -> headers: ${headers}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌  ${error.message}`);
    process.exit(1);
  });
}

// Export main for use by other scripts
module.exports = { main };


// ===== END YAML MODE FUNCTIONS =====

if (require.main === module) {
  // Check if YAML mode is requested (--config or --template)
  const args = process.argv.slice(2);
  const hasYamlMode = args.includes('--config') || args.includes('-c') || args.includes('--template');

  if (hasYamlMode) {
    // Delegate to YAML handler
    (async () => {
      try {
        await mainYaml();
      } catch (err) {
        console.error(`❌ YAML mode error: ${err.message}`);
        process.exit(1);
      }
    })();
  } else {
    // Use CLI mode
    main().catch((error) => {
      console.error(`❌  ${error.message}`);
      process.exit(1);
    });
  }
}

module.exports = { parseArgs, applySapConfigToHeaders, applyMcpAuth, applyDestinationHeaders };
