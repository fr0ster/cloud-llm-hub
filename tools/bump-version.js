#!/usr/bin/env node

/**
 * Bump version in all files (package.json, mta.yaml)
 * Works like npm version but syncs version across all files
 * 
 * Usage:
 *   node tools/bump-version.js patch   # 1.0.0 -> 1.0.1
 *   node tools/bump-version.js minor   # 1.0.0 -> 1.1.0
 *   node tools/bump-version.js major   # 1.0.0 -> 2.0.0
 *   node tools/bump-version.js 1.2.3  # Set specific version
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const mtaYamlPath = path.join(__dirname, '..', 'mta.yaml');

// Parse semantic version
function parseVersion(version) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version format: ${version}. Expected: major.minor.patch`);
  }
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

// Increment version
function incrementVersion(currentVersion, type) {
  const version = parseVersion(currentVersion);
  
  switch (type) {
    case 'major':
      return `${version.major + 1}.0.0`;
    case 'minor':
      return `${version.major}.${version.minor + 1}.0`;
    case 'patch':
      return `${version.major}.${version.minor}.${version.patch + 1}`;
    default:
      // Assume it's a specific version
      if (/^\d+\.\d+\.\d+$/.test(type)) {
        return type;
      }
      throw new Error(`Invalid version type: ${type}. Use patch, minor, major, or x.y.z`);
  }
}

// Get current version from package.json
function getCurrentVersion() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

// Update version in package.json
function updatePackageJson(newVersion) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const oldVersion = packageJson.version;
  packageJson.version = newVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  console.log(`✅ Updated version in package.json: ${oldVersion} -> ${newVersion}`);
  return oldVersion;
}

// Update version in mta.yaml
function updateMtaYaml(newVersion) {
  let mtaContent = fs.readFileSync(mtaYamlPath, 'utf8');
  const versionRegex = /^version:\s*[\d.]+/m;
  
  if (versionRegex.test(mtaContent)) {
    const oldVersion = mtaContent.match(versionRegex)[0].replace(/^version:\s*/, '');
    mtaContent = mtaContent.replace(versionRegex, `version: ${newVersion}`);
    fs.writeFileSync(mtaYamlPath, mtaContent, 'utf8');
    console.log(`✅ Updated version in mta.yaml: ${oldVersion} -> ${newVersion}`);
    return oldVersion;
  } else {
    throw new Error('❌ Could not find version field in mta.yaml');
  }
}

// Update version in package-lock.json
function updatePackageLock(newVersion) {
  const packageLockPath = path.join(__dirname, '..', 'package-lock.json');
  
  if (!fs.existsSync(packageLockPath)) {
    console.log('⚠️  package-lock.json not found, skipping');
    return;
  }
  
  try {
    // Use npm to sync package-lock.json with package.json
    // This is the safest way to ensure consistency
    execSync('npm install --package-lock-only', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
    console.log(`✅ Synced version in package-lock.json to ${newVersion}`);
  } catch (error) {
    console.error('⚠️  Failed to sync package-lock.json automatically');
    console.error('   Run manually: npm install --package-lock-only');
  }
}

// Main function
function main() {
  const type = process.argv[2];
  
  if (!type) {
    console.error('Usage: node tools/bump-version.js <patch|minor|major|version>');
    console.error('Examples:');
    console.error('  node tools/bump-version.js patch   # 1.0.0 -> 1.0.1');
    console.error('  node tools/bump-version.js minor   # 1.0.0 -> 1.1.0');
    console.error('  node tools/bump-version.js major   # 1.0.0 -> 2.0.0');
    console.error('  node tools/bump-version.js 1.2.3   # Set to 1.2.3');
    process.exit(1);
  }

  try {
    const currentVersion = getCurrentVersion();
    console.log(`📦 Current version: ${currentVersion}`);
    
    const newVersion = incrementVersion(currentVersion, type);
    console.log(`🚀 New version: ${newVersion}\n`);
    
    // Update files
    updatePackageJson(newVersion);
    updateMtaYaml(newVersion);
    updatePackageLock(newVersion);
    
    console.log(`\n✅ Version bumped to ${newVersion} in all files`);
    console.log(`\n💡 Next steps:`);
    console.log(`   1. Review changes: git diff`);
    console.log(`   2. Commit: git add package.json package-lock.json mta.yaml && git commit -m "chore: bump version to ${newVersion}"`);
    console.log(`   3. Tag: git tag -a v${newVersion} -m "Release v${newVersion}"`);
    console.log(`   4. Push: git push origin main && git push origin v${newVersion}`);
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();

