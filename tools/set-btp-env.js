#!/usr/bin/env node
/**
 * Set environment variables for BTP deployment
 *
 * This script sets LLM provider API keys as environment variables in Cloud Foundry.
 *
 * Main advantage: Reads from .env file automatically, so you don't need to export variables.
 *
 * Usage:
 *   # Option 1: Read from .env file (recommended)
 *   npm run deploy:set-env
 *
 *   # Option 2: Export variables first, then run script
 *   export OPENAI_API_KEY="sk-proj-your-key-here"
 *   npm run deploy:set-env
 *
 *   # Option 3: Use CF CLI directly (if you prefer)
 *   export OPENAI_API_KEY="sk-proj-your-key-here"
 *   cf set-env cloud-llm-hub-srv OPENAI_API_KEY "$OPENAI_API_KEY"
 *   cf restage cloud-llm-hub-srv
 *
 * Environment variables to set (read from .env file or process.env):
 *   - OPENAI_API_KEY
 *   - OPENAI_MODEL (optional)
 *   - OPENAI_ORG (optional)
 *   - OPENAI_PROJECT (optional)
 *   - ANTHROPIC_API_KEY (optional)
 *   - ANTHROPIC_MODEL (optional)
 *   - DEEPSEEK_API_KEY (optional)
 *   - DEEPSEEK_MODEL (optional)
 *
 * Note: API keys should NOT be stored in mta.yaml for security reasons.
 * This script allows setting them via CF CLI after deployment.
 */

const { execSync } = require('node:child_process');
const { config } = require('dotenv');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const APP_NAME = process.env.CF_APP_NAME || 'cloud-llm-hub-srv';

// Load .env file if it exists (main advantage - no need to export manually)
const envPath = resolve(process.cwd(), '.env');
let _loadedFromEnv = false;
if (existsSync(envPath)) {
  config({ path: envPath });
  _loadedFromEnv = true;
  console.log(`📄 Loaded configuration from .env file: ${envPath}\n`);
} else {
  console.log(
    '💡 Tip: Create .env file to avoid exporting variables manually.\n',
  );
}

// Environment variables to set
const envVars = {
  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_ORG: process.env.OPENAI_ORG,
  OPENAI_PROJECT: process.env.OPENAI_PROJECT || process.env.OPENAI_PRJ,

  // Anthropic
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,

  // DeepSeek
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,

  // LLM Provider selection
  LLM_PROVIDER: process.env.LLM_PROVIDER,
};

function main() {
  console.log(`🔧 Setting environment variables for BTP app: ${APP_NAME}\n`);

  // Check if CF CLI is available
  try {
    execSync('cf --version', { stdio: 'ignore' });
  } catch (_error) {
    console.error(
      '❌ Error: CF CLI not found. Please install Cloud Foundry CLI.',
    );
    console.error(
      '   Download: https://docs.cloudfoundry.org/cf-cli/install-go-cli.html',
    );
    process.exit(1);
  }

  // Check if app exists
  try {
    execSync(`cf app ${APP_NAME}`, { stdio: 'ignore' });
  } catch (_error) {
    console.error(`❌ Error: App "${APP_NAME}" not found.`);
    console.error(`   Make sure the app is deployed and the name is correct.`);
    console.error(
      `   Or set CF_APP_NAME environment variable: export CF_APP_NAME=your-app-name`,
    );
    process.exit(1);
  }

  // Set environment variables
  const varsToSet = [];
  const varsToUnset = [];

  for (const [key, value] of Object.entries(envVars)) {
    if (value) {
      varsToSet.push({ key, value });
    } else {
      // Check if variable exists in CF and should be unset
      try {
        const envOutput = execSync(`cf env ${APP_NAME}`, { encoding: 'utf8' });
        if (envOutput.includes(`"${key}"`)) {
          varsToUnset.push(key);
        }
      } catch (_error) {
        // Ignore errors when checking
      }
    }
  }

  if (varsToSet.length === 0 && varsToUnset.length === 0) {
    console.log('⚠️  No environment variables to set or unset.');
    console.log(
      '   Set variables in .env file or as process.env before running this script.',
    );
    console.log('\n   Example:');
    console.log('     export OPENAI_API_KEY="sk-proj-your-key-here"');
    console.log('     npm run deploy:set-env');
    process.exit(0);
  }

  // Set variables
  if (varsToSet.length > 0) {
    console.log('📝 Setting environment variables:');
    for (const { key, value } of varsToSet) {
      const maskedValue =
        value.length > 10
          ? `${value.substring(0, 7)}...${value.substring(value.length - 4)}`
          : '***';
      console.log(`   ${key}=${maskedValue}`);

      try {
        execSync(`cf set-env ${APP_NAME} ${key} "${value}"`, {
          stdio: 'ignore',
        });
      } catch (_error) {
        console.error(`   ❌ Failed to set ${key}`);
        process.exit(1);
      }
    }
    console.log('   ✅ All variables set successfully\n');
  }

  // Unset variables
  if (varsToUnset.length > 0) {
    console.log('🗑️  Unsetting environment variables:');
    for (const key of varsToUnset) {
      console.log(`   ${key}`);
      try {
        execSync(`cf unset-env ${APP_NAME} ${key}`, { stdio: 'ignore' });
      } catch (_error) {
        console.error(`   ❌ Failed to unset ${key}`);
        process.exit(1);
      }
    }
    console.log('   ✅ All variables unset successfully\n');
  }

  console.log('🔄 Restaging application to apply changes...');
  try {
    execSync(`cf restage ${APP_NAME}`, { stdio: 'inherit' });
  } catch (_error) {
    console.error('❌ Failed to restage application');
    console.error(
      `   You may need to restage manually: cf restage ${APP_NAME}`,
    );
    process.exit(1);
  }

  console.log('\n✅ Environment variables configured successfully!');
  console.log(`\n💡 To verify, run: cf env ${APP_NAME}`);
}

main();
