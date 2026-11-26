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

function splitDotenvValue(source) {
  const trimmed = source.trimStart();
  const leading = source.slice(0, source.length - trimmed.length);
  const quoted = /^(["'])((?:\\.|(?!\1)[^\\])*)\1(?=\s*(?:#|$))/.exec(trimmed);
  if (quoted) {
    const [literal, quote, body] = quoted;
    return {
      leading,
      quote,
      value: body.replace(/\\(.)/g, (escaped, char) =>
        char === quote || char === '\\' ? char : escaped,
      ),
      trailing: trimmed.slice(literal.length),
    };
  }

  // A bare # is literal unless whitespace separates it from the value.
  const comment = source.search(/\s+#/);
  const content = (comment < 0 ? source : source.slice(0, comment)).trimEnd();
  return {
    leading: content ? leading : '',
    value: content.trimStart(),
    trailing: source.slice(content.length),
  };
}

function parseDotenv(text) {
  const vars = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trimStart().startsWith('#')) continue;
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim();
    if (key) vars.push([key, splitDotenvValue(raw.slice(eq + 1)).value]);
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

module.exports = { parseDotenv, splitDotenvValue };
