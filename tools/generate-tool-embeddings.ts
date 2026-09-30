/**
 * The tool-corpus build step (spec §4.4). Run by `dev:local` and by
 * `tools/deploy.sh` before `cf deploy`; startup only loads what it writes and
 * never embeds the corpus.
 *
 * It resolves the target configuration with the app's own rules
 * (`loadAgentConfig`), embeds the full (all-cached) corpus with that
 * configuration's embedder, and writes it to the configured `tools` backend:
 *   - in-memory: nothing to build;
 *   - vector: the bundle `srv/<bundleFileFor(fingerprint)>`. The committed
 *     AI Core bundle `srv/tool-embeddings.json` stays the default one; every
 *     other fingerprint gets `srv/tool-embeddings.<fp>.json` (not committed);
 *   - qdrant: ONE store per role with a fixed name, `<prefix>-tools-reader`
 *     and `<prefix>-tools-writer`, holding the current corpus only. Its record
 *     in `<prefix>-catalog` carries the embedder fingerprint hash and the
 *     role's corpus hash. A role whose hashes match is skipped; any other is
 *     replaced: old store and record deleted, current corpus written, count
 *     verified, then the record written.
 * A matching bundle or current role stores make it exit 0 with zero
 * embedding calls.
 *
 * Usage:
 *   npx tsx tools/generate-tool-embeddings.ts [--mtaext <file>]
 *
 * Loads `.env` (secrets such as LLM_AGENT_API_KEY), then the `parameters` of
 * the given `.mtaext` — those win, because that is what the deployed app runs
 * with — and default-env.json (VCAP_SERVICES) for SAP AI Core. Aborts if any
 * tool is missing from tool-intents.json (run tools/generate-tool-intents.ts
 * first).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DuplicateCollectionError,
  type IEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { config as loadDotenv } from 'dotenv';
import { load as loadYaml } from 'js-yaml';
import { type AgentConfig, loadAgentConfig } from '../srv/agent-config';
import {
  getSharedCorpusDocs,
  loadToolEmbeddingBundle,
  planBundleLoad,
  type ToolEmbeddingBundle,
} from '../srv/agent-manager';
import {
  type EmbedderFingerprint,
  type Providers,
  startProviders,
} from '../srv/lib/providers';
import { toolCatalogProvider } from '../srv/lib/rag-store-factory';
import {
  bundleFileFor,
  corpusByRole,
  recordIsCurrent,
  type SharedCorpusDoc,
  type ToolRole,
  toolRecordAttributes,
  toolStoreName,
} from '../srv/lib/tool-corpus';

const CANARY = 'cloud-llm-hub tool-embedding canary v1';
const ROLES: readonly ToolRole[] = ['reader', 'writer'];

/**
 * Copy the `parameters` map of an MTA extension descriptor into `env`. Values
 * from the file win over values already set; null parameters are left out.
 */
export function applyMtaext(file: string, env: NodeJS.ProcessEnv): void {
  const doc = loadYaml(fs.readFileSync(file, 'utf8')) as {
    parameters?: Record<string, unknown>;
  } | null;
  for (const [k, v] of Object.entries(doc?.parameters ?? {})) {
    if (v !== null && v !== undefined) env[k] = String(v);
  }
}

export type BuildDecision =
  | { action: 'none'; reason: 'tools are in-memory' }
  | { action: 'skip'; reason: string }
  | { action: 'build-bundle'; file: string }
  | { action: 'build-qdrant' };

/** What the build step has to do for this configuration. Pure; embeds nothing. */
export function decideToolBuild(
  config: AgentConfig,
  fingerprint: EmbedderFingerprint | null,
  docs: SharedCorpusDoc[],
  readBundle: (file: string) => ToolEmbeddingBundle | null,
): BuildDecision {
  const target = config.rag.backends.tools;
  if (target === 'in-memory' || !fingerprint)
    return { action: 'none', reason: 'tools are in-memory' };
  if (target === 'qdrant') return { action: 'build-qdrant' }; // per-role skip via completion records
  const file = bundleFileFor(fingerprint);
  const plan = planBundleLoad(readBundle(file), docs, fingerprint);
  return plan.usable && plan.supplementNames.length === 0
    ? { action: 'skip', reason: `${file} already matches` }
    : { action: 'build-bundle', file };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Embed with backoff retry on 429 / transient errors (AI Core throttles). */
async function embedWithRetry(
  embedder: IEmbedder,
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

// Round to 6 decimals — negligible cosine impact, ~40% smaller bundle file.
const round6 = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);

/** Generation-time canary determinism check (NOT a runtime load-path call). */
async function checkCanary(embedder: IEmbedder): Promise<number[]> {
  const canaryVector = round6(await embedWithRetry(embedder, CANARY));
  const canaryVector2 = round6(await embedWithRetry(embedder, CANARY));
  const cos = cosine(canaryVector, canaryVector2);
  if (cos < 0.9999) {
    throw new Error(
      `ABORT: canary embeddings non-deterministic (cosine ${cos.toFixed(6)}) — ` +
        'embedder unstable; the built vectors would not match at runtime.',
    );
  }
  return canaryVector;
}

export interface BuildOptions {
  /** Pause between embedding calls — AI Core's endpoint rate-limits. */
  throttleMs: number;
  log: (line: string) => void;
}

/** The tool library's version, for the bundle header. */
function readCoreVersion(): string {
  // Its package.json is not exposed via `exports`, so read the file directly.
  // The header field is still called `coreVersion`: the handlers moved from
  // @mcp-abap-adt/core to @mcp-abap-adt/lib in lib 10, and renaming the field
  // would invalidate every bundle already generated for no gain.
  return JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../node_modules/@mcp-abap-adt/lib/package.json'),
      'utf-8',
    ),
  ).version as string;
}

