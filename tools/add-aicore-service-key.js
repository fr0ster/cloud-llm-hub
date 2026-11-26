#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

// CAP already depends on the source-preserving YAML parser.
const yaml = require(
  require.resolve('yaml', {
    paths: [path.dirname(require.resolve('@sap/cds/package.json'))],
  }),
);

const USAGE =
  'Usage: node tools/add-aicore-service-key.js <service-key.json> [--dir <deploy checkout>] [--resource-group <rg>] [--provider sap-ai-sdk|sap-aicore-foundation]';
const SRV_MODULE = 'cloud-llm-hub-srv';

class CliError extends Error {}

function parseArgs([keyFile, ...args]) {
  if (!keyFile || keyFile.startsWith('--')) throw new CliError(USAGE);

  let dir = process.cwd();
  const properties = {};
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!value?.trim() || value.startsWith('--')) throw new CliError(USAGE);

    switch (flag) {
      case '--dir':
        dir = value;
        break;
      case '--resource-group':
        properties.LLM_AGENT_RESOURCE_GROUP = value;
        break;
      case '--provider':
        if (value !== 'sap-ai-sdk' && value !== 'sap-aicore-foundation') {
          throw new CliError(
            'Expected --provider sap-ai-sdk or sap-aicore-foundation.',
          );
        }
        properties.LLM_AGENT_PROVIDER = value;
        break;
      default:
        throw new CliError(USAGE);
    }
  }
  return { keyFile, dir: path.resolve(dir), properties };
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

function updateDotenv(source, entries) {
  const changes = new Map(Object.keys(entries).map((key) => [key, 'added']));
  const updated = source
    .split(/(\r?\n)/)
    .map((line) => {
      // Match the assignments read by set-env-from-dotenv.js.
      const eq = line.indexOf('=');
      if (eq < 0 || line.trimStart().startsWith('#')) return line;

      const key = line.slice(0, eq).trim();
      if (!changes.has(key)) return line;

      if (line.slice(eq + 1).trim() !== entries[key]) {
        changes.set(key, 'updated');
        return `${line.slice(0, eq + 1)}${entries[key]}`;
      }
      if (changes.get(key) === 'added') changes.set(key, 'unchanged');
      return line;
    })
    .join('');

  const eol = lineEnding(source);
  const added = [];
  for (const [key, status] of changes) {
    if (status === 'added') added.push(`${key}=${entries[key]}${eol}`);
  }
  const separator =
    added.length && updated && !updated.endsWith('\n') ? eol : '';
  return { updated: updated + separator + added.join(''), changes };
}

function spliceSource(source, start, end, text) {
  return source.slice(0, start) + text + source.slice(end);
}

function flowYaml(value) {
  return yaml
    .stringify(value, { collectionStyle: 'flow', lineWidth: 0 })
    .trimEnd();
}

function addYamlEntry(source, collection, entry) {
  if (collection.flow) {
    const offset = collection.range[0] + 1;
    const value = flowYaml(entry).slice(1, -1).trim();
    const separator = collection.items.length ? ', ' : '';
    return spliceSource(source, offset, offset, value + separator);
  }

  const offset = collection.range[1];
  const eol = lineEnding(source);
  const indent = ' '.repeat(collection.srcToken.indent);
  const text = yaml
    .stringify(entry, { lineWidth: 0 })
    .trimEnd()
    .split('\n')
    .map((line) => indent + line)
    .join(eol);
  const separator = source[offset - 1] === '\n' ? '' : eol;
  return spliceSource(source, offset, offset, separator + text + eol);
}

function replaceYamlValue(source, node, value) {
  const [start, end] = node.range;
  const prefix = start === end && source[start - 1] === ':' ? ' ' : '';
  const suffix = source[end] === '#' ? ' ' : '';
  const serialized =
    typeof value === 'string'
      ? yaml
          .stringify(value, { defaultStringType: 'QUOTE_DOUBLE', lineWidth: 0 })
          .trimEnd()
      : flowYaml(value);
  // A block scalar's inline comment and line ending are part of its value span.
  const header =
    node.srcToken?.type === 'block-scalar'
      ? node.srcToken.props
          .slice(1)
          .map((token) => token.source)
          .join('')
      : '';
  return spliceSource(
    source,
    start,
    end,
    prefix + serialized + suffix + header,
  );
}

