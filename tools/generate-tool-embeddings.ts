/**
 * Generate the tool-embedding bundle for the shared tool-RAG store.
 *
 * Precomputes embeddings for the FULL (all-cached) tool corpus and writes
 * `srv/tool-embeddings.json`, which the runtime loads at startup via
 * `upsertPrecomputedRaw` — zero runtime embedding of the tool corpus, so there
 * is no cold-start vectorization after a deploy.
 *
 * Committed to git (like `srv/tool-intents.json`); regenerate whenever the tool
 * set, `tool-intents.json`, or the embedder (provider/model/endpoint) changes.
 *
 * Usage:
 *   npx tsx tools/generate-tool-embeddings.ts
 *
 * Loads default-env.json (VCAP_SERVICES) for SAP AI Core — same as cds watch /
 * the intents generator. Aborts if any tool is missing from tool-intents.json
 * (run tools/generate-tool-intents.ts first).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenAiEmbedder } from '@mcp-abap-adt/openai-embedder';
import { getSharedCorpusDocs } from '../srv/agent-manager';
import { SapAiCoreEmbedder } from '../srv/lib/sap-ai-core-embedder';

// Load default-env.json (VCAP_SERVICES) for SAP AI SDK — same as cds watch.
const defaultEnvPath = path.resolve(__dirname, '../default-env.json');
if (fs.existsSync(defaultEnvPath)) {
  const defaultEnv = JSON.parse(fs.readFileSync(defaultEnvPath, 'utf-8'));
  if (defaultEnv.VCAP_SERVICES && !process.env.VCAP_SERVICES) {
    process.env.VCAP_SERVICES = JSON.stringify(defaultEnv.VCAP_SERVICES);
  }
}

const PROVIDER = process.env.LLM_AGENT_PROVIDER || 'sap-ai-sdk';
const EMBEDDING_MODEL =
  process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small';
const RESOURCE_GROUP = process.env.LLM_AGENT_RESOURCE_GROUP || 'default';
const BASE_URL = process.env.LLM_AGENT_BASE_URL;
const OUTPUT = path.resolve(__dirname, '../srv/tool-embeddings.json');
const CANARY = 'cloud-llm-hub tool-embedding canary v1';

interface Embedder {
  embed(text: string): Promise<{ vector: number[] }>;
}

function makeEmbedder(): Embedder {
  if (PROVIDER === 'sap-ai-sdk') {
    return new SapAiCoreEmbedder({
      model: EMBEDDING_MODEL,
      resourceGroup: RESOURCE_GROUP,
    });
  }
  return new OpenAiEmbedder({
    apiKey: process.env.LLM_AGENT_API_KEY || '',
    baseURL: BASE_URL,
    model: EMBEDDING_MODEL,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Embed with backoff retry on 429 / transient errors (AI Core throttles). */
async function embedWithRetry(
  embedder: Embedder,
  text: string,
): Promise<number[]> {
  let delay = 2000;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return (await embedder.embed(text)).vector;
    } catch (err) {
      const msg = String(err);
      const retryable = msg.includes('429') || msg.includes('503');
      if (!retryable || attempt === 5) throw err;
      process.stdout.write(`    throttled (429), retry in ${delay}ms...\n`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
  throw new Error('unreachable');
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main() {
  const docs = getSharedCorpusDocs();

  // Fail-fast: the bundle must be the FULL all-cached corpus so `entry count ==
  // tool count` holds and per-entry text is deterministic.
  const uncached = docs.filter((d) => !d.cached);
  if (uncached.length > 0) {
    console.error(
      `ABORT: ${uncached.length} tool(s) missing from tool-intents.json — run ` +
        `tools/generate-tool-intents.ts first, then regenerate embeddings.\n` +
        `Missing: ${uncached.map((d) => d.name).join(', ')}`,
    );
    process.exit(1);
  }

  // Read the tool library's version early (fail before spending embeds). Its
  // package.json is not exposed via `exports`, so read the file directly. The
  // field in the bundle header is still called `coreVersion`: the handlers moved
  // from @mcp-abap-adt/core to @mcp-abap-adt/lib in lib 10, and renaming the
  // field would invalidate every bundle already generated for no gain.
  const coreVersion = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../node_modules/@mcp-abap-adt/lib/package.json'),
      'utf-8',
    ),
  ).version as string;

  const embedder = makeEmbedder();
  console.log(
    `Embedding ${docs.length} tool docs (provider=${PROVIDER}, model=${EMBEDDING_MODEL}, core=${coreVersion})...`,
  );

  const entries: {
    id: string;
    name: string;
    text: string;
    vector: number[];
    exposition?: string;
  }[] = [];
  // Round to 6 decimals — negligible cosine impact, ~40% smaller committed file.
  const round6 = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);
  for (const d of docs) {
    const vector = round6(await embedWithRetry(embedder, d.text));
    entries.push({
      id: d.id,
      name: d.name,
      text: d.text,
      vector,
      exposition: d.exposition,
    });
    process.stdout.write(`  ${d.name}: ${vector.length}d\n`);
    await sleep(120); // throttle — AI Core embedding endpoint rate-limits
  }

  // Generation-time canary determinism check (NOT a runtime load-path call).
  const canaryVector = round6(await embedWithRetry(embedder, CANARY));
  const canaryVector2 = round6(await embedWithRetry(embedder, CANARY));
  const cos = cosine(canaryVector, canaryVector2);
  if (cos < 0.9999) {
    console.error(
      `ABORT: canary embeddings non-deterministic (cosine ${cos.toFixed(6)}) — ` +
        `embedder unstable; the bundle would not match at runtime.`,
    );
    process.exit(1);
  }

  const embeddingDim = entries[0]?.vector.length ?? 0;

  const bundle = {
    header: {
      embedderFingerprint: {
        provider: PROVIDER,
        embeddingModel: EMBEDDING_MODEL,
        ...(PROVIDER === 'sap-ai-sdk'
          ? { resourceGroup: RESOURCE_GROUP }
          : { baseURL: BASE_URL }),
      },
      embeddingDim,
      coreVersion,
      generatedAt: new Date().toISOString(),
      canary: { text: CANARY, vector: canaryVector },
    },
    entries,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(bundle));
  console.log(
    `Wrote ${entries.length} entries (dim ${embeddingDim}, core ${coreVersion}) to ${OUTPUT}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