/** Embed the corpus and write the bundle `srv/<file>`. */
export async function buildBundle(
  p: Providers,
  docs: SharedCorpusDoc[],
  file: string,
  opts: BuildOptions,
): Promise<string> {
  if (!p.embedding) throw new Error('no embedder configured');
  const { embedder, fingerprint } = p.embedding;
  const coreVersion = readCoreVersion();
  const output = path.resolve(__dirname, '../srv', file);
  opts.log(
    `Embedding ${docs.length} tool docs (embedder=${fingerprint.provider}, model=${fingerprint.embeddingModel}, core=${coreVersion})...`,
  );
  const entries: ToolEmbeddingBundle['entries'] = [];
  for (const d of docs) {
    const vector = round6(await embedWithRetry(embedder, d.text));
    entries.push({
      id: d.id,
      name: d.name,
      text: d.text,
      vector,
      exposition: d.exposition,
    });
    opts.log(`  ${d.name}: ${vector.length}d`);
    await sleep(opts.throttleMs);
  }
  const canaryVector = await checkCanary(embedder);
  const embeddingDim = entries[0]?.vector.length ?? 0;
  const bundle: ToolEmbeddingBundle = {
    header: {
      embedderFingerprint: fingerprint,
      embeddingDim,
      coreVersion,
      generatedAt: new Date().toISOString(),
      canary: { text: CANARY, vector: canaryVector },
    },
    entries,
  };
  fs.writeFileSync(output, JSON.stringify(bundle));
  opts.log(
    `Wrote ${entries.length} entries (dim ${embeddingDim}, core ${coreVersion}) to ${output}`,
  );
  return output;
}

/**
 * Bring each role's fixed-name Qdrant store to the current corpus (spec §4.4).
 * A role whose record carries the current fingerprint and corpus hashes is
 * skipped with zero embedding calls. Any other role is REPLACED: the old store
 * and its record go, the current corpus is written, the count is verified,
 * and only then is the record written. Returns the roles written.
 */
