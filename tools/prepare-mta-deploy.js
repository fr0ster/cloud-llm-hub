#!/usr/bin/env node
/**
 * Prepare MTA deployment by generating mta.yaml with substituted values
 *
 * This script reads mta-deploy.yaml and creates a temporary mta.yaml
 * with all parameter placeholders (~{PARAM_NAME}) replaced with actual values.
 *
 * Usage:
 *   # Generate mta.yaml with substituted values
 *   npm run deploy:prepare
 *
 *   # Then deploy normally
 *   mbt build
 *   cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar
 *
 * Or use the combined script:
 *   npm run deploy  # Uses mbt deploy -p which handles substitution automatically
 */

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { resolve } = require('path');

const PARAMS_FILE = 'mta-deploy.yaml';
const TEMPLATE_FILE = 'mta-deploy.yaml.template';
const MTA_FILE = 'mta.yaml';
const MTA_BACKUP = 'mta.yaml.backup';

function main() {
  console.log('🔧 MTA Deployment Preparation');
  console.log('=============================\n');

  // Check if parameters file exists
  if (!existsSync(PARAMS_FILE)) {
    console.error(`❌ Error: ${PARAMS_FILE} not found!\n`);
    console.log(`📝 Please create ${PARAMS_FILE} from template:`);
    console.log(`   cp ${TEMPLATE_FILE} ${PARAMS_FILE}`);
    console.log(`   # Then edit ${PARAMS_FILE} with your values\n`);
    process.exit(1);
  }

  console.log(`✅ Found ${PARAMS_FILE}`);

  try {
    // Read parameters (simple YAML parser for key: value pairs)
    const paramsContent = readFileSync(PARAMS_FILE, 'utf8');
    const params = {};
    const lines = paramsContent.split('\n');

    lines.forEach(line => {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (trimmed && !trimmed.startsWith('#')) {
        const match = trimmed.match(/^([A-Z_]+):\s*["']?([^"']+)["']?$/);
        if (match) {
          const key = match[1];
          let value = match[2];
          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          params[key] = value;
        }
      }
    });

    console.log('📋 Loaded parameters:');
    Object.keys(params).forEach(key => {
      console.log(`   ${key}: ${params[key]}`);
    });
    console.log('');

    // Read mta.yaml template
    const mtaContent = readFileSync(MTA_FILE, 'utf8');

    // Backup original mta.yaml
    if (existsSync(MTA_FILE)) {
      writeFileSync(MTA_BACKUP, mtaContent);
      console.log(`💾 Backed up original ${MTA_FILE} to ${MTA_BACKUP}`);
    }

    // Substitute parameters (~{PARAM_NAME} → value)
    let substitutedContent = mtaContent;
    Object.keys(params).forEach(key => {
      const placeholder = `~{${key}}`;
      const value = params[key];
      // Escape special regex characters in placeholder
      const escapedPlaceholder = placeholder.replace(/[{}]/g, '\\$&');
      const regex = new RegExp(escapedPlaceholder, 'g');
      const matches = substitutedContent.match(regex);
      if (matches) {
        substitutedContent = substitutedContent.replace(regex, value);
        console.log(`   ✓ Substituted ${placeholder} → ${value} (${matches.length} occurrence(s))`);
      }
    });

    // Write substituted mta.yaml
    writeFileSync(MTA_FILE, substitutedContent);

    console.log(`\n✅ Generated ${MTA_FILE} with substituted values`);
    console.log(`\n📦 Next steps:`);
    console.log(`   1. Review ${MTA_FILE} to verify substitutions`);
    console.log(`   2. Run: mbt build`);
    console.log(`   3. Run: cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar`);
    console.log(`\n💡 To restore original: cp ${MTA_BACKUP} ${MTA_FILE}`);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (existsSync(MTA_BACKUP)) {
      console.log(`\n🔄 Restoring original ${MTA_FILE} from backup...`);
      const backup = readFileSync(MTA_BACKUP, 'utf8');
      writeFileSync(MTA_FILE, backup);
    }
    process.exit(1);
  }
}

main();

