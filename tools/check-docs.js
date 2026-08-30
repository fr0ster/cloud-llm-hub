#!/usr/bin/env node
/**
 * Verify that the documentation still describes the project as it is.
 *
 * Every check here exists because the corresponding drift actually shipped:
 * guides told readers to copy a template that had moved, to run npm scripts
 * that did not exist, to deploy an artefact the printed build command never
 * produced, and — the expensive one — to put LLM_AGENT_API_KEY into .mtaext,
 * where mta.yaml never reads it, so Scenario B silently deployed without
 * credentials.
 *
 * Run: npm run docs:check
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'gen', '.git', 'mta_archives']);

const failures = [];
const fail = (file, line, msg) =>
  failures.push({ file: path.relative(ROOT, file), line, msg });

/**
 * Every authored file that instructs a reader: docs/** Markdown, the root
 * README, and the `.template` files — their comment headers carry copy/build/
 * deploy commands just as guides do, and a typo there is as costly.
 */
function documentedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (
        entry.name.endsWith('.md') ||
        entry.name.endsWith('.template')
      ) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(path.join(ROOT, 'docs'));
  out.push(path.join(ROOT, 'README.md'));
  return out;
}

const readLines = (f) => fs.readFileSync(f, 'utf8').split('\n');

// ---------------------------------------------------------------- checks

/** Relative Markdown links must resolve. */
function checkLinks(file, lines) {
  const dir = path.dirname(file);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0].trim();
      if (!target || /^(https?:|mailto:|#)/.test(m[1])) continue;
      if (!fs.existsSync(path.resolve(dir, target)))
        fail(file, i + 1, `broken link → ${target}`);
    }
  });
}

/** `cp <source> ...` in a shell block must name a file that exists. */
function checkCopySources(file, lines) {
  lines.forEach((line, i) => {
    const m = line.match(/^\s*#?\s*cp\s+(\S+)\s+\S+/);
    if (!m) return;
    const src = m[1].replace(/^#\s*/, '');
    if (src.startsWith('<') || src.includes('*')) return;
    const candidates = [
      path.resolve(ROOT, src),
      path.resolve(path.dirname(file), src),
      path.resolve(projectRoot(file), src),
    ];
    if (!candidates.some((c) => fs.existsSync(c)))
      fail(file, i + 1, `cp source does not exist → ${src}`);
  });
}

/** Nearest ancestor directory holding a package.json — sub-projects own theirs. */
function projectRoot(file) {
  let dir = path.dirname(file);
  while (dir.startsWith(ROOT)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return ROOT;
}

const scriptCache = new Map();
function scriptsFor(file) {
  const dir = projectRoot(file);
  if (!scriptCache.has(dir)) {
    const p = path.join(dir, 'package.json');
    scriptCache.set(dir, JSON.parse(fs.readFileSync(p, 'utf8')).scripts || {});
  }
  return scriptCache.get(dir);
}

/** `npm run <script>` must be defined in the owning project's package.json. */
function checkNpmScripts(file, lines, scripts) {
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
      if (!scripts[m[1]]) fail(file, i + 1, `npm script not defined → ${m[1]}`);
    }
  });
}

/**
 * A `cf deploy <artefact>` must name an archive something actually produced.
 *
 * Two failure modes, both of which shipped:
 *  - the deploy names a different artefact than `build:mta` writes;
 *  - a guide prints its own `mbt build -t X --mtar Y` and then deploys
 *    something other than X/Y. That one is invisible to a check that only
 *    compares against the npm script, because the deploy line alone looks fine.
 */
function checkDeployArtefact(file, lines, expected) {
  // Sub-projects under docs/examples build their own archives.
  if (projectRoot(file) !== ROOT) return;
  let manual = null; // artefact of the most recent manual mbt build in this file
  lines.forEach((line, i) => {
    // A single line may hold both, e.g. `mbt build && cf deploy ...` — so this
    // records the build and then falls through to the deploy check.
    const build = line.match(/mbt build\b(.*)/);
    if (build) {
      const target = build[1].match(/-t\s+(\S+)/);
      const mtar = build[1].match(/--mtar\s+(\S+)/);
      manual = target && mtar ? `${target[1]}/${mtar[1]}` : null;
    }
    const m = line.match(/cf deploy\s+(\S+\.(?:mtar|tar))/);
    if (!m) return;
    if (manual && m[1] !== manual) {
      fail(
        file,
        i + 1,
        `deploys ${m[1]}, but the mbt build above produces ${manual}`,
      );
      return;
    }
    // Otherwise: the npm script's artefact, or mbt's default archive name.
    const ok =
      m[1] === expected ||
      /^mta_archives\/cloud-llm-hub[_-][^/]*\.mtar$/.test(m[1]);
    if (!ok)
      fail(file, i + 1, `deploys ${m[1]}, but build:mta produces ${expected}`);
  });
}

