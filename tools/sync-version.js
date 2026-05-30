#!/usr/bin/env node

/**
 * Sync version from package.json to mta.yaml
 * Usage: node tools/sync-version.js [version]
 * If version is not provided, reads from package.json
 */

const fs = require('node:fs');
const path = require('node:path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const mtaYamlPath = path.join(__dirname, '..', 'mta.yaml');

// Get version from package.json or command line argument
let version;
if (process.argv[2]) {
  version = process.argv[2];
} else {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  version = packageJson.version;
}

if (!version) {
  console.error(
    '❌ Version not found. Provide version as argument or ensure package.json has version field.',
  );
  process.exit(1);
}

// Match: version: 1.0.0 / 1.0.0-rc / 1.0.0-rc.2 etc.
// SemVer pre-release suffix is letters/digits/dots/hyphens after a hyphen.
const versionRegex = /^version:\s*[\d.]+(?:-[A-Za-z0-9.-]+)?/m;

function syncYamlVersion(filePath, targetVersion) {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, 'utf8');
  if (!versionRegex.test(original)) {
    console.error(
      `❌ Could not find version field in ${path.basename(filePath)}`,
    );
    process.exit(1);
  }
  const updated = original.replace(versionRegex, `version: ${targetVersion}`);
  fs.writeFileSync(filePath, updated, 'utf8');
  console.log(
    `✅ Updated version in ${path.basename(filePath)} to ${targetVersion}`,
  );
  return true;
}

// Production MTA: same version as package.json. The staging MTA descriptor is
// generated at deploy time from this file (tools/make-staging-mta.js), so there
// is no separate staging version to sync.
syncYamlVersion(mtaYamlPath, version);
