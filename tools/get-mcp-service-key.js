#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE_NAME = 'cloud-llm-hub-auth';
const KEY_NAME = 'mcp';
const OUTPUT_FILE = 'mcp.json';

function main() {
  console.log(`🔍 Fetching service key "${KEY_NAME}" for service "${SERVICE_NAME}"...`);

  try {
    // Attempt to get the service key
    const output = execSync(`cf service-key ${SERVICE_NAME} ${KEY_NAME}`, {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    // The output of cf service-key contains some header lines we need to skip
    // Usually it looks like:
    // Getting key mcp for service instance cloud-llm-hub-auth as email@example.com...
    //
    // {
    //   "apiurl": "...",
    //   ...
    // }
    
    const lines = output.split('\n');
    const jsonStartIndex = lines.findIndex(line => line.trim().startsWith('{'));
    
    if (jsonStartIndex === -1) {
      throw new Error('Could not find JSON in cf service-key output');
    }

    const jsonContent = lines.slice(jsonStartIndex).join('\n');
    
    // Validate JSON before saving
    JSON.parse(jsonContent);

    const outputPath = path.resolve(process.cwd(), OUTPUT_FILE);
    fs.writeFileSync(outputPath, jsonContent, 'utf8');

    console.log(`✅ Successfully saved service key to ${OUTPUT_FILE}`);
  } catch (error) {
    if (error.message && error.message.includes('Service key mcp not found')) {
      console.error(`❌ Error: Service key "${KEY_NAME}" not found for service "${SERVICE_NAME}".`);
      console.log(`💡 Try creating it first: cf create-service-key ${SERVICE_NAME} ${KEY_NAME}`);
    } else {
      console.error('❌ Error fetching service key:', error.message);
    }
    process.exit(1);
  }
}

main();
