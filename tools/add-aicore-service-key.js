#!/usr/bin/env node

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const USAGE = [
  'Usage: node tools/add-aicore-service-key.js <service-key.json> [--dir <deploy checkout>]',
  'Writes only the four AICORE_* credential keys to .env.',
  'Set the resource group (LLM_AGENT_RESOURCE_GROUP) and provider (LLM_AGENT_PROVIDER) in .mtaext as deployment settings.',
].join('\n');

class CliError extends Error {}

function parseArgs([keyFile, ...args]) {
  if (!keyFile || keyFile.startsWith('--')) throw new CliError(USAGE);

  let dir = process.cwd();
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag !== '--dir' || !value?.trim() || value.startsWith('--')) {
      throw new CliError(USAGE);
    }
    dir = value;
  }
  return { keyFile, dir: path.resolve(dir) };
}

function readServiceKey(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    throw new CliError('Could not read the SAP AI Core service key file.');
  }

  let key;
  try {
    key = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    throw new CliError(
      'The SAP AI Core service key file contains invalid JSON.',
    );
  }

  const fields = {
    url: key?.url,
    clientid: key?.clientid,
    clientsecret: key?.clientsecret,
    'serviceurls.AI_API_URL': key?.serviceurls?.AI_API_URL,
  };
  const invalid = Object.entries(fields)
    .filter(
      ([, value]) =>
        typeof value !== 'string' ||
        !value ||
        value.trim() !== value ||
        /[\r\n\0]/.test(value),
    )
    .map(([name]) => name);
  if (invalid.length) {
    throw new CliError(
      `Missing or invalid required service key fields: ${invalid.join(', ')}. Expected non-empty, single-line strings without surrounding whitespace.`,
    );
  }

  const authUrl = fields.url.replace(/\/+$/, '');
  const baseUrl = fields['serviceurls.AI_API_URL'];
  for (const [field, value] of [
    ['url', authUrl],
    ['serviceurls.AI_API_URL', baseUrl],
  ]) {
    const url = URL.parse(value);
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new CliError(
        `Invalid service key field ${field}. Expected an HTTP(S) URL.`,
      );
    }
    if (
      field === 'url' &&
      (/[?#]/.test(value) || url.pathname.endsWith('/oauth/token'))
    ) {
      throw new CliError(
        'Invalid service key field url. Expected the authentication base URL.',
      );
    }
  }

  return {
    // Hub appends /oauth/token to the base URL.
    AICORE_AUTH_URL: authUrl,
    AICORE_CLIENT_ID: fields.clientid,
    AICORE_CLIENT_SECRET: fields.clientsecret,
    AICORE_BASE_URL: baseUrl,
  };
}

function lineEnding(source) {
  return source.match(/\r?\n/)?.[0] || '\n';
}

function dotenvComment(source, credential) {
  const value = source.trimStart();
  if (value.startsWith(credential)) {
    const suffix = value.slice(credential.length);
    if (/^(?:\s+#|\s*$)/.test(suffix)) return suffix.trimStart();
  }

  const quoted = /^(["'])(?:\\.|(?!\1)[^\\])*\1(?=\s*(?:#|$))/.exec(value);
  if (quoted) return value.slice(quoted[0].length).trimStart();
  const comment = source.search(/\s+#/);
  return comment < 0 ? '' : source.slice(comment).trimStart();
}

function updateDotenv(source, entries) {
  const changes = new Map(Object.keys(entries).map((key) => [key, 'added']));
  const eol = lineEnding(source);
  const updated = source
    .split(/(\r?\n)/)
    .map((line, index, lines) => {
      // Match the assignments read by set-env-from-dotenv.js.
      const eq = line.indexOf('=');
      if (eq < 0 || line.trimStart().startsWith('#')) return line;

      const key = line.slice(0, eq).trim();
      if (!changes.has(key)) return line;

      const assignment = `${key}=${entries[key]}`;
      if (line === assignment) {
        if (changes.get(key) === 'added') changes.set(key, 'unchanged');
        return line;
      }

      changes.set(key, 'updated');
      const comment = dotenvComment(line.slice(eq + 1), entries[key]);
      const indent = line.match(/^[ \t]*/)[0];
      return comment
        ? `${indent}${comment}${lines[index + 1] || eol}${assignment}`
        : assignment;
    })
    .join('');

  const added = [];
  for (const [key, status] of changes) {
    if (status === 'added') added.push(`${key}=${entries[key]}${eol}`);
  }
  const separator =
    added.length && updated && !updated.endsWith('\n') ? eol : '';
  return { updated: updated + separator + added.join(''), changes };
}

function readTarget(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new CliError(`Could not read ${file}.`);
  }
}

function writeDotenv(file, source, updated) {
  if (source === updated) return;

  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const mode = source === undefined ? 0o600 : fs.statSync(file).mode;
    fs.writeFileSync(temp, updated, { encoding: 'utf8', flag: 'wx', mode });
    fs.renameSync(temp, file);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      console.error('Could not remove the .env staging file.');
    }
    throw new CliError(`Could not write ${file}.`);
  }
}

function main(args = process.argv.slice(2)) {
  try {
    const { keyFile, dir } = parseArgs(args);
    const credentials = readServiceKey(keyFile);
    const envFile = path.join(dir, '.env');
    const envSource = readTarget(envFile);
    const { updated, changes } = updateDotenv(envSource ?? '', credentials);

    writeDotenv(envFile, envSource, updated);
    for (const [key, status] of changes) {
      console.log(`${envFile}: ${key} ${status}`);
    }
  } catch (error) {
    // Parser and system errors can include input values. Report fixed messages only.
    console.error(
      error instanceof CliError ? error.message : 'Could not update .env.',
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main };
