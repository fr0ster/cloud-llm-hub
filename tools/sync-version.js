#!/usr/bin/env node

/**
 * Sync version from package.json to mta.yaml
 * Usage: node tools/sync-version.js [version]
 * If version is not provided, reads from package.json
 */

const fs = require('fs');
const path = require('path');

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
  console.error('❌ Version not found. Provide version as argument or ensure package.json has version field.');
  process.exit(1);
}

// Read mta.yaml
let mtaContent = fs.readFileSync(mtaYamlPath, 'utf8');

// Update version in mta.yaml
// Match: version: 1.0.0 (with optional whitespace)
const versionRegex = /^version:\s*[\d.]+/m;
if (versionRegex.test(mtaContent)) {
  mtaContent = mtaContent.replace(versionRegex, `version: ${version}`);
  fs.writeFileSync(mtaYamlPath, mtaContent, 'utf8');
  console.log(`✅ Updated version in mta.yaml to ${version}`);
} else {
  console.error('❌ Could not find version field in mta.yaml');
  process.exit(1);
}