/**
 * Every configuration variable name the server source mentions.
 *
 * Read broadly — `process.env.X`, a destructured `env.X`, a string literal —
 * because a name the code never mentions in any form is a name the runtime
 * cannot act on. `tools/set-btp-env.js` used to set vendor-prefixed variables
 * on the deployed app, and the app came up with no credentials and no error.
 */
function knownEnvNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|cds|js)$/.test(entry.name)) {
        for (const m of fs
          .readFileSync(full, 'utf8')
          .matchAll(
            /\b(?:LLM_AGENT|SAP_CORE_AI|OPENAI|ANTHROPIC|DEEPSEEK|AICORE)_[A-Z0-9_]+|\bLLM_PROVIDER\b/g,
          ))
          names.add(m[0]);
      }
    }
  };
  walk(path.join(ROOT, 'srv'));
  return names;
}

/**
 * A `LLM_AGENT_*` or `SAP_CORE_AI_*` variable the docs tell you to set must be
 * one the code reads.
 *
 * Scoped to our own prefix on purpose: vendor-prefixed names in the docs are
 * usually about someone else's process — ANTHROPIC_BASE_URL configures the
 * reader's Claude CLI, not this server. A guide proposing *new* configuration
 * (the extension scenarios) opts out with `docs-check:proposed-env` anywhere in
 * the file — such a page exists to describe configuration that does not exist
 * yet, so the rule cannot apply to it.
 */
function checkEnvNames(file, lines, known) {
  if (projectRoot(file) !== ROOT) return;
  if (lines.some((l) => l.includes('docs-check:proposed-env'))) return;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\b(?:LLM_AGENT|SAP_CORE_AI)_[A-Z0-9_]+/g)) {
      if (!known.has(m[0]))
        fail(
          file,
          i + 1,
          `${m[0]} is read nowhere in srv/ — setting it has no effect`,
        );
    }
  });
}

/**
 * A variable a tool sets on the deployed app must be one the code reads.
 *
 * tools/set-btp-env.js set vendor-prefixed names; the app came up with no
 * credentials and no error, because nothing reads them.
 */
function checkToolEnvNames(known) {
  const dir = path.join(ROOT, 'tools');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const file = path.join(dir, name);
    readLines(file).forEach((line, i) => {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]{4,}):\s*process\.env\./);
      if (m && !known.has(m[1]))
        fail(file, i + 1, `sets ${m[1]}, which is read nowhere in srv/`);
    });
  }
}

/**
 * Routes the server actually serves.
 *
 * OData services come from the CDS `@path` annotations, Express routes from the
 * app.use/app.post/app.get mounts in server.ts. Docs quoting a path outside
 * these send the reader to a 404 — `/odata/v4/mcp/Health()` did exactly that
 * because the service is annotated `@path: 'mcp-proxy'`.
 */
function serverRoutes() {
  const odata = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'srv'))) {
    if (!f.endsWith('.cds')) continue;
    const src = fs.readFileSync(path.join(ROOT, 'srv', f), 'utf8');
    for (const m of src.matchAll(/@path:\s*'([^']+)'/g))
      odata.add(`/odata/v4/${m[1].replace(/^\//, '')}`);
  }
  const express = new Set();
  const srvSrc = fs.readFileSync(path.join(ROOT, 'srv/server.ts'), 'utf8');
  for (const m of srvSrc.matchAll(/app\.(?:use|get|post|all)\(\s*'(\/[^']*)'/g))
    express.add(m[1].replace(/\*+$/, '').replace(/\/$/, ''));
  return { odata, express };
}

/**
 * A path quoted in the docs must be one the server serves.
 *
 * Two rules, deliberately narrow — several real routes are mounted by routers
 * rather than as literals in server.ts, so demanding an exact match everywhere
 * would flag working paths.
 *
 *  1. An `/odata/v4/<service>` prefix must be a CDS `@path`. `/odata/v4/mcp/…`
 *     failed here: the service is annotated `mcp-proxy`.
 *  2. A near-miss on a registered route — same characters, different
 *     punctuation — is a typo, not an unlisted route. `/mcp/stream-http`
 *     collapses to the same letters as `/mcp/stream/http`.
 */
function checkRoutes(file, lines, routes) {
  // Sub-projects under docs/examples serve their own CDS services.
  if (projectRoot(file) !== ROOT) return;
  const squash = (p) => p.replace(/[-_/]/g, '').toLowerCase();
  const registered = [...routes.express].filter((r) => r.split('/').length > 2);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\/odata\/v4\/[A-Za-z0-9_-]+/g)) {
      const p = m[0].replace(/\/$/, '');
      if (!routes.odata.has(p))
        fail(
          file,
          i + 1,
          `no CDS service at ${p} — @path values are ${[...routes.odata].join(', ')}`,
        );
    }
    for (const m of line.matchAll(/\/(?:mcp|v1)\/[A-Za-z0-9/_-]+/g)) {
      const p = m[0].replace(/\/$/, '');
      if (routes.express.has(p)) continue;
      const twin = registered.find((r) => squash(r) === squash(p));
      if (twin) fail(file, i + 1, `route ${p} is a typo for ${twin}`);
    }
  });
}

