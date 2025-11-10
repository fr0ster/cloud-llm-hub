#!/usr/bin/env node
/**
 * Deploy MTA with parameters from mta-deploy.yaml
 *
 * This script builds and deploys the MTA application using deployment parameters
 * from mta-deploy.yaml file (which is not committed to Git).
 *
 * Usage:
 *   # Build and deploy with parameters
 *   npm run deploy
 *
 *   # Or use mbt directly
 *   mbt build
 *   mbt deploy -p mta-deploy.yaml
 *
 * Prerequisites:
 *   1. Copy mta-deploy.yaml.template to mta-deploy.yaml
 *   2. Fill in your values in mta-deploy.yaml
 *   3. Ensure mta-deploy.yaml is in .gitignore (already configured)
 */

const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { resolve } = require('path');

const PARAMS_FILE = 'mta-deploy.yaml';
const TEMPLATE_FILE = 'mta-deploy.yaml.template';

function main() {
  console.log('🚀 MTA Deployment Script');
  console.log('========================\n');

  // Check if parameters file exists
  if (!existsSync(PARAMS_FILE)) {
    console.error(`❌ Error: ${PARAMS_FILE} not found!\n`);
    console.log(`📝 Please create ${PARAMS_FILE} from template:`);
    console.log(`   cp ${TEMPLATE_FILE} ${PARAMS_FILE}`);
    console.log(`   # Then edit ${PARAMS_FILE} with your actual values\n`);
    process.exit(1);
  }

  console.log(`✅ Found ${PARAMS_FILE}`);
  console.log(`📦 Building MTA archive...\n`);

  try {
    // Build MTA
    execSync('mbt build', { stdio: 'inherit' });

    console.log('\n📤 Deploying MTA with parameters...\n');

    // Deploy with parameters
    execSync(`mbt deploy -p ${PARAMS_FILE}`, { stdio: 'inherit' });

    console.log('\n✅ Deployment completed successfully!');
  } catch (error) {
    console.error('\n❌ Deployment failed:', error.message);
    process.exit(1);
  }
}

main();

