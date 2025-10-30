#!/usr/bin/env tsx
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { spawn } from 'child_process';

interface CliOptions {
  connectionName: string;
  settingsPath?: string;
  envPath?: string;
  token?: string;
  authHeader?: string;
  dryRun?: boolean;
  force?: boolean;
  serviceKey?: string;
  browser?: string;
}

interface ClineConfig {
  mcpServers?: Record<string, ClineConnection>;
}

interface ClineConnection {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface SapEnvConfig {
  SAP_URL?: string;
  SAP_CLIENT?: string;
  SAP_AUTH_TYPE?: string;
  SAP_JWT_TOKEN?: string;
  SAP_USERNAME?: string;
  SAP_PASSWORD?: string;
  [key: string]: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    connectionName: '',
    dryRun: false
  };

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
      case '--token':
        options.token = argv[++i];
        break;
      case '--auth-header':
        options.authHeader = argv[++i];
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
    console.error('❌  Потрібно вказати назву підключення (--connection <name>).');
    printHelp();
    process.exit(1);
  }

  return options;
}

function printHelp(): void {
  console.log(`Оновлення MCP підключення для Cline

Використання: npx tsx scripts/update-cline-connection.ts --connection <name> [опції]

Опції:
  -c, --connection <name>   Ім'я MCP підключення в Cline (обов'язково)
      --settings <path>      Шлях до cline_mcp_settings.json (стандартний шлях використовується за замовчуванням)
      --env <path>           Шлях до .env з параметрами SAP (стандартно submodules/mcp-abap-adt/.env)
      --token <value>        JWT-токен для заголовка X-SAP-JWT-TOKEN (якщо не задано, береться з .env)
      --auth-header <value>  Значення заголовка Authorization (наприклад "Bearer <token>")
      --dry-run              Показати зміни, але не записувати файл
      --force                Ігнорувати попередження та використовувати дані без підтвердження
      --service-key <path>   Запустити оновлення JWT через sap-abap-auth-browser із вказаним service key
      --browser <name>       Передати параметр --browser до sap-abap-auth-browser (chrome|edge|firefox|system|none)
  -h, --help                 Вивести цю довідку
`);
}

function getDefaultSettingsPath(): string {
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

function getDefaultEnvPath(): string {
  return path.join(process.cwd(), 'submodules', 'mcp-abap-adt', '.env');
}

function getSubmoduleRoot(): string {
  return path.join(process.cwd(), 'submodules', 'mcp-abap-adt');
}

function getAuthScriptPath(): string {
  return path.join(getSubmoduleRoot(), 'tools', 'sap-abap-auth-browser.js');
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error: any) {
    throw new Error(`Не вдалося прочитати ${filePath}: ${error.message}`);
  }
}

async function runServiceKeyAuth(options: { serviceKey: string; browser?: string }): Promise<void> {
  const scriptPath = await ensureFile(getAuthScriptPath(), 'sap-abap-auth-browser.js');
  const serviceKeyPath = await ensureFile(options.serviceKey, 'Service key');

  const args = [scriptPath, 'auth', '--key', serviceKeyPath];
  if (options.browser) {
    args.push('--browser', options.browser);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: getSubmoduleRoot(),
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sap-abap-auth-browser завершився з кодом ${code}`));
      }
    });
  });
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const formatted = `${JSON.stringify(data, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, formatted, 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(filePath: string, description: string): Promise<string> {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!(await fileExists(absolutePath))) {
    throw new Error(`${description} не знайдено: ${absolutePath}`);
  }
  return absolutePath;
}

async function readEnvFile(filePath: string): Promise<SapEnvConfig> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .reduce<SapEnvConfig>((acc, line) => {
        const [key, ...rest] = line.split('=');
        if (!key) {
          return acc;
        }
        acc[key.trim()] = rest.join('=').trim();
        return acc;
      }, {} as SapEnvConfig);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw new Error(`Не вдалося прочитати .env (${filePath}): ${error.message}`);
  }
}

function decodeJwtPayload(token: string): Record<string, any> | undefined {
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

function getJwtExpiration(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    return undefined;
  }
  return payload.exp * 1000;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

async function confirmPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(message, resolve);
  });
  rl.close();
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes' || normalized === 'т' || normalized === 'так';
}

interface JwtUsage {
  value: string;
  source: 'env' | 'arg';
}

