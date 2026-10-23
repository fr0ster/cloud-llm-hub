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
 *   npx tsx tools/generate-tool-embeddings.ts [--mtaext <file>] [--aicore-key <file>]
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
import {
  type AgentConfig,
  aiCoreServiceKeyFromEnv,
  loadAgentConfig,
} from '../srv/agent-config';
import {
  getSharedCorpusDocs,
  loadToolEmbeddingBundle,
  planBundleLoad,
  type ToolEmbeddingBundle,
} from '../srv/agent-manager';
import { BuildValidationError } from '../srv/lib/build-validation-error';
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
export async function checkCanary(embedder: IEmbedder): Promise<number[]> {
  const canaryVector = round6(await embedWithRetry(embedder, CANARY));
  const canaryVector2 = round6(await embedWithRetry(embedder, CANARY));
  const cos = cosine(canaryVector, canaryVector2);
  if (cos < 0.9999) {
    throw new BuildValidationError(
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
  if (!p.embedding) throw new BuildValidationError('no embedder configured');
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
  if (!q)
    throw new BuildValidationError(
      'tools are on qdrant but no Qdrant is configured',
    );
  if (!p.embedding) throw new BuildValidationError('no embedder configured');
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
  requireBuildCredentials(config);
  await checkCanary(embedder);
  for (const role of todo) {
    const expected = roles[role].length;
    const name = toolStoreName(role);
    const collection = p.stores.qdrantCollection(name);
    // An empty role would never create its store, so nothing could be counted
    // or recorded; say so instead of failing on a missing collection.
    if (expected === 0)
      throw new BuildValidationError(
        `${role}: the corpus has no ${role} tools`,
      );

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
      throw new BuildValidationError(
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
      throw new BuildValidationError(
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
/**
 * The build needs only the embedder and the tools class. The session and
 * persistent classes are set to in-memory, so their backends (an HDI binding
 * that exists only in Cloud Foundry, a Postgres) are never opened here.
 */
export function toolBuildConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    rag: {
      ...config.rag,
      backends: {
        ...config.rag.backends,
        session: 'in-memory',
        persistent: 'in-memory',
      },
    },
  };
}

export function resolveAiCoreCredentials(
  env: NodeJS.ProcessEnv,
  services:
    | Record<string, Array<{ credentials?: unknown }>>
    | (() => Record<string, Array<{ credentials?: unknown }>>) = {},
  keyFile?: string,
): void {
  let bindings: Record<string, Array<{ credentials?: unknown }>> = {};
  if (env.VCAP_SERVICES) {
    try {
      bindings = JSON.parse(env.VCAP_SERVICES);
      if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
        throw new Error();
    } catch {
      throw new BuildValidationError('Could not read VCAP_SERVICES as JSON');
    }
  }
  let key = env.AICORE_SERVICE_KEY;
  if (!key) {
    for (const getSource of [
      () => bindings,
      () => (typeof services === 'function' ? services() : services),
    ]) {
      const source = getSource();
      const binding = source.aicore?.[0] ?? source['ai-core']?.[0];
      if (binding?.credentials) {
        key = JSON.stringify(binding.credentials);
        break;
      }
    }
  }
  key ||= aiCoreServiceKeyFromEnv(env);
  if (!key && keyFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error();
      key = JSON.stringify(parsed);
    } catch {
      throw new BuildValidationError(
        'Could not read AI Core service key JSON from --aicore-key file',
      );
    }
  }
  if (key) env.AICORE_SERVICE_KEY = key;
  else delete env.AICORE_SERVICE_KEY;
  // Resolve first, then remove bindings so runtime readers cannot override
  // the selected key with a lower-priority account. Preserve other services.
  if (env.VCAP_SERVICES) {
    delete bindings.aicore;
    delete bindings['ai-core'];
    env.VCAP_SERVICES = JSON.stringify(bindings);
  }
}

/** Downstream messages, stacks, bodies and headers are never diagnostics. */
export function reportBuildError(err: unknown): void {
  if (err instanceof BuildValidationError) {
    console.error(`${err.name}: ${err.message}`);
    return;
  }
  const error = (err && typeof err === 'object' ? err : {}) as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    config?: { url?: unknown; baseURL?: unknown };
    request?: { host?: unknown; hostname?: unknown };
  };
  const name =
    typeof error.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : 'Error';
  const fields = [name];
  if (
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)
  )
    fields.push(`code=${error.code}`);
  const status = error.response?.status ?? error.status;
  if (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  )
    fields.push(`status=${status}`);
  const target =
    error.config?.url ?? error.request?.hostname ?? error.request?.host;
  if (typeof target === 'string') {
    try {
      const base = error.config?.baseURL;
      const url = new URL(
        typeof base === 'string' ||
          target.includes('://') ||
          target.startsWith('/')
          ? target
          : `https://${target}`,
        typeof base === 'string' ? base : undefined,
      );
      if (url.protocol === 'http:' || url.protocol === 'https:')
        fields.push(`host=${url.hostname}`);
    } catch {
      // An invalid request URL is omitted, never echoed.
    }
  }
  console.error(
    `${fields.join(' ')}: AI Core embedding request failed; check the AI Core credentials and network; details withheld because they can contain credentials`,
  );
}

export function requireBuildCredentials(config: AgentConfig): void {
  if (
    config.rag.embedder?.kind === 'sap-ai-core' &&
    !process.env.AICORE_SERVICE_KEY
  ) {
    throw new BuildValidationError(
      'AI Core credentials required to regenerate tool vectors: set AICORE_SERVICE_KEY, provide default-env.json VCAP_SERVICES, set AICORE_CLIENT_ID, AICORE_CLIENT_SECRET, AICORE_AUTH_URL and AICORE_BASE_URL in the repo .env, or use --aicore-key <file>.',
    );
  }
}

export function loadTargetConfig(argv: string[]): AgentConfig {
  const defaultEnvPath = path.resolve(__dirname, '../default-env.json');
  const services = () => {
    if (!fs.existsSync(defaultEnvPath)) return {};
    try {
      return (
        JSON.parse(fs.readFileSync(defaultEnvPath, 'utf8')).VCAP_SERVICES ?? {}
      );
    } catch {
      throw new BuildValidationError(
        'Could not read default-env.json service bindings as JSON',
      );
    }
  };
  loadDotenv({ path: path.resolve(__dirname, '../.env'), quiet: true });
  const at = argv.indexOf('--mtaext');
  if (at >= 0) {
    const file = argv[at + 1];
    if (!file || file.startsWith('--'))
      throw new BuildValidationError('--mtaext needs a file');
    applyMtaext(file, process.env);
  }
  const keyAt = argv.indexOf('--aicore-key');
  const keyFile = keyAt >= 0 ? argv[keyAt + 1] : undefined;
  if (keyAt >= 0 && (!keyFile || keyFile.startsWith('--')))
    throw new BuildValidationError('--aicore-key needs a file');
  resolveAiCoreCredentials(process.env, services, keyFile);
  return loadAgentConfig();
}

/** The only trusted-error boundary: configuration is entirely local. */
export function loadBuildConfiguration(argv: string[]): {
  config: AgentConfig;
  providerConfig: AgentConfig;
} {
  try {
    const config = loadTargetConfig(argv);
    return { config, providerConfig: toolBuildConfig(config) };
  } catch (error) {
    // Validators echo rejected values as JSON after `got`. Those values may
    // be credentials accidentally assigned to the wrong variable. YAML errors
    // can include entire source lines, including unrelated secret parameters.
    const message =
      error instanceof Error
        ? error.name === 'YAMLException'
          ? 'Could not read --mtaext configuration as YAML'
          : error.message
              .replace(/\bgot [\s\S]*/g, 'got [REDACTED]')
              .replace(
                /^(Invalid LLM_AGENT_(?:TOOL_GATE|CHAT_COORDINATOR): )[\s\S]*(; expected)/,
                '$1[REDACTED]$2',
              )
              .replace(
                /((?:invalid log level|malformed entry) ")[\s\S]*("; expected)/,
                '$1[REDACTED]$2',
              )
        : 'Could not load build configuration';
    throw new BuildValidationError(message);
  }
}

async function main() {
  const { config, providerConfig } = loadBuildConfiguration(
    process.argv.slice(2),
  );
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

  // Reviewable regeneration inputs when an embedder is unavailable. No vectors
  // are relabelled: the previous bundle remains stale until a real build succeeds.
  const inputAt = process.argv.indexOf('--inputs-only');
  if (inputAt >= 0) {
    const output = process.argv[inputAt + 1];
    if (!output)
      throw new BuildValidationError('--inputs-only needs an output file');
    fs.writeFileSync(
      output,
      `${JSON.stringify({ coreVersion: readCoreVersion(), docs }, null, 2)}\n`,
    );
    console.log(`Wrote ${docs.length} inputs to ${output}`);
    return;
  }

  const p = await startProviders(providerConfig);
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
      requireBuildCredentials(config);
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

/** Installed only by the CLI; imports leave the host process untouched. */
export function installCliErrorHandlers(): (err: unknown) => never {
  const fail = (err: unknown): never => {
    reportBuildError(err);
    process.exit(1);
  };
  process.on('unhandledRejection', fail);
  process.on('uncaughtException', fail);
  return fail;
}

if (require.main === module) {
  const fail = installCliErrorHandlers();
  main().catch(fail);
}
