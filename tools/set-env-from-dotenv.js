#!/usr/bin/env node
// Apply the deployment's .env to a CF app with `cf set-env` (tools/deploy.sh).
// Node, not python: the project already needs node, and on Windows `python3`
// is often the Microsoft Store stub. Prints names and status only — never
// any part of a value.
//
// Usage: node tools/set-env-from-dotenv.js <app> [.env path]
// Exit code: 0 when every variable was set, 1 otherwise.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

/** KEY=VALUE lines; blank lines and # comments skipped; value kept verbatim (trimmed). */
function parseDotenv(text) {
  const vars = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    vars.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return vars;
}

function main() {
  const [app, file = '.env'] = process.argv.slice(2);
  if (!app) {
    console.error('Usage: node tools/set-env-from-dotenv.js <app> [.env path]');
    process.exit(2);
  }
  const vars = parseDotenv(fs.readFileSync(file, 'utf8'));
  if (vars.length === 0) {
    console.log(`  No vars in ${file}`);
    return;
  }
  let failed = 0;
  for (const [key, value] of vars) {
    // No shell: a secret must never pass through cmd.exe / sh quoting.
    const r = spawnSync('cf', ['set-env', app, key, value], { stdio: 'pipe' });
    const ok = r.status === 0;
    if (!ok) failed++;
    console.log(`  ${key} : ${ok ? 'OK' : 'FAIL'}`);
  }
  if (failed) process.exit(1);
}

if (require.main === module) main();

module.exports = { parseDotenv };
