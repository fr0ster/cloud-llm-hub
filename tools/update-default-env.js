#!/usr/bin/env node
/**
 * Update default-env.json with VCAP_SERVICES from BTP
 * 
 * Usage:
 *   node tools/update-default-env.js [app-name]
 * 
 * Default app-name: cloud-llm-hub-srv
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_NAME = process.argv[2] || 'cloud-llm-hub-srv';
const DEFAULT_ENV_PATH = path.join(__dirname, '..', 'default-env.json');

function main() {
  console.log(`📥 Отримую VCAP_SERVICES з BTP для додатку: ${APP_NAME}...`);
  
  try {
    // Get VCAP_SERVICES from CF
    const cfOutput = execSync(`cf env ${APP_NAME}`, { encoding: 'utf8' });
    
    // Extract VCAP_SERVICES JSON
    const vcapMatch = cfOutput.match(/VCAP_SERVICES:\s*(\{[\s\S]*?\})\s*\n\nVCAP_APPLICATION/);
    
    if (!vcapMatch) {
      console.error('❌ Не вдалося знайти VCAP_SERVICES у виводі cf env');
      process.exit(1);
    }
    
    const vcapServicesStr = vcapMatch[1];
    let vcapServices;
    
    try {
      vcapServices = JSON.parse(vcapServicesStr);
    } catch (parseError) {
      console.error('❌ Помилка парсингу VCAP_SERVICES JSON:', parseError.message);
      process.exit(1);
    }
    
    // Read current default-env.json
    let defaultEnv = {};
    if (fs.existsSync(DEFAULT_ENV_PATH)) {
      try {
        defaultEnv = JSON.parse(fs.readFileSync(DEFAULT_ENV_PATH, 'utf8'));
      } catch (readError) {
        console.warn('⚠️  Помилка читання default-env.json, створю новий:', readError.message);
      }
    }
    
    // Update VCAP_SERVICES
    defaultEnv.VCAP_SERVICES = vcapServices;
    
    // Write back
    fs.writeFileSync(DEFAULT_ENV_PATH, JSON.stringify(defaultEnv, null, 2) + '\n');
    
    // Show what was updated
    console.log('✅ Оновлено default-env.json');
    console.log('\n📋 Оновлені сервіси:');
    
    if (vcapServices.xsuaa && vcapServices.xsuaa.length > 0) {
      const xsuaa = vcapServices.xsuaa[0];
      console.log(`  • XSUAA (${xsuaa.name})`);
      console.log(`    Binding GUID: ${xsuaa.binding_guid}`);
      console.log(`    Client ID: ${xsuaa.credentials.clientid.substring(0, 40)}...`);
    }
    
    if (vcapServices.destination && vcapServices.destination.length > 0) {
      const dest = vcapServices.destination[0];
      console.log(`  • Destination (${dest.name})`);
      console.log(`    Binding GUID: ${dest.binding_guid}`);
    }
    
    // Verify XSUAA credentials
    if (vcapServices.xsuaa && vcapServices.xsuaa.length > 0) {
      const xsuaa = vcapServices.xsuaa[0];
      const localXsuaa = defaultEnv.VCAP_SERVICES?.xsuaa?.[0];
      
      if (localXsuaa) {
        if (xsuaa.binding_guid === localXsuaa.binding_guid &&
            xsuaa.credentials.clientsecret === localXsuaa.credentials.clientsecret) {
          console.log('\n✅ Перевірка: credentials співпадають з BTP');
        } else {
          console.log('\n⚠️  Перевірка: credentials відрізняються (було оновлено)');
        }
      }
    }
    
    console.log(`\n📁 Файл збережено: ${DEFAULT_ENV_PATH}`);
    
  } catch (error) {
    console.error('❌ Помилка:', error.message);
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

