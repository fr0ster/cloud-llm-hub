#!/usr/bin/env node

/**
 * Cross-platform setup verification script
 * Checks if all required configuration is in place for consistent behavior across OS
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// ANSI color codes
const colors = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  reset: '\x1b[0m'
};

let errors = 0;
let warnings = 0;

/**
 * Check if a file exists
 */
function checkFile(filePath, description) {
  const fullPath = join(rootDir, filePath);
  if (existsSync(fullPath)) {
    console.log(`${colors.green}✓${colors.reset} ${description}: ${filePath}`);
    return true;
  } else {
    console.log(`${colors.red}✗${colors.reset} ${description}: ${filePath} (MISSING)`);
    errors++;
    return false;
  }
}

/**
 * Get git config value
 */
function getGitConfig(key) {
  try {
    return execSync(`git config --get ${key}`, {
      cwd: rootDir,
      encoding: 'utf8'
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Check git configuration
 */
function checkGitConfig(key, expected, description) {
  const actual = getGitConfig(key);

  if (actual === expected) {
    console.log(`${colors.green}✓${colors.reset} ${description}: ${actual}`);
    return true;
  } else if (actual === null) {
    console.log(`${colors.yellow}⚠${colors.reset} ${description}: not set (expected: ${expected})`);
    warnings++;
    return false;
  } else {
    console.log(`${colors.yellow}⚠${colors.reset} ${description}: ${actual} (expected: ${expected})`);
    warnings++;
    return false;
  }
}

/**
 * Check for CRLF line endings in files
 */
function checkLineEndings(pattern, description) {
  try {
    // Use git to check line endings (more reliable across platforms)
    const output = execSync(
      `git ls-files '${pattern}' | xargs file 2>/dev/null || true`,
      { cwd: rootDir, encoding: 'utf8' }
    );

    const crlfCount = (output.match(/CRLF/g) || []).length;

    if (crlfCount === 0) {
      console.log(`${colors.green}✓${colors.reset} ${description}: No CRLF found`);
      return true;
    } else {
      console.log(`${colors.red}✗${colors.reset} ${description}: Found ${crlfCount} files with CRLF line endings`);
      errors++;
      return false;
    }
  } catch (error) {
    console.log(`${colors.yellow}⚠${colors.reset} ${description}: Could not check (${error.message})`);
    warnings++;
    return false;
  }
}

/**
 * Check for peer:true in package-lock.json
 */
function checkPeerDeps(lockfilePath) {
  const fullPath = join(rootDir, lockfilePath);

  if (!existsSync(fullPath)) {
    return true; // Not an error if lock file doesn't exist yet
  }

  try {
    const content = readFileSync(fullPath, 'utf8');
    const matches = content.match(/"peer"\s*:\s*true/g) || [];

    const projectName = dirname(lockfilePath) === '.' ? 'root' : basename(dirname(lockfilePath));

    if (matches.length === 0) {
      console.log(`${colors.green}✓${colors.reset} No 'peer: true' in ${projectName}/package-lock.json`);
      return true;
    } else {
      console.log(`${colors.red}✗${colors.reset} Found ${matches.length} 'peer: true' entries in ${projectName}/package-lock.json`);
      errors++;
      return false;
    }
  } catch (error) {
    console.log(`${colors.yellow}⚠${colors.reset} Could not read ${lockfilePath}: ${error.message}`);
    warnings++;
    return false;
  }
}

/**
 * Check for nested node_modules inconsistencies
 */
function checkNestedNodeModules(lockfilePath) {
  const fullPath = join(rootDir, lockfilePath);

  if (!existsSync(fullPath)) {
    return true;
  }

  try {
    const content = readFileSync(fullPath, 'utf8');

    // Check for deeply nested node_modules (3+ levels) which can differ between OS
    const deepNested = content.match(/node_modules\/[^\/]+\/node_modules\/[^\/]+\/node_modules/g) || [];

    const projectName = dirname(lockfilePath) === '.' ? 'root' : basename(dirname(lockfilePath));

    if (deepNested.length === 0) {
      console.log(`${colors.green}✓${colors.reset} No deep nested node_modules in ${projectName}/package-lock.json`);
      return true;
    } else {
      console.log(`${colors.yellow}⚠${colors.reset} Found ${deepNested.length} deeply nested node_modules in ${projectName}/package-lock.json`);
      console.log(`${colors.yellow}  ${colors.reset} This may cause inconsistencies across platforms`);
      warnings++;
      return false;
    }
  } catch (error) {
    console.log(`${colors.yellow}⚠${colors.reset} Could not check ${lockfilePath}: ${error.message}`);
    warnings++;
    return false;
  }
}

/**
 * Check .npmrc settings
 */
function checkNpmrcSettings(npmrcPath) {
  const fullPath = join(rootDir, npmrcPath);

  if (!existsSync(fullPath)) {
    return false;
  }

  try {
    const content = readFileSync(fullPath, 'utf8');
    const projectName = dirname(npmrcPath) === '.' ? 'root' : basename(dirname(npmrcPath));

    const requiredSettings = {
      'legacy-peer-deps': 'true',
      'package-lock': 'true',
      'install-strategy': 'nested'
    };

    let allPresent = true;

    for (const [key, expectedValue] of Object.entries(requiredSettings)) {
      const regex = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm');
      const match = content.match(regex);

      if (!match) {
        console.log(`${colors.yellow}⚠${colors.reset} ${projectName}/.npmrc: Missing '${key}' setting`);
        warnings++;
        allPresent = false;
      } else if (match[1].trim() !== expectedValue) {
        console.log(`${colors.yellow}⚠${colors.reset} ${projectName}/.npmrc: '${key}' is '${match[1].trim()}' (expected: '${expectedValue}')`);
        warnings++;
        allPresent = false;
      }
    }

    if (allPresent) {
      console.log(`${colors.green}✓${colors.reset} ${projectName}/.npmrc has all required settings`);
    }

    return allPresent;
  } catch (error) {
    console.log(`${colors.yellow}⚠${colors.reset} Could not check ${npmrcPath}: ${error.message}`);
    warnings++;
    return false;
  }
}

/**
 * Get version info
 */
function getVersionInfo() {
  try {
    const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
    const npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
    return { nodeVersion, npmVersion };
  } catch {
    return { nodeVersion: 'not installed', npmVersion: 'not installed' };
  }
}

/**
 * Main verification
 */
function main() {
  console.log('🔍 Cross-Platform Setup Verification');
  console.log('====================================');
  console.log('');

  // Check configuration files
  console.log('📁 Configuration Files');
  console.log('--------------------');
  checkFile('.npmrc', 'Root .npmrc');
  checkFile('.editorconfig', 'Root .editorconfig');
  checkFile('.gitattributes', 'Root .gitattributes');
  checkFile('submodules/llm-agent/.npmrc', 'llm-agent .npmrc');
  checkFile('submodules/llm-agent/.editorconfig', 'llm-agent .editorconfig');
  checkFile('submodules/llm-agent/.gitattributes', 'llm-agent .gitattributes');
  checkFile('submodules/mcp-abap-adt/.npmrc', 'mcp-abap-adt .npmrc');
  checkFile('submodules/mcp-abap-adt/.editorconfig', 'mcp-abap-adt .editorconfig');
  checkFile('submodules/mcp-abap-adt/.gitattributes', 'mcp-abap-adt .gitattributes');
  console.log('');

  // Check .npmrc settings
  console.log('⚙️  NPM Configuration');
  console.log('-------------------');
  checkNpmrcSettings('.npmrc');
  checkNpmrcSettings('submodules/llm-agent/.npmrc');
  checkNpmrcSettings('submodules/mcp-abap-adt/.npmrc');
  console.log('');

  // Check git configuration
  console.log('⚙️  Git Configuration');
  console.log('-------------------');
  checkGitConfig('core.autocrlf', 'input', 'core.autocrlf');
  checkGitConfig('core.eol', 'lf', 'core.eol');
  console.log('');

  // Check line endings
  console.log('📝 Line Endings');
  console.log('--------------');
  checkLineEndings('*.ts', 'TypeScript files');
  checkLineEndings('*.js', 'JavaScript files');
  checkLineEndings('*.json', 'JSON files');
  console.log('');

  // Check package-lock.json
  console.log('📦 Package Lock Files');
  console.log('-------------------');
  checkPeerDeps('package-lock.json');
  checkPeerDeps('submodules/llm-agent/package-lock.json');
  checkPeerDeps('submodules/mcp-abap-adt/package-lock.json');
  console.log('');

  console.log('🔧 Nested Dependencies');
  console.log('--------------------');
  checkNestedNodeModules('package-lock.json');
  checkNestedNodeModules('submodules/llm-agent/package-lock.json');
  checkNestedNodeModules('submodules/mcp-abap-adt/package-lock.json');
  console.log('');

  // Check versions
  console.log('🔧 Node & NPM Versions');
  console.log('--------------------');
  const { nodeVersion, npmVersion } = getVersionInfo();
  console.log(`Node.js: ${nodeVersion} (required: >=18.0.0)`);
  console.log(`npm: ${npmVersion} (required: >=9.0.0)`);
  console.log('');

  // Summary
  console.log('====================================');
  if (errors === 0 && warnings === 0) {
    console.log(`${colors.green}✓ All checks passed!${colors.reset}`);
    process.exit(0);
  } else if (errors === 0) {
    console.log(`${colors.yellow}⚠ Passed with ${warnings} warning(s)${colors.reset}`);
    console.log('See docs/CROSS_PLATFORM_GUIDE.md for setup instructions');
    process.exit(0);
  } else {
    console.log(`${colors.red}✗ Failed with ${errors} error(s) and ${warnings} warning(s)${colors.reset}`);
    console.log('See docs/CROSS_PLATFORM_GUIDE.md for troubleshooting');
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { checkFile, checkGitConfig, checkLineEndings, checkPeerDeps };