function updateMtaProperty(source, key, value) {
  const doc = yaml.parseDocument(source, { keepSourceTokens: true });
  if (doc.errors.length || !yaml.isMap(doc.contents)) {
    throw new CliError('Expected .mtaext to contain a valid YAML mapping.');
  }

  const property = { [key]: value };
  const module = { name: SRV_MODULE, properties: property };
  const modules = doc.get('modules', true);
  if (!modules)
    return [addYamlEntry(source, doc.contents, { modules: [module] }), 'added'];
  if (yaml.isScalar(modules) && modules.value === null) {
    return [replaceYamlValue(source, modules, [module]), 'added'];
  }
  if (!yaml.isSeq(modules))
    throw new CliError('Expected .mtaext modules to be a YAML sequence.');

  const srv = modules.items.find(
    (item) => yaml.isMap(item) && item.get('name') === SRV_MODULE,
  );
  if (!srv) return [addYamlEntry(source, modules, [module]), 'added'];

  const properties = srv.get('properties', true);
  if (!properties)
    return [addYamlEntry(source, srv, { properties: property }), 'added'];
  if (yaml.isScalar(properties) && properties.value === null) {
    return [replaceYamlValue(source, properties, property), 'added'];
  }
  if (!yaml.isMap(properties))
    throw new CliError('Expected .mtaext srv properties to be a YAML mapping.');

  const current = properties.get(key, true);
  if (!current) return [addYamlEntry(source, properties, property), 'added'];
  if (!yaml.isScalar(current) && !yaml.isAlias(current)) {
    throw new CliError(
      `Expected ${key} in .mtaext srv properties to be a scalar.`,
    );
  }
  if (yaml.isScalar(current) && current.value === value)
    return [source, 'unchanged'];
  return [replaceYamlValue(source, current, value), 'updated'];
}

function updateMtaext(source, properties) {
  let updated = source;
  const changes = new Map();
  for (const [key, value] of Object.entries(properties)) {
    const [text, status] = updateMtaProperty(updated, key, value);
    updated = text;
    changes.set(key, status);
  }
  if (updated !== source && yaml.parseDocument(updated).errors.length) {
    throw new CliError(
      'Could not update .mtaext without changing the surrounding YAML.',
    );
  }
  return { updated, changes };
}

function readTarget(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new CliError(`Could not read ${file}.`);
  }
}

function saveTarget(file, source, { updated, changes }) {
  if (source !== updated) {
    try {
      fs.writeFileSync(file, updated, { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw new CliError(`Could not write ${file}.`);
    }
  }
  for (const [key, status] of changes) console.log(`${file}: ${key} ${status}`);
}

function main(args = process.argv.slice(2)) {
  try {
    const { keyFile, dir, properties } = parseArgs(args);
    const credentials = readServiceKey(keyFile);
    const envFile = path.join(dir, '.env');
    const envSource = readTarget(envFile) ?? '';
    const envUpdate = updateDotenv(envSource, credentials);
    const mtaFile = path.join(dir, '.mtaext');
    const updateMta = Object.keys(properties).length > 0;
    const mtaSource = updateMta ? readTarget(mtaFile) : undefined;
    const mtaUpdate =
      mtaSource === undefined ? undefined : updateMtaext(mtaSource, properties);

    saveTarget(envFile, envSource, envUpdate);
    if (mtaUpdate) saveTarget(mtaFile, mtaSource, mtaUpdate);
    else if (updateMta) console.log(`${mtaFile}: missing, skipped`);
  } catch (error) {
    // Parser and system errors can include input values. Report fixed messages only.
    console.error(
      error instanceof CliError
        ? error.message
        : 'Could not update deployment configuration.',
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main };
