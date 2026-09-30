#!/usr/bin/env node
/** the `dev:local` npm script — spec §5: warn about hybrid, build tool vectors, start. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function checkHybrid(root) {
  const f = path.join(root, 'default-env.json');
  return fs.existsSync(f)
    ? `${f} exists: its VCAP_SERVICES make this run hybrid (real BTP services). Move it aside for a BTP-free run.`
    : null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  // A spawn failure (e.g. ENOENT) sets `error` and leaves `status` null.
  if (r.error) console.error(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const warn = checkHybrid(root);
  if (warn) console.warn(`WARNING: ${warn}`);
  run('npx', ['tsx', 'tools/generate-tool-embeddings.ts']);
  run('npx', ['cds', 'watch', '--profile', 'development']);
}

module.exports = { checkHybrid };
