#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'submodules', 'mcp-abap-adt');
const targetDir = path.join(rootDir, 'gen', 'srv', 'submodules', 'mcp-abap-adt');

const ITEMS_TO_COPY = ['package.json', 'LICENSE', 'README.md', 'dist'];

async function pathExists(p) {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function copyItem(item) {
  const sourcePath = path.join(sourceDir, item);
  const targetPath = path.join(targetDir, item);
  if (!(await pathExists(sourcePath))) {
    console.warn(`⚠️  Missing ${item} in ${sourceDir}, skipping.`);
    return;
  }
  await fs.promises.cp(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: false
  });
}

async function main() {
  if (!(await pathExists(sourceDir))) {
    throw new Error(`Submodule directory not found: ${sourceDir}`);
  }
  if (!(await pathExists(path.join(sourceDir, 'dist')))) {
    throw new Error('Submodule dist/ folder is missing. Run "npm run build --prefix submodules/mcp-abap-adt" first.');
  }

  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await fs.promises.mkdir(targetDir, { recursive: true });

  for (const item of ITEMS_TO_COPY) {
    await copyItem(item);
  }

  console.log(`✅ Copied mcp-abap-adt payload to ${targetDir}`);
}

main().catch((error) => {
  console.error(`❌  ${error.message}`);
  process.exit(1);
});