/**
 * A `@mcp-abap-adt/<pkg>` named in the docs must be installed.
 *
 * `@mcp-abap-adt/llm-proxy` — the family's former name — survived in nine
 * imports and install commands long after the package was split into
 * llm-agent-libs / llm-agent-mcp / openai-llm, so every one of those snippets
 * failed at `npm install`.
 */
function checkScopedPackages(file, lines, installed) {
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/@mcp-abap-adt\/([a-z0-9-]+)/g)) {
      if (!installed.has(m[1]))
        fail(file, i + 1, `package @mcp-abap-adt/${m[1]} is not installed`);
    }
  });
}

/** "512M", "2048MB", "2G" → megabytes. */
function toMb(value) {
  const m = String(value).match(/^(\d+)\s*(M|MB|G|GB)?$/i);
  if (!m) return null;
  return /^g/i.test(m[2] || 'M') ? Number(m[1]) * 1024 : Number(m[1]);
}

/**
 * A line that names an MTA module and states a memory figure must agree with
 * mta.yaml. The architecture diagram claimed the approuter had 256MB long after
 * it moved to 512M — the kind of number a reader sizes a subaccount from.
 */
function checkMemoryClaims(file, lines, moduleMemory) {
  lines.forEach((line, i) => {
    const stated = line.match(/Memory:\s*(\d+\s*(?:M|MB|G|GB)?)/i);
    if (!stated) return;
    // Longest name first, so cloud-llm-hub-srv wins over cloud-llm-hub.
    const name = [...moduleMemory.keys()]
      .sort((a, b) => b.length - a.length)
      .find((n) => line.includes(n));
    if (!name) return;
    const claimed = toMb(stated[1].replace(/\s+/g, ''));
    const actual = toMb(moduleMemory.get(name));
    if (claimed !== null && actual !== null && claimed !== actual)
      fail(
        file,
        i + 1,
        `states Memory ${stated[1]} for ${name}, but mta.yaml sets ${moduleMemory.get(name)}`,
      );
  });
}

/**
 * Parameters set in an .mtaext template must be declared in mta.yaml AND
 * reach the srv module, otherwise the value is silently dropped.
 */
function checkMtaextParameters(mta) {
  const declared = new Set(Object.keys(mta.parameters || {}));
  // "Used" means referenced as ${NAME} anywhere in the descriptor — module
  // properties, routes, resource config. Declared but never referenced means
  // the value cannot reach the deployed app.
  const mtaText = fs.readFileSync(path.join(ROOT, 'mta.yaml'), 'utf8');
  const used = new Set(
    [...mtaText.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]),
  );
  const dir = path.join(ROOT, 'docs/deployment/templates');
  for (const name of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mtaext.template'))) {
    const file = path.join(dir, name);
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      fail(file, 0, `template is not valid YAML: ${err.message}`);
      continue;
    }
    for (const key of Object.keys(doc?.parameters || {})) {
      if (!declared.has(key))
        fail(
          file,
          0,
          `parameter ${key} is not declared in mta.yaml — it will be ignored`,
        );
      else if (!used.has(key))
        fail(
          file,
          0,
          `parameter ${key} is declared but never referenced in mta.yaml`,
        );
    }
  }
}

// ------------------------------------------------------------------ run

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
);
const scripts = pkg.scripts || {};
const mta = yaml.load(fs.readFileSync(path.join(ROOT, 'mta.yaml'), 'utf8'));

const mtarMatch = (scripts['build:mta'] || '').match(
  /-t\s+(\S+)\s+--mtar\s+(\S+)/,
);
const expectedArtefact = mtarMatch ? `${mtarMatch[1]}/${mtarMatch[2]}` : null;

const routes = serverRoutes();
const envNames = knownEnvNames();

const installedScoped = new Set(
  fs.readdirSync(path.join(ROOT, 'node_modules/@mcp-abap-adt')),
);

const moduleMemory = new Map(
  (mta.modules || [])
    .filter((m) => m.parameters?.memory)
    .map((m) => [m.name, m.parameters.memory]),
);

for (const file of documentedFiles()) {
  const lines = readLines(file);
  if (file.endsWith('.md')) checkLinks(file, lines);
  checkCopySources(file, lines);
  checkNpmScripts(file, lines, scriptsFor(file));
  checkMemoryClaims(file, lines, moduleMemory);
  checkRoutes(file, lines, routes);
  checkScopedPackages(file, lines, installedScoped);
  checkEnvNames(file, lines, envNames);
  if (expectedArtefact) checkDeployArtefact(file, lines, expectedArtefact);
}
checkMtaextParameters(mta);
checkToolEnvNames(envNames);

if (failures.length === 0) {
  console.log('docs:check — OK');
  process.exit(0);
}
console.error(`docs:check — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  ${f.file}:${f.line}  ${f.msg}`);
process.exit(1);