export async function buildQdrantStores(
  config: AgentConfig,
  p: Providers,
  docs: SharedCorpusDoc[],
  opts: BuildOptions,
): Promise<ToolRole[]> {
  const q = config.rag.qdrant;
  if (!q) throw new Error('tools are on qdrant but no Qdrant is configured');
  if (!p.embedding) throw new Error('no embedder configured');
  const { embedder, retrieval, fingerprint: fp } = p.embedding;
  const roles = corpusByRole(docs);
  const provider = toolCatalogProvider(q, retrieval);
  const described = await provider.describeCollections();
  if (!described.ok)
    throw new Error(
      `Qdrant catalog unreachable at ${q.url}: ${described.error.message}`,
    );
  const catalog = new Map(
    described.value.records.map((r) => [r.storeName, r.attributes]),
  );

  const todo: ToolRole[] = [];
  for (const role of ROLES) {
    const collection = p.stores.qdrantCollection(toolStoreName(role));
    if (
      catalog.has(collection) &&
      recordIsCurrent(catalog.get(collection), fp, roles[role])
    )
      opts.log(`${role}: current, skipped`);
    else todo.push(role);
  }
  if (todo.length === 0) return [];

  const existing = await p.stores.listStores('tools', 'tools-');
  if (!existing.ok) throw existing.error;
  await checkCanary(embedder);
  for (const role of todo) {
    const expected = roles[role].length;
    const name = toolStoreName(role);
    const collection = p.stores.qdrantCollection(name);
    // An empty role would never create its store, so nothing could be counted
    // or recorded; say so instead of failing on a missing collection.
    if (expected === 0)
      throw new Error(`${role}: the corpus has no ${role} tools`);

    // Replace: the record first, then the store (deleteCollection's order), so
    // an interrupted replace never leaves a record over a partial store.
    if (catalog.has(collection)) {
      const del = await provider.deleteCollection(collection);
      if (!del.ok) throw del.error;
      opts.log(`${role}: stale record, replacing ${collection}`);
    } else if (existing.value.includes(name)) {
      const del = await p.stores.deleteStore('tools', name);
      if (!del.ok) throw del.error;
      opts.log(`${role}: store without a record, replacing ${collection}`);
    }

    const write = p.stores
      .create('tools', name)
      .writer?.()?.upsertPrecomputedRaw;
    if (!write)
      throw new Error(
        `${role}: the tools store cannot take precomputed vectors`,
      );
    opts.log(`${role}: embedding ${expected} tool docs into ${collection}...`);
    // QdrantRag creates the collection on the first write.
    for (const d of roles[role]) {
      const vector = await embedWithRetry(embedder, d.text);
      const res = await write(
        d.id,
        d.text,
        vector,
        d.exposition ? { exposition: d.exposition } : {},
      );
      if (!res.ok)
        throw new Error(
          `${role}: writing ${d.id} to ${collection} failed: ${res.error.message}`,
        );
      await sleep(opts.throttleMs);
    }
    const applied = await p.stores.awaitWrites('tools', name);
    if (!applied.ok) throw applied.error;
    const count = await p.stores.countPoints('tools', name);
    if (!count.ok) throw count.error;
    if (count.value !== expected)
      throw new Error(
        `${role}: ${collection} holds ${count.value} points, expected ${expected}`,
      );
    const rec = await provider.createCollection(collection, {
      scope: 'global',
      adoptExisting: true,
      collectionName: collection,
      attributes: toolRecordAttributes(role, fp, roles[role]),
    });
    // A concurrent build of the same corpus recorded it first: the points are
    // the same (deterministic ids), so the role is current either way.
    if (!rec.ok && !(rec.error instanceof DuplicateCollectionError))
      throw rec.error;
    opts.log(`${role}: wrote ${expected} points to ${collection}, recorded`);
  }
  return todo;
}

/**
 * The target configuration, from the same sources the deployed app gets:
 * default-env.json (VCAP_SERVICES for SAP AI Core), `.env` (secrets such as
 * LLM_AGENT_API_KEY), then `--mtaext <file>`'s parameters, which win. Writes
 * them into `process.env`, because `loadAgentConfig` reads only that.
 */
export function loadTargetConfig(argv: string[]): AgentConfig {
  const defaultEnvPath = path.resolve(__dirname, '../default-env.json');
  if (fs.existsSync(defaultEnvPath)) {
    const defaultEnv = JSON.parse(fs.readFileSync(defaultEnvPath, 'utf-8'));
    if (defaultEnv.VCAP_SERVICES && !process.env.VCAP_SERVICES) {
      process.env.VCAP_SERVICES = JSON.stringify(defaultEnv.VCAP_SERVICES);
    }
  }
  loadDotenv({ quiet: true });
  const at = argv.indexOf('--mtaext');
  if (at >= 0) {
    const file = argv[at + 1];
    if (!file) throw new Error('--mtaext needs a file');
    applyMtaext(file, process.env);
  }
  return loadAgentConfig();
}

async function main() {
  const config = loadTargetConfig(process.argv.slice(2));
  console.log('effective config', {
    ragBackends: config.rag.backends,
    embedder: config.rag.embedder?.kind,
  });

  const docs = getSharedCorpusDocs();
  // Fail-fast: the build must cover the FULL all-cached corpus so `entry count
  // == tool count` holds and per-entry text is deterministic.
  const uncached = docs.filter((d) => !d.cached);
  if (uncached.length > 0) {
    console.error(
      `ABORT: ${uncached.length} tool(s) missing from tool-intents.json — run ` +
        `tools/generate-tool-intents.ts first, then regenerate embeddings.\n` +
        `Missing: ${uncached.map((d) => d.name).join(', ')}`,
    );
    process.exit(1);
  }

  const p = await startProviders(config);
  const decision = decideToolBuild(
    config,
    p.embedding?.fingerprint ?? null,
    docs,
    loadToolEmbeddingBundle,
  );
  const opts: BuildOptions = {
    throttleMs: 120,
    log: (line) => console.log(line),
  };
  switch (decision.action) {
    case 'none':
    case 'skip':
      console.log(`Nothing to build: ${decision.reason}`);
      return;
    case 'build-bundle':
      await buildBundle(p, docs, decision.file, opts);
      return;
    case 'build-qdrant': {
      const built = await buildQdrantStores(config, p, docs, opts);
      if (built.length === 0)
        console.log('Nothing to build: every Qdrant role store is current');
      return;
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
