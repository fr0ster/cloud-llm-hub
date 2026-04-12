#!/usr/bin/env node
/**
 * RAG CLI — manage RAG collections via cloud-llm-hub REST API.
 *
 * Cross-platform (Node.js). Works on Linux, macOS, Windows.
 *
 * Usage:
 *   node tools/rag-cli.js <command> [options]
 *
 * Commands:
 *   list                                    List all collections
 *   create <id> <name> [--desc D] [--scope S] [--tags T]
 *   delete <id>                             Delete collection
 *   docs <collection> [--limit N]           List documents
 *   add <collection> --text T [--id I] [--tags T] [--meta JSON]
 *   upload <collection> <file> [--chunk N]  Upload text file
 *   batch <collection> <dir> [--chunk N] [--ext .txt,.md]
 *                                           Batch upload all files from directory
 *   search <collection> <query> [--k N]     Semantic search
 *   forget                                  Clear all RAG memory
 *
 * Environment:
 *   CLOUD_LLM_HUB_URL    Base URL (default: http://localhost:4004)
 *   CLOUD_LLM_HUB_TOKEN  JWT token for auth
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = process.env.CLOUD_LLM_HUB_URL || 'http://localhost:4004';
const TOKEN = process.env.CLOUD_LLM_HUB_TOKEN || '';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function api(method, urlPath, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE_URL}/v1${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = data?.error?.message || text;
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val =
        args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
      flags[key] = val;
      i += val === true ? 1 : 2;
    } else {
      positional.push(args[i]);
      i++;
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList() {
  const data = await api('GET', '/rag/collections');
  if (!data.collections?.length) {
    console.log('No collections.');
    return;
  }
  console.log(
    `\n${'ID'.padEnd(25)} ${'Name'.padEnd(25)} ${'Scope'.padEnd(8)} ${'Docs'.padEnd(6)} Backend`,
  );
  console.log('-'.repeat(85));
  for (const c of data.collections) {
    console.log(
      `${c.id.padEnd(25)} ${c.displayName.padEnd(25)} ${c.scope.padEnd(8)} ${String(c.documentCount).padEnd(6)} ${c.backend || 'default'}`,
    );
    if (c.description) console.log(`  ${c.description}`);
  }
  console.log(`\nTotal: ${data.collections.length} collections`);
}

async function cmdCreate(args) {
  const { positional, flags } = parseArgs(args);
  const id = positional[0];
  const displayName = positional[1];
  if (!id || !displayName) {
    console.error(
      'Usage: create <id> <name> [--desc D] [--scope user|global] [--tags T] [--backend B]',
    );
    process.exit(1);
  }
  const body = {
    id,
    displayName,
    description: flags.desc || undefined,
    scope: flags.scope || 'user',
    tags: flags.tags || undefined,
    backend: flags.backend || undefined,
  };
  const result = await api('POST', '/rag/collections', body);
  console.log(
    `Created: ${result.id} (${result.scope}, ${result.backend || 'default'})`,
  );
}

async function cmdDelete(args) {
  const id = args[0];
  if (!id) {
    console.error('Usage: delete <id>');
    process.exit(1);
  }
  await api('DELETE', `/rag/collections/${id}`);
  console.log(`Deleted: ${id}`);
}

async function cmdDocs(args) {
  const { positional, flags } = parseArgs(args);
  const col = positional[0];
  if (!col) {
    console.error('Usage: docs <collection> [--limit N]');
    process.exit(1);
  }
  const limit = flags.limit || 50;
  const data = await api(
    'GET',
    `/rag/collections/${col}/documents?limit=${limit}`,
  );
  if (!data.documents?.length) {
    console.log('No documents.');
    return;
  }
  for (const d of data.documents) {
    const tags = d.metadata?.tags ? ` [${d.metadata.tags.join(', ')}]` : '';
    const source = d.metadata?.source ? ` (${d.metadata.source})` : '';
    console.log(`\n--- ${d.id}${tags}${source} ---`);
    console.log(d.text.length > 200 ? d.text.slice(0, 200) + '...' : d.text);
    console.log(`  created: ${d.createdAt}`);
  }
  console.log(`\nTotal: ${data.total} documents`);
}

async function cmdAdd(args) {
  const { positional, flags } = parseArgs(args);
  const col = positional[0];
  const text = flags.text;
  if (!col || !text) {
    console.error(
      'Usage: add <collection> --text "document text" [--id I] [--tags T] [--meta JSON]',
    );
    process.exit(1);
  }
  const metadata = {};
  if (flags.tags) metadata.tags = flags.tags.split(',').map((t) => t.trim());
  if (flags.meta) {
    try {
      Object.assign(metadata, JSON.parse(flags.meta));
    } catch {
      console.error('Invalid --meta JSON');
      process.exit(1);
    }
  }
  const body = {
    id: flags.id || undefined,
    text,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
  const result = await api('POST', `/rag/collections/${col}/documents`, body);
  console.log(`Added: ${result.id} (${result.text.length} chars)`);
}

async function cmdUpload(args) {
  const { positional, flags } = parseArgs(args);
  const col = positional[0];
  const filePath = positional[1];
  if (!col || !filePath) {
    console.error('Usage: upload <collection> <file> [--chunk N]');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const filename = path.basename(filePath);
  const chunkSize = Number(flags.chunk) || 2000;

  console.log(
    `Uploading ${filename} (${(content.length / 1024).toFixed(1)} KB, chunk=${chunkSize})...`,
  );
  const result = await api('POST', `/rag/collections/${col}/upload`, {
    filename,
    content,
    chunkSize,
  });
  console.log(`Done: ${result.chunks} chunks, ${result.added} added`);
  if (result.errors?.length) {
    console.warn(`Errors: ${result.errors.length}`);
    for (const e of result.errors) console.warn(`  ${e}`);
  }
}

async function cmdBatch(args) {
  const { positional, flags } = parseArgs(args);
  const col = positional[0];
  const dirPath = positional[1];
  if (!col || !dirPath) {
    console.error(
      'Usage: batch <collection> <directory> [--chunk N] [--ext .txt,.md] [--delay MS]',
    );
    process.exit(1);
  }
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    console.error(`Directory not found: ${dirPath}`);
    process.exit(1);
  }

  const extensions = (flags.ext || '.txt,.md,.csv,.json,.yaml,.yml,.xml,.log')
    .split(',')
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
  const chunkSize = Number(flags.chunk) || 2000;
  const delayMs = Number(flags.delay) || 500;

  // Collect files recursively
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.'))
          continue;
        walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(full);
      }
    }
  }
  walk(dirPath);

  if (files.length === 0) {
    console.log(`No files matching ${extensions.join(', ')} in ${dirPath}`);
    return;
  }

  console.log(`\nBatch upload: ${files.length} files → collection "${col}"`);
  console.log(`Chunk size: ${chunkSize}, delay: ${delayMs}ms between files`);
  console.log('-'.repeat(60));

  let totalChunks = 0;
  let totalAdded = 0;
  let totalErrors = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const filename = path.basename(filePath);
    const relPath = path.relative(dirPath, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    if (!content.trim()) {
      console.log(`[${i + 1}/${files.length}] ${relPath} — empty, skipped`);
      continue;
    }

    try {
      const result = await api('POST', `/rag/collections/${col}/upload`, {
        filename: relPath,
        content,
        chunkSize,
      });
      totalChunks += result.chunks;
      totalAdded += result.added;
      totalErrors += result.errors?.length || 0;
      console.log(
        `[${i + 1}/${files.length}] ${relPath} — ${result.chunks} chunks, ${result.added} added`,
      );
    } catch (err) {
      totalErrors++;
      console.error(
        `[${i + 1}/${files.length}] ${relPath} — ERROR: ${err.message}`,
      );
    }

    // Throttle to avoid embedder rate limits
    if (i < files.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log('-'.repeat(60));
  console.log(
    `Total: ${files.length} files, ${totalChunks} chunks, ${totalAdded} added, ${totalErrors} errors`,
  );
}

async function cmdSearch(args) {
  const { positional, flags } = parseArgs(args);
  const col = positional[0];
  const query = positional.slice(1).join(' ');
  if (!col || !query) {
    console.error('Usage: search <collection> <query> [--k N]');
    process.exit(1);
  }
  const k = Number(flags.k) || 10;
  const data = await api('POST', `/rag/collections/${col}/query`, {
    text: query,
    k,
  });
  if (!data.results?.length) {
    console.log('No results.');
    return;
  }
  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    console.log(`\n#${i + 1} (score: ${r.score.toFixed(4)})`);
    console.log(r.text.length > 300 ? r.text.slice(0, 300) + '...' : r.text);
  }
}

async function cmdForget() {
  const readline = require('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) =>
    rl.question('Clear ALL RAG memory? (y/N) ', resolve),
  );
  rl.close();
  if (answer.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    return;
  }
  await api('DELETE', '/memory');
  console.log('All RAG memory cleared.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    console.log(`
RAG CLI — manage cloud-llm-hub RAG collections

Commands:
  list                                       List all collections
  create <id> <name> [--desc D] [--scope S]  Create collection
  delete <id>                                Delete collection
  docs <collection> [--limit N]              List documents
  add <collection> --text T [--id I] [--tags T] [--meta JSON]
  upload <collection> <file> [--chunk N]     Upload single file
  batch <collection> <dir> [--chunk N] [--ext .txt,.md] [--delay MS]
                                             Batch upload directory
  search <collection> <query> [--k N]        Semantic search
  forget                                     Clear all RAG memory

Environment:
  CLOUD_LLM_HUB_URL    ${BASE_URL}
  CLOUD_LLM_HUB_TOKEN  ${TOKEN ? '(set)' : '(not set)'}
`);
    return;
  }

  try {
    switch (command) {
      case 'list':
      case 'ls':
        await cmdList();
        break;
      case 'create':
        await cmdCreate(rest);
        break;
      case 'delete':
      case 'rm':
        await cmdDelete(rest);
        break;
      case 'docs':
        await cmdDocs(rest);
        break;
      case 'add':
        await cmdAdd(rest);
        break;
      case 'upload':
        await cmdUpload(rest);
        break;
      case 'batch':
        await cmdBatch(rest);
        break;
      case 'search':
      case 'query':
        await cmdSearch(rest);
        break;
      case 'forget':
        await cmdForget();
        break;
      default:
        console.error(
          `Unknown command: ${command}\nRun with --help for usage.`,
        );
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
