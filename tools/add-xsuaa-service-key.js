#!/usr/bin/env node
/**
 * Add XSUAA service key to default-env.json
 *
 * Usage:
 *   node tools/add-xsuaa-service-key.js [service-key-file] [service-name]
 *
 * Default service-key-file: mcp.json
 * Default service-name: cloud-llm-hub-xsuaa
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVICE_KEY_FILE =
  process.argv[2] || path.join(__dirname, '..', 'mcp.json');
const SERVICE_NAME = process.argv[3] || 'cloud-llm-hub-xsuaa';
const DEFAULT_ENV_PATH = path.join(__dirname, '..', 'default-env.json');

function main() {
  console.log(`📥 Adding XSUAA service key to default-env.json`);
  console.log(`   Service key file: ${SERVICE_KEY_FILE}`);
  console.log(`   Service name: ${SERVICE_NAME}`);

  // Read service key
  if (!fs.existsSync(SERVICE_KEY_FILE)) {
    console.error(`❌ Error: Service key file not found: ${SERVICE_KEY_FILE}`);
    console.error(
      `   Create service key: cf create-service-key <xsuaa-instance> <key-name>`,
    );
    console.error(
      `   Get service key: cf service-key <xsuaa-instance> <key-name>`,
    );
    process.exit(1);
  }

  let serviceKey;
  try {
    serviceKey = JSON.parse(fs.readFileSync(SERVICE_KEY_FILE, 'utf8'));
  } catch (parseError) {
    console.error(`❌ Error parsing service key file: ${parseError.message}`);
    process.exit(1);
  }

  // Validate service key structure
  if (!serviceKey.clientid || !serviceKey.clientsecret || !serviceKey.url) {
    console.error(
      '❌ Error: Service key is missing required fields (clientid, clientsecret, url)',
    );
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

  // Initialize VCAP_SERVICES if not present
  if (!defaultEnv.VCAP_SERVICES) {
    defaultEnv.VCAP_SERVICES = {};
  }

  // Initialize xsuaa array if not present
  if (!defaultEnv.VCAP_SERVICES.xsuaa) {
    defaultEnv.VCAP_SERVICES.xsuaa = [];
  }

  // Check if service with same name already exists
  const existingIndex = defaultEnv.VCAP_SERVICES.xsuaa.findIndex(
    (s) => s.name === SERVICE_NAME,
  );

  // Create XSUAA service entry
  const xsuaaService = {
    binding_guid: serviceKey.serviceInstanceId || `xsuaa-${Date.now()}`,
    binding_name: null,
    credentials: {
      clientid: serviceKey.clientid,
      clientsecret: serviceKey.clientsecret,
      url: serviceKey.url,
      identityzone: serviceKey.identityzone,
      identityzoneid: serviceKey.identityzoneid,
      tenantid: serviceKey.tenantid,
      tenantmode: serviceKey.tenantmode,
      uaadomain: serviceKey.uaadomain,
      zoneid: serviceKey.zoneid,
      verificationkey: serviceKey.verificationkey,
      xsappname: serviceKey.xsappname,
      subaccountid: serviceKey.subaccountid,
      'credential-type': serviceKey['credential-type'] || 'binding-secret',
    },
    instance_guid:
      serviceKey.serviceInstanceId || `xsuaa-instance-${Date.now()}`,
    instance_name: SERVICE_NAME,
    label: 'xsuaa',
    name: SERVICE_NAME,
    plan: 'application',
    provider: null,
    syslog_drain_url: null,
    tags: ['xsuaa'],
    volume_mounts: [],
  };

  // Add or update service
  if (existingIndex >= 0) {
    console.log(`   Updating existing XSUAA service: ${SERVICE_NAME}`);
    defaultEnv.VCAP_SERVICES.xsuaa[existingIndex] = xsuaaService;
  } else {
    console.log(`   Adding new XSUAA service: ${SERVICE_NAME}`);
    defaultEnv.VCAP_SERVICES.xsuaa.push(xsuaaService);
  }

  // Write back
  fs.writeFileSync(
    DEFAULT_ENV_PATH,
    `${JSON.stringify(defaultEnv, null, 2)}\n`,
  );

  // Show what was added
  console.log('✅ Updated default-env.json');
  console.log('\n📋 XSUAA Service:');
  console.log(`  • Name: ${SERVICE_NAME}`);
  console.log(`  • Client ID: ${serviceKey.clientid.substring(0, 40)}...`);
  console.log(`  • URL: ${serviceKey.url}`);
  console.log(`  • Identity Zone: ${serviceKey.identityzone || 'N/A'}`);

  // Verify
  console.log('\n✅ Verification: XSUAA service added successfully');
  console.log(`\n📁 File saved: ${DEFAULT_ENV_PATH}`);
  console.log('\n💡 Next steps:');
  console.log('   1. Test XSUAA token: ./tools/get-xsuaa-token.sh');
  console.log('   2. Start hybrid debugging: cds watch --profile production');
  console.log('   3. Use Basic auth (auto-converted) or Bearer token');
}

if (require.main === module) {
  main();
}

module.exports = { main };