function applySapConfigToHeaders(
  headers: Record<string, string>,
  sapConfig: SapEnvConfig,
  tokenOverride?: string,
  authHeaderOverride?: string
): { updated: string[]; jwt?: JwtUsage } {
  const updatedKeys: string[] = [];

  const setHeader = (key: string, value: string | undefined) => {
    const normalizedKey = key.toLowerCase();
    const existingKey = Object.keys(headers).find((k) => k.toLowerCase() === normalizedKey);

    if (existingKey && existingKey !== key) {
      delete headers[existingKey];
      updatedKeys.push(existingKey);
    }

    if (typeof value === 'string' && value.length > 0) {
      headers[normalizedKey] = value;
      updatedKeys.push(normalizedKey);
    } else if (headers[normalizedKey]) {
      delete headers[normalizedKey];
      updatedKeys.push(normalizedKey);
    }
  };

  setHeader('x-sap-url', sapConfig.SAP_URL);
  setHeader('x-sap-client', sapConfig.SAP_CLIENT);

  const authTypeRaw = sapConfig.SAP_AUTH_TYPE ?? headers['X-SAP-AUTH-TYPE'] ?? headers['x-sap-auth-type'];
  const authType = (authTypeRaw ?? 'jwt').toLowerCase();
  setHeader('x-sap-auth-type', authType);

  if (authType === 'jwt') {
    const tokenSource: JwtUsage['source'] = tokenOverride ? 'arg' : 'env';
    const token = tokenOverride ?? sapConfig.SAP_JWT_TOKEN;
    if (!token) {
      throw new Error('JWT-токен не знайдено. Передайте --token або додайте SAP_JWT_TOKEN у .env.');
    }
    setHeader('x-sap-jwt-token', token);
    if (authHeaderOverride) {
      setHeader('authorization', authHeaderOverride);
    }
    return { updated: updatedKeys, jwt: { value: token, source: tokenSource } };
  } else if (authType === 'basic') {
    setHeader('x-sap-username', sapConfig.SAP_USERNAME);
    setHeader('x-sap-password', sapConfig.SAP_PASSWORD);
    if (authHeaderOverride) {
      setHeader('authorization', authHeaderOverride);
    }
  }

  return { updated: updatedKeys };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const settingsPath = options.settingsPath ?? getDefaultSettingsPath();
  const defaultEnvPath = getDefaultEnvPath();
  const envPath = options.envPath ?? defaultEnvPath;

  if (options.serviceKey) {
    console.log('🔄  Запускаю оновлення JWT через sap-abap-auth-browser...');
    await runServiceKeyAuth({ serviceKey: options.serviceKey, browser: options.browser });
    console.log('✅  JWT оновлено за допомогою service key.');
  if (options.envPath && path.resolve(process.cwd(), envPath) !== defaultEnvPath) {
      console.warn('⚠️  Увага: sap-abap-auth-browser оновив токен у стандартному .env субмодуля. Передайте однаковий шлях через --env, якщо потрібен інший файл.');
    }
  }

  const [config, sapConfig] = await Promise.all([
    readJsonFile<ClineConfig>(settingsPath),
    readEnvFile(envPath)
  ]);

  const envFilePresent = await fileExists(envPath);
  if (!envFilePresent && !options.token) {
    console.warn(`⚠️  Файл .env не знайдено (${envPath}). Передайте --token або створіть .env через утиліту авторизації.`);
  }

  if (!config.mcpServers) {
    throw new Error('Файл конфігурації не містить секції mcpServers.');
  }

  const connection = config.mcpServers[options.connectionName];
  if (!connection) {
    const available = Object.keys(config.mcpServers).length
      ? Object.keys(config.mcpServers).join(', ')
      : 'відсутні';
    throw new Error(
      `Підключення "${options.connectionName}" не знайдено. Доступні: ${available}`
    );
  }

  connection.headers = connection.headers ?? {};
  const { updated, jwt } = applySapConfigToHeaders(
    connection.headers,
    sapConfig,
    options.token,
    options.authHeader
  );

  if (jwt && jwt.source === 'env' && !options.force) {
    const expiration = getJwtExpiration(jwt.value);
    if (!expiration) {
      console.warn('⚠️  Не вдалося визначити термін дії JWT із .env.');
    } else if (expiration <= Date.now()) {
      console.warn(`⚠️  JWT із .env вже прострочений (exp: ${formatTimestamp(expiration)}).`);
      const confirmed = await confirmPrompt('Продовжити з цим токеном? [y/N] ');
      if (!confirmed) {
        console.log('Операцію скасовано. Оновіть токен або передайте його через --token.');
        process.exit(0);
      }
    }
  }

  if (options.dryRun) {
    console.log('🛈 Режим перевірки (--dry-run). Файл не буде перезаписано.');
  } else {
    await writeJsonFile(settingsPath, config);
    console.log(`✅ Файл оновлено: ${settingsPath}`);
  }

  console.log(`ℹ️  Оновлено заголовки: ${updated.join(', ') || 'нічого'}`);
}

main().catch((error) => {
  console.error(`❌  ${error.message}`);
  process.exit(1);
});
