#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE_NAME = 'cloud-llm-hub-auth';
const KEY_NAME = 'mcp';
const OUTPUT_FILE = 'mcp.json';

function main() {
  console.log(
    `🔍 Fetching service key "${KEY_NAME}" for service "${SERVICE_NAME}"...`,
  );

  try {
    // Attempt to get the service key
    const output = execSync(`cf service-key ${SERVICE_NAME} ${KEY_NAME}`, {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    // The output of cf service-key contains some header lines and potentially footer lines.
    // We search for the first '{' and the last '}' to extract the JSON content.
    const firstBrace = output.indexOf('{');
    const lastBrace = output.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error('Could not find JSON object in cf service-key output');
    }

    const jsonContent = output.substring(firstBrace, lastBrace + 1);

    // Validate JSON before saving
    JSON.parse(jsonContent);

    const outputPath = path.resolve(process.cwd(), OUTPUT_FILE);
    fs.writeFileSync(outputPath, jsonContent, 'utf8');

    console.log(`✅ Successfully saved service key to ${OUTPUT_FILE}`);
  } catch (error) {
    if (error.message?.includes('Service key mcp not found')) {
      console.error(
        `❌ Error: Service key "${KEY_NAME}" not found for service "${SERVICE_NAME}".`,
      );
      console.log(
        `💡 Try creating it first: cf create-service-key ${SERVICE_NAME} ${KEY_NAME}`,
      );
    } else {
      console.error('❌ Error fetching service key:', error.message);
    }
    process.exit(1);
  }
}

main();
