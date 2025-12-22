#!/usr/bin/env node
/**
 * Update default-env.json with VCAP_SERVICES from BTP
 *
 * Usage:
 *   node tools/update-default-env.js [app-name]
 *
 * Default app-name: cloud-llm-hub-srv
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = process.argv[2] || 'cloud-llm-hub-srv';
const DEFAULT_ENV_PATH = path.join(__dirname, '..', 'default-env.json');

function main() {
  console.log(`📥 Fetching VCAP_SERVICES from BTP for app: ${APP_NAME}...`);

  try {
    // Get VCAP_SERVICES from CF
    const cfOutput = execSync(`cf env ${APP_NAME}`, { encoding: 'utf8' });

    // Extract VCAP_SERVICES JSON
    const vcapMatch = cfOutput.match(
      /VCAP_SERVICES:\s*(\{[\s\S]*?\})\s*\n\nVCAP_APPLICATION/,
    );

    if (!vcapMatch) {
      console.error('❌ Failed to find VCAP_SERVICES in cf env output');
      process.exit(1);
    }

    const vcapServicesStr = vcapMatch[1];
    let vcapServices;

    try {
      vcapServices = JSON.parse(vcapServicesStr);
    } catch (parseError) {
      console.error('❌ Error parsing VCAP_SERVICES JSON:', parseError.message);
      process.exit(1);
    }

    // Read current default-env.json
    let defaultEnv = {};
    if (fs.existsSync(DEFAULT_ENV_PATH)) {
      try {
        defaultEnv = JSON.parse(fs.readFileSync(DEFAULT_ENV_PATH, 'utf8'));
      } catch (readError) {
        console.warn(
          '⚠️  Error reading default-env.json, creating new one:',
          readError.message,
        );
      }
    }

    // Update VCAP_SERVICES
    defaultEnv.VCAP_SERVICES = vcapServices;

    // Write back
    fs.writeFileSync(
      DEFAULT_ENV_PATH,
      `${JSON.stringify(defaultEnv, null, 2)}\n`,
    );

    // Show what was updated
    console.log('✅ Updated default-env.json');
    console.log('\n📋 Updated services:');

    if (vcapServices.xsuaa && vcapServices.xsuaa.length > 0) {
      const xsuaa = vcapServices.xsuaa[0];
      console.log(`  • XSUAA (${xsuaa.name})`);
      console.log(`    Binding GUID: ${xsuaa.binding_guid}`);
      console.log(
        `    Client ID: ${xsuaa.credentials.clientid.substring(0, 40)}...`,
      );
    }

    if (vcapServices.destination && vcapServices.destination.length > 0) {
      const dest = vcapServices.destination[0];
      console.log(`  • Destination (${dest.name})`);
      console.log(`    Binding GUID: ${dest.binding_guid}`);
    }

    if (vcapServices.aicore && vcapServices.aicore.length > 0) {
      const aicore = vcapServices.aicore[0];
      console.log(`  • SAP AI Core (${aicore.name})`);
      console.log(`    Binding GUID: ${aicore.binding_guid}`);
      console.log(
        `    Has Client ID: ${!!aicore.credentials?.clientid}`,
      );
      console.log(
        `    Has Client Secret: ${!!aicore.credentials?.clientsecret}`,
      );
      console.log(
        `    AI API URL: ${aicore.credentials?.serviceurls?.AI_API_URL || aicore.credentials?.url || 'NOT_SET'}`,
      );
    }

    // Verify XSUAA credentials
    if (vcapServices.xsuaa && vcapServices.xsuaa.length > 0) {
      const xsuaa = vcapServices.xsuaa[0];
      const localXsuaa = defaultEnv.VCAP_SERVICES?.xsuaa?.[0];

      if (localXsuaa) {
        if (
          xsuaa.binding_guid === localXsuaa.binding_guid &&
          xsuaa.credentials.clientsecret === localXsuaa.credentials.clientsecret
        ) {
          console.log('\n✅ Verification: credentials match BTP');
        } else {
          console.log('\n⚠️  Verification: credentials differ (was updated)');
        }
      }
    }

    console.log(`\n📁 File saved: ${DEFAULT_ENV_PATH}`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stderr) {
      console.error('Stderr:', error.stderr.toString());
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
