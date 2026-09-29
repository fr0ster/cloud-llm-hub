# Configurable providers — Plan A: configuration, providers, build-time tool vectors, local run

<!-- docs-check:proposed-env — this plan names configuration that does not exist
     yet, by design; the env-name check is skipped here. -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Choose the embedder, the per-class RAG backend and the destination
source in configuration. Compute tool vectors at build time and only load them
at startup. Ship a local-run kit (Ollama + Qdrant + env destinations) that runs
the full agent against a real SAP system.

**Architecture:** `agent-config.ts` parses the new variables into typed
config. A new `srv/lib/providers.ts` turns it into instances once, in a short
async startup step: embedder, a synchronous `RagStoreFactory`, and a
`DestinationSource`. `agent-manager` receives them through `initProviders()`
instead of deciding by itself. The tool-embeddings generator becomes the build
step that writes a bundle or a Qdrant generation; startup only loads it.

**Tech Stack:** TypeScript (CommonJS), SAP CAP 10, jest 30 + ts-jest,
`@mcp-abap-adt/llm-agent` 29 (`CircuitBreaker`, `CircuitBreakerEmbedder`,
`VectorRag`, `InMemoryRag`, `FallbackRag`), `@mcp-abap-adt/llm-agent-rag` 29
(`resolveEmbedder`, `prefetchEmbedderFactories`, `composeEmbedder`),
`@mcp-abap-adt/qdrant-rag` 29 (`QdrantRag`, `QdrantRagProvider`),
`@sap-cloud-sdk/connectivity` (`destinations` env variable).

**Spec:** `docs/superpowers/specs/2026-09-29-configurable-providers-design.md`,
rev. 13 (approved, `4766543c`).

- **Plan A** (this file) covers spec §3, §4.1, §4.2 (for the tools and session
  classes), §4.4, §4.5, §4.7, §5, the speed measurement, and the local
  acceptance.
- **Plan B** (next file) covers §4.3: persistent collections on Qdrant, their
  catalog, and the llm-agent `updateCollection` prerequisite.
- Until Plan B lands, `LLM_AGENT_RAG_BACKEND=qdrant` fails fast (Task 2).

## Global Constraints

- **No component reads these variables.** Only `srv/agent-config.ts` parses
  env; everything else receives instances.
- **No timeouts** anywhere in new code: no `timeoutMs`, no `AbortSignal.timeout`,
  no deadline on the startup wait.
- **Default unchanged.** With none of the new variables set, the hub builds the
  same store classes and embedder class as today. A unit test enforces this
  (Task 6).
- **Fail fast on shape, explicit error on outage.** Configuration mistakes
  throw at startup. A Qdrant or embedder failure on the `qdrant` backend
  returns a `RagError`; there is no silent keyword fallback.
- **No concrete names.** No real systems, subaccounts, customers or people in
  code, tests, docs or commit messages. Use `SAP_DEV`, `DEVELOPER`, `ZDEMO_*`,
  `sap.example.com`.
- **Language and style.** All artifacts in English. Biome: single quotes, 2
  spaces, 100 columns. Conventional commits, each ending with the two
  attribution lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd`.
- **Local Qdrant** runs on host ports **6433/6434**, never 6333.
- **Branch and PR.** All tasks go on branch `feat/configurable-providers-a`, in
  the worktree `.worktrees/configurable-providers-a`, as one PR to `main`.
- **Checks per task:** `npx tsc --noEmit`, `npm run lint:check` (18
  pre-existing warnings are the baseline), and `npx jest <file>`. The full
  `npx jest` and `node tools/check-docs.js` run before the PR.

## Review Focus

1. **`LLM_AGENT_RAG_TYPE=vector` with no new variables.** It must behave as
   today: same embedder, `FallbackRag(VectorRag)` for tools and history, and the
   committed bundle loads with zero embedding calls. Tested in Task 6 and
   Task 8.
2. **An `openai`-embedder deployment after upgrade.** The committed bundle
   does not cover it, so startup must name the build step in an explicit error
   and must not silently run without tools. Tested in Task 8.
3. **An empty or malformed `destinations` variable with
   `LLM_AGENT_DESTINATION_SOURCE=env`.** Startup fails with a message naming
   the variable. Tested in Task 5.
4. **Qdrant unreachable at startup with tools on `qdrant`.** The agent starts,
   tool requests fail with an explicit error naming Qdrant, and the error is
   not swallowed into "no tools". Tested in Task 8.
5. **`dev:local` with a leftover `default-env.json`.** It warns and names the
   file before starting, because that file makes the run hybrid. Tested in
   Task 10.

---

## File structure

| File | Responsibility |
|---|---|
| `srv/agent-config.ts` (modify) | parse and validate `RagConfig` and `DestinationConfig` |
| `srv/lib/providers.ts` (create) | `buildProviders()`: embedder, `RagStoreFactory`, `DestinationSource` |
| `srv/lib/rag-store-factory.ts` (create) | per-class store construction + Qdrant REST ops (list/count/delete) |
| `srv/lib/destination-source.ts` (create) | `BtpDestinationSource`, `EnvDestinationSource` |
| `srv/lib/btp-destinations.ts` (modify) | delegate `getAvailableDestinations` to the injected source |
| `srv/lib/tool-corpus.ts` (create) | corpus hash, tool store names, bundle file name per fingerprint |
| `srv/agent-manager.ts` (modify) | `initProviders()`, drop `getOrCreateEmbedder`, load-only tool corpus |
| `srv/server.ts` (modify) | async startup step before the registry and the RAG routes |
| `tools/generate-tool-embeddings.ts` (modify) | build step: bundle or Qdrant generation + completion record |
| `tools/rag-gc.ts` (create) | operator cleanup of old tool generations |
| `tools/probe-direct-session.ts` (create) | Task 1 session-affinity probe |
| `tools/dev-local.js` (create) | `dev:local` npm script |
| `tools/tool-rag-queries.json`, `tools/measure-tool-rag.ts` (create) | speed and ranking measurement |
| `mta.yaml`, `docs/deployment/templates/*.mtaext.template` (modify) | declare the new parameters and pass them to `cloud-llm-hub-srv` |
| `.env.local.example`, `docker-compose.local.yml` (create) | local kit |
| `docs/development/LOCAL_RUN.md` (create), `README.md`, `docs/llm-agent/CONFIG_USAGE.md`, `.env.example`, `.gitignore`, `package.json` (modify) | docs and scripts |

---

### Task 1: Probe session affinity on a direct (Internet) destination

The spec's first task. It is a gate: if the chain does not stay on one session,
**stop** and report to the user. A spec change needs their approval.

**Files:**
- Create: `tools/probe-direct-session.ts`

**Interfaces:**
- Consumes: `createConnection` / `CloudSdkAbapConnection` from
  `srv/connections` (existing), and the Cloud SDK `destinations` env variable.
- Produces: nothing used by later tasks. It is a pass/fail report.

- [ ] **Step 1: Write the probe**

```ts
/**
 * Probe: does an ADT stateful chain stay on ONE session over a direct
 * (ProxyType Internet) destination read from the Cloud SDK `destinations` env?
 *
 * Usage (a SAP system reachable from this machine; an object in a package YOU
 * own — never a shared read-only package):
 *   destinations='[{"name":"SAP_DEV","url":"https://sap.example.com:44300",
 *     "proxyType":"Internet","authentication":"NoAuthentication","sapClient":"100"}]' \
 *   PROBE_DEST=SAP_DEV PROBE_USER=... PROBE_PASSWORD=... \
 *   PROBE_OBJECT_URI=/sap/bc/adt/oo/classes/zcl_demo_probe \
 *   npx tsx tools/probe-direct-session.ts
 */
import { createConnection } from '../srv/connections';
import type { CloudSdkAbapConnection } from '../srv/connections/CloudSdkAbapConnection';
import { resolveDestinationSapConfig } from '../srv/connections/destinationResolver';

async function main() {
  const dest = process.env.PROBE_DEST ?? '';
  const uri = process.env.PROBE_OBJECT_URI ?? '';
  const username = process.env.PROBE_USER ?? '';
  const password = process.env.PROBE_PASSWORD ?? '';
  if (!dest || !uri || !username || !password) {
    throw new Error('set PROBE_DEST, PROBE_OBJECT_URI, PROBE_USER, PROBE_PASSWORD');
  }
  const res = await resolveDestinationSapConfig(dest);
  // createConnection is synchronous and takes credentials inside sapConfig.
  const conn = createConnection({
    sapConfig: { ...res.sapConfig, username, password },
    destinationName: res.destinationName,
  }) as CloudSdkAbapConnection;
  conn.setSessionType('stateful');
  let handle: string | undefined;
  const statuses: Record<string, number | string> = {};
  try {
    const lock = await conn.makeAdtRequest({
      url: `${uri}?_action=LOCK&accessMode=MODIFY`,
      method: 'POST',
      headers: { Accept: 'application/vnd.sap.as+xml' },
    });
    statuses.lock = lock.status;
    handle = /<LOCK_HANDLE>([^<]+)</.exec(String(lock.data))?.[1];
    if (!handle) throw new Error(`LOCK returned no handle: HTTP ${lock.status}`);
    statuses.read = (await conn.makeAdtRequest({ url: uri, method: 'GET' })).status;
  } finally {
    // A probe on a real system must never leave a lock: unlock whenever a
    // handle was obtained, and close the session whatever happened.
    try {
      if (handle) {
        statuses.unlock = (
          await conn.makeAdtRequest({
            url: `${uri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`,
            method: 'POST',
          })
        ).status;
      }
    } catch (e) {
      statuses.unlock = `error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await conn.closeSession();
      console.log(JSON.stringify(statuses));
    }
  }
  if (statuses.unlock !== 200) throw new Error('UNLOCK failed: the chain left the session');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check the probe**

Run: `npx tsc --noEmit tools/probe-direct-session.ts --esModuleInterop --skipLibCheck --module commonjs --target es2022`
Expected: no errors. The signatures used are:
- `resolveDestinationSapConfig(name): Promise<DestinationResolution>`, which
  returns `{ destinationName, sapConfig, … }`;
- `createConnection({ sapConfig, destinationName }): AbapConnection`,
  synchronous;
- `CloudSdkAbapConnection.setSessionType`, `makeAdtRequest` and
  `closeSession`.

- [ ] **Step 3: Run it against a reachable system (the user supplies creds and the object)**

Run the usage command from the header.
Expected: `{"lock":200,"read":200,"unlock":200}` and exit code 0.
- Then confirm in SM12 (or with a second LOCK attempt) that no lock is left.
- **If it fails: stop the plan and report** the output and whether
  `SAP_SESSIONID` was issued by SAP. A spec change needs the user's approval.

- [ ] **Step 4: Commit**

```bash
git add tools/probe-direct-session.ts
git commit -m "chore(tools): probe ADT session affinity on a direct destination"
```

---

### Task 2: Configuration — `RagConfig` and `DestinationConfig`

**Files:**
- Modify: `srv/agent-config.ts` (types at 38-116, `loadAgentConfig` at 127-241)
- Test: `test/unit/rag-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EmbedderKind = 'sap-ai-core' | 'openai' | 'ollama';
  export type RagBackendKind = 'in-memory' | 'vector' | 'qdrant';
  export type RagStoreClass = 'tools' | 'session' | 'persistent';
  export interface EmbedderConfig { kind: EmbedderKind; model: string; url?: string; apiKey?: string; resourceGroup?: string }
  export interface QdrantConfig { url: string; apiKey?: string; prefix: string }
  export interface RagConfig {
    embedder: EmbedderConfig | null;               // null when every class is in-memory
    backends: Record<RagStoreClass, RagBackendKind>;
    qdrant?: QdrantConfig;                         // present when any class is qdrant
  }
  export type DestinationConfig =
    | { source: 'btp' }
    | { source: 'env'; destinations: EnvDestination[] };
  export interface EnvDestination { name: string; url: string; proxyType: string; authentication: string; sapClient?: string }
  export function parseRagConfig(env: NodeJS.ProcessEnv, llm: { provider: LlmProvider; apiKey?: string; baseUrl?: string; resourceGroup?: string }): RagConfig
  export function parseDestinationConfig(env: NodeJS.ProcessEnv): DestinationConfig
  ```
  `AgentConfig` gains `rag: RagConfig` and `destinations: DestinationConfig`.
  `agent.ragType` stays, for the derived defaults.

- [ ] **Step 1: Write the failing tests**

```ts
import { parseDestinationConfig, parseRagConfig } from '../../srv/agent-config';

const llmSap = { provider: 'sap-ai-sdk' as const, resourceGroup: 'default' };
const llmOpenai = { provider: 'openai' as const, apiKey: 'k', baseUrl: 'http://llm.example.com/v1' };

describe('parseRagConfig', () => {
  it('no variables: every class in-memory, no embedder (today)', () => {
    expect(parseRagConfig({}, llmSap)).toEqual({
      embedder: null,
      backends: { tools: 'in-memory', session: 'in-memory', persistent: 'in-memory' },
    });
  });

  it('LLM_AGENT_RAG_TYPE=vector with sap-ai-sdk: vector everywhere, AI Core embedder (today)', () => {
    expect(parseRagConfig({ LLM_AGENT_RAG_TYPE: 'vector' }, llmSap)).toEqual({
      embedder: { kind: 'sap-ai-core', model: 'text-embedding-3-small', resourceGroup: 'default' },
      backends: { tools: 'vector', session: 'vector', persistent: 'vector' },
    });
  });

  it('LLM_AGENT_RAG_TYPE=vector with openai: openai embedder at the LLM base URL (today)', () => {
    expect(parseRagConfig({ LLM_AGENT_RAG_TYPE: 'vector' }, llmOpenai).embedder).toEqual({
      kind: 'openai', model: 'text-embedding-3-small', url: 'http://llm.example.com/v1', apiKey: 'k',
    });
  });

  it('ollama embedder needs a model and defaults its URL', () => {
    const env = { LLM_AGENT_TOOLS_RAG_BACKEND: 'vector', LLM_AGENT_EMBEDDER: 'ollama', LLM_AGENT_EMBEDDING_MODEL: 'bge-m3' };
    expect(parseRagConfig(env, llmOpenai).embedder).toEqual({ kind: 'ollama', model: 'bge-m3', url: 'http://localhost:11434' });
    expect(() => parseRagConfig({ ...env, LLM_AGENT_EMBEDDING_MODEL: '' }, llmOpenai)).toThrow(/LLM_AGENT_EMBEDDING_MODEL/);
  });

  it('tools on qdrant needs a URL; prefix defaults', () => {
    const env = { LLM_AGENT_TOOLS_RAG_BACKEND: 'qdrant', LLM_AGENT_EMBEDDER: 'ollama', LLM_AGENT_EMBEDDING_MODEL: 'bge-m3' };
    expect(() => parseRagConfig(env, llmOpenai)).toThrow(/LLM_AGENT_QDRANT_URL/);
    expect(parseRagConfig({ ...env, LLM_AGENT_QDRANT_URL: 'http://localhost:6433' }, llmOpenai).qdrant)
      .toEqual({ url: 'http://localhost:6433', prefix: 'cloud-llm-hub' });
  });

  it.each([
    [{ LLM_AGENT_TOOLS_RAG_BACKEND: 'hana' }, /LLM_AGENT_TOOLS_RAG_BACKEND/],
    [{ LLM_AGENT_EMBEDDER: 'foo', LLM_AGENT_RAG_TYPE: 'vector' }, /LLM_AGENT_EMBEDDER/],
    [{ LLM_AGENT_EMBEDDER: 'ollama' }, /every RAG class is in-memory/],
    [{ LLM_AGENT_RAG_TYPE: 'in-memory', LLM_AGENT_TOOLS_RAG_BACKEND: 'vector' }, /contradict/],
    [{ LLM_AGENT_SESSION_RAG_BACKEND: 'qdrant', LLM_AGENT_QDRANT_URL: 'http://q' }, /not yet supported/],
    [{ LLM_AGENT_RAG_BACKEND: 'qdrant', LLM_AGENT_QDRANT_URL: 'http://q' }, /Plan B|not yet supported/],
  ])('rejects %j', (env, msg) => {
    expect(() => parseRagConfig(env, llmSap)).toThrow(msg);
  });
});

describe('parseDestinationConfig', () => {
  it('defaults to btp', () => {
    expect(parseDestinationConfig({})).toEqual({ source: 'btp' });
  });
  it('env: reads the Cloud SDK destinations variable (name or Name)', () => {
    const destinations = JSON.stringify([
      { name: 'SAP_DEV', url: 'https://sap.example.com:44300', proxyType: 'Internet', authentication: 'NoAuthentication', sapClient: '100' },
      { Name: 'SAP_QAS', URL: 'https://qas.example.com', ProxyType: 'Internet', Authentication: 'NoAuthentication' },
    ]);
    expect(parseDestinationConfig({ LLM_AGENT_DESTINATION_SOURCE: 'env', destinations })).toEqual({
      source: 'env',
      destinations: [
        { name: 'SAP_DEV', url: 'https://sap.example.com:44300', proxyType: 'Internet', authentication: 'NoAuthentication', sapClient: '100' },
        { name: 'SAP_QAS', url: 'https://qas.example.com', proxyType: 'Internet', authentication: 'NoAuthentication' },
      ],
    });
  });
  it.each([
    [{ LLM_AGENT_DESTINATION_SOURCE: 'env' }, /destinations/],
    [{ LLM_AGENT_DESTINATION_SOURCE: 'env', destinations: '{' }, /destinations/],
    [{ LLM_AGENT_DESTINATION_SOURCE: 'env', destinations: '[]' }, /at least one/],
    [{ LLM_AGENT_DESTINATION_SOURCE: 'env', destinations: '[{"url":"x"}]' }, /name/],
    [{ LLM_AGENT_DESTINATION_SOURCE: 'ldap' }, /LLM_AGENT_DESTINATION_SOURCE/],
  ])('rejects %j', (env, msg) => {
    expect(() => parseDestinationConfig(env)).toThrow(msg);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx jest test/unit/rag-config.test.ts`
Expected: FAIL — `parseRagConfig is not a function`.

- [ ] **Step 3: Implement in `srv/agent-config.ts`**

Add below the existing types:

```ts
export type EmbedderKind = 'sap-ai-core' | 'openai' | 'ollama';
export type RagBackendKind = 'in-memory' | 'vector' | 'qdrant';
export type RagStoreClass = 'tools' | 'session' | 'persistent';
export interface EmbedderConfig {
  kind: EmbedderKind;
  model: string;
  url?: string;
  apiKey?: string;
  resourceGroup?: string;
}
export interface QdrantConfig { url: string; apiKey?: string; prefix: string }
export interface RagConfig {
  embedder: EmbedderConfig | null;
  backends: Record<RagStoreClass, RagBackendKind>;
  qdrant?: QdrantConfig;
}
export interface EnvDestination {
  name: string;
  url: string;
  proxyType: string;
  authentication: string;
  sapClient?: string;
}
export type DestinationConfig =
  | { source: 'btp' }
  | { source: 'env'; destinations: EnvDestination[] };

const BACKENDS: readonly RagBackendKind[] = ['in-memory', 'vector', 'qdrant'];
const EMBEDDERS: readonly EmbedderKind[] = ['sap-ai-core', 'openai', 'ollama'];
const CLASS_VARS: Record<RagStoreClass, string> = {
  tools: 'LLM_AGENT_TOOLS_RAG_BACKEND',
  session: 'LLM_AGENT_SESSION_RAG_BACKEND',
  persistent: 'LLM_AGENT_RAG_BACKEND',
};
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

function set(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

export function parseRagConfig(
  env: NodeJS.ProcessEnv,
  llm: { provider: LlmProvider; apiKey?: string; baseUrl?: string; resourceGroup?: string },
): RagConfig {
  const ragType = set(env, 'LLM_AGENT_RAG_TYPE');
  const legacy: RagBackendKind = !ragType || ragType === 'in-memory' ? 'in-memory' : 'vector';
  const backends = {} as Record<RagStoreClass, RagBackendKind>;
  for (const cls of Object.keys(CLASS_VARS) as RagStoreClass[]) {
    const name = CLASS_VARS[cls];
    const raw = set(env, name);
    if (raw !== undefined && !BACKENDS.includes(raw as RagBackendKind)) {
      throw new Error(`Invalid ${name}: expected one of ${BACKENDS.join(', ')}, got ${JSON.stringify(raw)}`);
    }
    if (raw !== undefined && ragType === 'in-memory' && raw !== 'in-memory') {
      throw new Error(`LLM_AGENT_RAG_TYPE=in-memory and ${name}=${raw} contradict each other`);
    }
    backends[cls] = (raw as RagBackendKind | undefined) ?? legacy;
  }
  if (backends.session === 'qdrant') {
    throw new Error('LLM_AGENT_SESSION_RAG_BACKEND=qdrant is not yet supported (spec phase 2)');
  }
  if (backends.persistent === 'qdrant') {
    throw new Error('LLM_AGENT_RAG_BACKEND=qdrant is not yet supported: it arrives with Plan B (persistent collections)');
  }

  const needsEmbedder = Object.values(backends).some((b) => b !== 'in-memory');
  const kindRaw = set(env, 'LLM_AGENT_EMBEDDER');
  if (!needsEmbedder) {
    if (kindRaw !== undefined) {
      throw new Error('LLM_AGENT_EMBEDDER is set, but every RAG class is in-memory, so nothing would use it');
    }
    return { embedder: null, backends };
  }
  if (kindRaw !== undefined && !EMBEDDERS.includes(kindRaw as EmbedderKind)) {
    throw new Error(`Invalid LLM_AGENT_EMBEDDER: expected one of ${EMBEDDERS.join(', ')}, got ${JSON.stringify(kindRaw)}`);
  }
  const kind = (kindRaw as EmbedderKind | undefined) ?? (llm.provider === 'sap-ai-sdk' ? 'sap-ai-core' : 'openai');
  const model = set(env, 'LLM_AGENT_EMBEDDING_MODEL');
  let embedder: EmbedderConfig;
  if (kind === 'sap-ai-core') {
    embedder = { kind, model: model ?? DEFAULT_EMBEDDING_MODEL, resourceGroup: llm.resourceGroup };
  } else if (kind === 'openai') {
    embedder = {
      kind,
      model: model ?? DEFAULT_EMBEDDING_MODEL,
      url: set(env, 'LLM_AGENT_EMBEDDER_URL') ?? llm.baseUrl,
      apiKey: set(env, 'LLM_AGENT_EMBEDDER_API_KEY') ?? llm.apiKey,
    };
  } else {
    if (!model) throw new Error('LLM_AGENT_EMBEDDER=ollama needs LLM_AGENT_EMBEDDING_MODEL (no default model)');
    embedder = { kind, model, url: set(env, 'LLM_AGENT_EMBEDDER_URL') ?? 'http://localhost:11434' };
  }
  // Drop undefined keys so configs compare structurally.
  for (const k of Object.keys(embedder) as (keyof EmbedderConfig)[]) {
    if (embedder[k] === undefined) delete embedder[k];
  }

  const rag: RagConfig = { embedder, backends };
  if (Object.values(backends).includes('qdrant')) {
    const url = set(env, 'LLM_AGENT_QDRANT_URL');
    if (!url) throw new Error('A RAG class uses qdrant, but LLM_AGENT_QDRANT_URL is not set');
    const apiKey = set(env, 'LLM_AGENT_QDRANT_API_KEY');
    rag.qdrant = { url, prefix: set(env, 'LLM_AGENT_QDRANT_PREFIX') ?? 'cloud-llm-hub', ...(apiKey ? { apiKey } : {}) };
  }
  return rag;
}

function pick(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

export function parseDestinationConfig(env: NodeJS.ProcessEnv): DestinationConfig {
  const source = set(env, 'LLM_AGENT_DESTINATION_SOURCE') ?? 'btp';
  if (source === 'btp') return { source };
  if (source !== 'env') {
    throw new Error(`Invalid LLM_AGENT_DESTINATION_SOURCE: expected btp or env, got ${JSON.stringify(source)}`);
  }
  const raw = set(env, 'destinations');
  if (!raw) throw new Error('LLM_AGENT_DESTINATION_SOURCE=env needs the Cloud SDK `destinations` variable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`The \`destinations\` variable is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('The `destinations` variable must be a JSON array with at least one destination');
  }
  const destinations = parsed.map((d, i): EnvDestination => {
    const o = (d ?? {}) as Record<string, unknown>;
    const name = pick(o, 'name', 'Name');
    const url = pick(o, 'url', 'URL');
    if (!name || !url) throw new Error(`destinations[${i}] needs a name and a url`);
    const sapClient = pick(o, 'sapClient', 'sap-client');
    return {
      name,
      url,
      proxyType: pick(o, 'proxyType', 'ProxyType') ?? 'Internet',
      authentication: pick(o, 'authentication', 'Authentication') ?? 'NoAuthentication',
      ...(sapClient ? { sapClient } : {}),
    };
  });
  return { source: 'env', destinations };
}
```

In `AgentConfig` add `rag: RagConfig;` and `destinations: DestinationConfig;`. In
`loadAgentConfig()`, after `baseUrl` (line 163), compute:

```ts
  const rag = parseRagConfig(process.env, {
    provider,
    apiKey: apiKey || undefined,
    baseUrl: baseUrl || undefined,
    resourceGroup,
  });
  const destinations = parseDestinationConfig(process.env);
```

Add `rag, destinations` to the returned object. Extend the "Agent configuration
loaded" log with `ragBackends: rag.backends`, `embedder: rag.embedder?.kind`,
`destinationSource: destinations.source`, and never the API keys.

- [ ] **Step 4: Run the tests**

Run: `npx jest test/unit/rag-config.test.ts test/unit/throttle-choice.test.ts`
Expected: PASS.
- Fix literal `AgentConfig` objects in other tests only if `tsc` reports them,
  by adding
  `rag: { embedder: null, backends: { tools: 'in-memory', session: 'in-memory', persistent: 'in-memory' } }, destinations: { source: 'btp' }`.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit && npm run lint:check
git add srv/agent-config.ts test/unit/rag-config.test.ts test/unit
git commit -m "feat(config): embedder, per-class RAG backend and destination source"
```

---

### Task 3: Embedder from configuration, with its fingerprint

**Files:**
- Create: `srv/lib/providers.ts` (the embedder part only in this task)
- Modify: `srv/agent-manager.ts:1430-1467` (`EmbedderFingerprint`, `runtimeEmbedderFingerprint`)
- Test: `test/unit/providers-embedder.test.ts`

**Interfaces:**
- Consumes: `EmbedderConfig` (Task 2).
- Produces:
  ```ts
  export interface Embedding { embedder: CircuitBreakerEmbedder; breaker: CircuitBreaker; fingerprint: EmbedderFingerprint }
  export async function prefetchEmbedder(cfg: EmbedderConfig | null): Promise<void>
  export function buildEmbedding(cfg: EmbedderConfig | null): Embedding | null
  export function embedderFingerprint(cfg: EmbedderConfig): EmbedderFingerprint
  ```
  `EmbedderFingerprint` moves to `srv/lib/tool-corpus.ts` in Task 7; until then
  it is exported from `providers.ts`, with the same shape as today:
  `{provider; embeddingModel; baseURL?; resourceGroup?}`.

- [ ] **Step 1: Write the failing tests**

```ts
import { CircuitBreakerEmbedder } from '@mcp-abap-adt/llm-agent';
import { buildEmbedding, embedderFingerprint, prefetchEmbedder } from '../../srv/lib/providers';

describe('embedder from configuration', () => {
  it('null config → no embedding', () => {
    expect(buildEmbedding(null)).toBeNull();
  });

  it('AI Core fingerprint keeps the committed bundle header shape', () => {
    expect(embedderFingerprint({ kind: 'sap-ai-core', model: 'text-embedding-3-small', resourceGroup: 'default' }))
      .toEqual({ provider: 'sap-ai-sdk', embeddingModel: 'text-embedding-3-small', resourceGroup: 'default' });
  });

  it('openai and ollama fingerprints carry their URL', () => {
    expect(embedderFingerprint({ kind: 'openai', model: 'm', url: 'http://e.example.com/v1', apiKey: 'k' }))
      .toEqual({ provider: 'openai', embeddingModel: 'm', baseURL: 'http://e.example.com/v1' });
    expect(embedderFingerprint({ kind: 'ollama', model: 'bge-m3', url: 'http://localhost:11434' }))
      .toEqual({ provider: 'ollama', embeddingModel: 'bge-m3', baseURL: 'http://localhost:11434' });
  });

  it.each([
    [{ kind: 'ollama' as const, model: 'bge-m3', url: 'http://localhost:11434' }],
    [{ kind: 'openai' as const, model: 'm', url: 'http://e.example.com/v1', apiKey: 'k' }],
    [{ kind: 'sap-ai-core' as const, model: 'text-embedding-3-small', resourceGroup: 'default' }],
  ])('builds a breaker-wrapped embedder for %j', async (cfg) => {
    await prefetchEmbedder(cfg);
    const e = buildEmbedding(cfg);
    expect(e?.embedder).toBeInstanceOf(CircuitBreakerEmbedder);
    expect(e?.fingerprint).toEqual(embedderFingerprint(cfg));
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx jest test/unit/providers-embedder.test.ts`
Expected: FAIL — cannot find module `../../srv/lib/providers`.

- [ ] **Step 3: Implement `srv/lib/providers.ts` (embedder part)**

```ts
/**
 * The one place that turns configuration into instances (spec §4.1).
 * Components receive what is built here; none of them read configuration.
 */
import { CircuitBreaker, CircuitBreakerEmbedder } from '@mcp-abap-adt/llm-agent';
import { composeEmbedder, prefetchEmbedderFactories, resolveEmbedder } from '@mcp-abap-adt/llm-agent-rag';
import type { EmbedderConfig } from '../agent-config';
import { apiKeyCredential } from './llm-factory';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder';

export interface EmbedderFingerprint {
  provider: string;
  embeddingModel: string;
  baseURL?: string;
  resourceGroup?: string;
}

export interface Embedding {
  embedder: CircuitBreakerEmbedder;
  breaker: CircuitBreaker;
  fingerprint: EmbedderFingerprint;
}

/** `sap-ai-sdk` for AI Core keeps the committed bundle's header valid. */
export function embedderFingerprint(cfg: EmbedderConfig): EmbedderFingerprint {
  if (cfg.kind === 'sap-ai-core') {
    return { provider: 'sap-ai-sdk', embeddingModel: cfg.model, resourceGroup: cfg.resourceGroup || 'default' };
  }
  return { provider: cfg.kind, embeddingModel: cfg.model, ...(cfg.url ? { baseURL: cfg.url } : {}) };
}

/** `resolveEmbedder` requires its peers loaded first; awaited once at startup. */
export async function prefetchEmbedder(cfg: EmbedderConfig | null): Promise<void> {
  if (cfg && cfg.kind !== 'sap-ai-core') await prefetchEmbedderFactories([cfg.kind]);
}

export function buildEmbedding(cfg: EmbedderConfig | null): Embedding | null {
  if (!cfg) return null;
  const raw =
    cfg.kind === 'sap-ai-core'
      ? composeEmbedder(new SapAiCoreEmbedder({ model: cfg.model, resourceGroup: cfg.resourceGroup }))
      : cfg.kind === 'openai'
        ? resolveEmbedder({ provider: 'openai', model: cfg.model, credential: apiKeyCredential(cfg.apiKey ?? ''), ...(cfg.url ? { url: cfg.url } : {}) })
        : resolveEmbedder({ provider: 'ollama', model: cfg.model, ...(cfg.url ? { url: cfg.url } : {}) });
  // Same breaker settings as today's getOrCreateEmbedder.
  const breaker = new CircuitBreaker({ failureThreshold: 30, recoveryWindowMs: 60_000 });
  return { embedder: new CircuitBreakerEmbedder(raw, breaker), breaker, fingerprint: embedderFingerprint(cfg) };
}
```

In `srv/agent-manager.ts`:
- replace the local `EmbedderFingerprint` type with
  `import type { EmbedderFingerprint } from './lib/providers'` and re-export it
  (`export type { EmbedderFingerprint }`), because `bundle-load.test.ts`
  imports it from agent-manager;
- make `runtimeEmbedderFingerprint(config = getAgentConfig())` return
  `config.rag.embedder ? embedderFingerprint(config.rag.embedder) : embedderFingerprint({ kind: 'sap-ai-core', model: 'text-embedding-3-small', resourceGroup: config.llm.resourceGroup })`.

- [ ] **Step 4: Run the tests**

Run: `npx jest test/unit/providers-embedder.test.ts test/unit/bundle-load.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit && npm run lint:check
git add srv/lib/providers.ts srv/agent-manager.ts test/unit/providers-embedder.test.ts
git commit -m "feat(providers): embedder from configuration, ollama included"
```

---

### Task 4: `RagStoreFactory` — per-class stores, synchronous, with Qdrant REST ops

**Files:**
- Create: `srv/lib/rag-store-factory.ts`
- Test: `test/unit/rag-store-factory.test.ts`

**Interfaces:**
- Consumes: `RagConfig` (Task 2), `Embedding` (Task 3).
- Produces:
  ```ts
  export interface VectorStoreOptions { queryPreprocessors?: IQueryPreprocessor[]; documentEnrichers?: IDocumentEnricher[] }
  export interface RagStoreFactory {
    backendOf(cls: RagStoreClass): RagBackendKind;
    create(cls: RagStoreClass, name: string, opts?: VectorStoreOptions): IRag;
    listStores(cls: RagStoreClass, prefix: string): Promise<Result<string[], RagError>>;
    countPoints(cls: RagStoreClass, name: string): Promise<Result<number, RagError>>;
    deleteStore(cls: RagStoreClass, name: string): Promise<Result<void, RagError>>;
    qdrantCollection(name: string): string;        // `<prefix>-<name>`
  }
  export function createRagStoreFactory(rag: RagConfig, embedding: Embedding | null): RagStoreFactory
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { FallbackRag, InMemoryRag } from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from '@mcp-abap-adt/qdrant-rag';
import type { RagConfig } from '../../srv/agent-config';
import { buildEmbedding, prefetchEmbedder } from '../../srv/lib/providers';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';

const inMem: RagConfig = { embedder: null, backends: { tools: 'in-memory', session: 'in-memory', persistent: 'in-memory' } };
const emb = { kind: 'ollama' as const, model: 'bge-m3', url: 'http://localhost:11434' };
const q: RagConfig = {
  embedder: emb,
  backends: { tools: 'qdrant', session: 'vector', persistent: 'vector' },
  qdrant: { url: 'http://localhost:6433', prefix: 'hub-test' },
};

describe('RagStoreFactory', () => {
  beforeAll(() => prefetchEmbedder(emb));
  afterEach(() => jest.restoreAllMocks());

  it('in-memory builds InMemoryRag', () => {
    expect(createRagStoreFactory(inMem, null).create('tools', 'x')).toBeInstanceOf(InMemoryRag);
  });

  it('vector builds FallbackRag, qdrant builds a bare QdrantRag (no keyword fallback)', () => {
    const f = createRagStoreFactory(q, buildEmbedding(emb));
    expect(f.create('session', 'history')).toBeInstanceOf(FallbackRag);
    const t = f.create('tools', 'tools-reader-a-b');
    expect(t).toBeInstanceOf(QdrantRag);
    expect(t).not.toBeInstanceOf(FallbackRag);
    expect(f.qdrantCollection('tools-reader-a-b')).toBe('hub-test-tools-reader-a-b');
  });

  it('listStores / countPoints / deleteStore talk to Qdrant REST and map errors to RagError', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { collections: [{ name: 'hub-test-tools-reader-1' }, { name: 'other' }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { count: 42 } })))
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const f = createRagStoreFactory(q, buildEmbedding(emb));
    expect(await f.listStores('tools', 'tools-reader-')).toEqual({ ok: true, value: ['tools-reader-1'] });
    expect(await f.countPoints('tools', 'tools-reader-1')).toEqual({ ok: true, value: 42 });
    expect((await f.deleteStore('tools', 'tools-reader-1')).ok).toBe(true);
    const bad = await f.listStores('tools', 'x');
    expect(bad.ok).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:6433/collections/hub-test-tools-reader-1/points/count');
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx jest test/unit/rag-store-factory.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `srv/lib/rag-store-factory.ts`**

```ts
import {
  FallbackRag, type IDocumentEnricher, InMemoryRag, type IQueryPreprocessor, type IRag,
  NoopDocumentEnricher, RagError, type Result, VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from '@mcp-abap-adt/qdrant-rag';
import type { RagBackendKind, RagConfig, RagStoreClass } from '../agent-config';
import { apiKeyCredential } from './llm-factory';
import type { Embedding } from './providers';

export interface VectorStoreOptions {
  queryPreprocessors?: IQueryPreprocessor[];
  documentEnrichers?: IDocumentEnricher[];
}

export interface RagStoreFactory {
  backendOf(cls: RagStoreClass): RagBackendKind;
  create(cls: RagStoreClass, name: string, opts?: VectorStoreOptions): IRag;
  listStores(cls: RagStoreClass, prefix: string): Promise<Result<string[], RagError>>;
  countPoints(cls: RagStoreClass, name: string): Promise<Result<number, RagError>>;
  deleteStore(cls: RagStoreClass, name: string): Promise<Result<void, RagError>>;
  qdrantCollection(name: string): string;
}

const err = (msg: string, code: string): { ok: false; error: RagError } => ({ ok: false, error: new RagError(msg, code) });

export function createRagStoreFactory(rag: RagConfig, embedding: Embedding | null): RagStoreFactory {
  const qdrant = rag.qdrant;
  const qName = (name: string) => `${qdrant?.prefix ?? 'cloud-llm-hub'}-${name}`;
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(qdrant?.apiKey ? { 'api-key': qdrant.apiKey } : {}),
  });
  const needQdrant = (cls: RagStoreClass) => {
    if (rag.backends[cls] !== 'qdrant' || !qdrant) throw new Error(`RAG class ${cls} is not on qdrant`);
    return qdrant;
  };

  return {
    backendOf: (cls) => rag.backends[cls],
    qdrantCollection: qName,
    create(cls, name, opts) {
      const backend = rag.backends[cls];
      if (backend === 'in-memory' || !embedding) return new InMemoryRag();
      if (backend === 'vector') {
        return new FallbackRag(
          new VectorRag(embedding.embedder, {
            vectorWeight: 0.7,
            keywordWeight: 0.3,
            queryPreprocessors: opts?.queryPreprocessors,
            documentEnrichers: opts?.documentEnrichers ?? [new NoopDocumentEnricher()],
          }),
          new InMemoryRag(),
          embedding.breaker,
        );
      }
      const q = needQdrant(cls);
      return new QdrantRag({
        url: q.url,
        collectionName: qName(name),
        embedder: embedding.embedder,
        ...(q.apiKey ? { credential: apiKeyCredential(q.apiKey) } : {}),
      });
    },
    async listStores(cls, prefix) {
      const q = needQdrant(cls);
      const res = await fetch(`${q.url}/collections`, { headers: headers() });
      if (!res.ok) return err(`Qdrant list collections: HTTP ${res.status} ${await res.text()}`, 'RAG_LIST_ERROR');
      const body = (await res.json()) as { result: { collections: { name: string }[] } };
      const full = qName(prefix);
      const own = `${q.prefix}-`;
      return {
        ok: true,
        value: body.result.collections.map((c) => c.name).filter((n) => n.startsWith(full)).map((n) => n.slice(own.length)),
      };
    },
    async countPoints(cls, name) {
      const q = needQdrant(cls);
      const res = await fetch(`${q.url}/collections/${qName(name)}/points/count`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ exact: true }),
      });
      if (!res.ok) return err(`Qdrant count ${qName(name)}: HTTP ${res.status} ${await res.text()}`, 'RAG_COUNT_ERROR');
      return { ok: true, value: ((await res.json()) as { result: { count: number } }).result.count };
    },
    async deleteStore(cls, name) {
      const q = needQdrant(cls);
      const res = await fetch(`${q.url}/collections/${qName(name)}`, { method: 'DELETE', headers: headers() });
      if (!res.ok) return err(`Qdrant delete ${qName(name)}: HTTP ${res.status} ${await res.text()}`, 'RAG_DELETE_ERROR');
      return { ok: true, value: undefined };
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest test/unit/rag-store-factory.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit && npm run lint:check
git add srv/lib/rag-store-factory.ts test/unit/rag-store-factory.test.ts
git commit -m "feat(providers): per-class RAG store factory with a Qdrant backend"
```

---

### Task 5: `DestinationSource` — BTP or environment

**Files:**
- Create: `srv/lib/destination-source.ts`
- Modify: `srv/lib/btp-destinations.ts:125-161`
- Test: `test/unit/destination-source.test.ts`

**Interfaces:**
- Consumes: `DestinationConfig`, `EnvDestination` (Task 2), `SapDestination`
  (btp-destinations).
- Produces:
  ```ts
  export interface DestinationSource { list(): Promise<SapDestination[]>; clearCache(): void }
  export class EnvDestinationSource implements DestinationSource { constructor(destinations: EnvDestination[]) }
  export function createDestinationSource(cfg: DestinationConfig): DestinationSource
  // btp-destinations.ts:
  export function setDestinationSource(source: DestinationSource): void
  export function btpDestinationSource(): DestinationSource   // today's fetch + cache + fallback
  ```
  `getAvailableDestinations()` and `clearDestinationsCache()` keep their
  signatures and delegate to the injected source, so the five call sites
  (agent-manager 935/1667/1763, mcp-proxy 229/337, agent-mcp 480) stay
  unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
jest.mock('@sap/cds', () => ({ __esModule: true, default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }), { virtual: true });
import { clearDestinationsCache, getAvailableDestinations, setDestinationSource } from '../../srv/lib/btp-destinations';
import { createDestinationSource, EnvDestinationSource } from '../../srv/lib/destination-source';

describe('DestinationSource', () => {
  it('env source lists the configured destinations as SapDestination', async () => {
    const src = new EnvDestinationSource([
      { name: 'SAP_DEV', url: 'https://sap.example.com:44300', proxyType: 'Internet', authentication: 'NoAuthentication', sapClient: '100' },
    ]);
    expect(await src.list()).toEqual([
      { name: 'SAP_DEV', url: 'https://sap.example.com:44300', proxyType: 'Internet', authentication: 'NoAuthentication' },
    ]);
  });

  it('getAvailableDestinations delegates to the injected source', async () => {
    setDestinationSource(createDestinationSource({ source: 'env', destinations: [
      { name: 'SAP_QAS', url: 'https://qas.example.com', proxyType: 'Internet', authentication: 'NoAuthentication' },
    ] }));
    expect((await getAvailableDestinations()).map((d) => d.name)).toEqual(['SAP_QAS']);
    clearDestinationsCache();
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx jest test/unit/destination-source.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

`srv/lib/destination-source.ts`:

```ts
import type { DestinationConfig, EnvDestination } from '../agent-config';
import { btpDestinationSource, type SapDestination } from './btp-destinations';

export interface DestinationSource {
  list(): Promise<SapDestination[]>;
  clearCache(): void;
}

/**
 * Destinations from the Cloud SDK's own `destinations` variable. The SDK's
 * getDestination / executeHttpRequest read the same variable, so connections
 * need no change; SAP credentials still come per request from headers.
 */
export class EnvDestinationSource implements DestinationSource {
  constructor(private readonly destinations: EnvDestination[]) {}
  async list(): Promise<SapDestination[]> {
    return this.destinations.map(({ name, url, proxyType, authentication }) => ({ name, url, proxyType, authentication }));
  }
  clearCache(): void {}
}

export function createDestinationSource(cfg: DestinationConfig): DestinationSource {
  return cfg.source === 'env' ? new EnvDestinationSource(cfg.destinations) : btpDestinationSource();
}
```

In `srv/lib/btp-destinations.ts`:
- rename today's `getAvailableDestinations` body (135-160) to a private
  `listFromBtp()`;
- rename `clearDestinationsCache` (125) to `clearBtpCache()`;
- then add:

```ts
import type { DestinationSource } from './destination-source';

export function btpDestinationSource(): DestinationSource {
  return { list: listFromBtp, clearCache: clearBtpCache };
}

let source: DestinationSource | null = null;

/** Called once by the builder (providers). Until then, BTP as today. */
export function setDestinationSource(s: DestinationSource): void {
  source = s;
}

export async function getAvailableDestinations(): Promise<SapDestination[]> {
  return (source ?? btpDestinationSource()).list();
}

export function clearDestinationsCache(): void {
  (source ?? btpDestinationSource()).clearCache();
}
```

The import is type-only, so there is no runtime import cycle.

- [ ] **Step 4: Run the tests**

Run: `npx jest test/unit/destination-source.test.ts test/unit/destination-closed.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit && npm run lint:check
git add srv/lib/destination-source.ts srv/lib/btp-destinations.ts test/unit/destination-source.test.ts
git commit -m "feat(destinations): destinations from BTP or from the environment"
```

---

### Task 6: Async startup and `initProviders()` — no component decides by itself

**Files:**
- Modify: `srv/lib/providers.ts` (add `Providers`, `buildProviders`)
- Modify: `srv/agent-manager.ts`:
  - 973-1036: remove `getOrCreateEmbedder`, `sharedEmbedder`, `sharedEmbedderBreaker`;
  - 983-992: `getCollectionRegistry`;
  - 1039-1083: `createToolsRagStore`;
  - 1095-1113: `getSharedHistoryRag`;
  - 2407, 2629: `withEmbedder`.
- Modify: `srv/server.ts:250-260, 517, 626-661`
- Test: `test/unit/providers-wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces:
  ```ts
  // providers.ts
  export interface Providers { embedding: Embedding | null; stores: RagStoreFactory; destinations: DestinationSource }
  export async function startProviders(cfg: AgentConfig): Promise<Providers>   // prefetch + build + setDestinationSource
  // agent-manager.ts
  export function initProviders(p: Providers): void
  export function getProviders(): Providers        // throws "providers not initialized" before initProviders
  ```

- [ ] **Step 1: Write the failing test (the default configuration builds today's objects)**

```ts
jest.mock('@sap/cds', () => ({ __esModule: true, default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }), { virtual: true });
import { CircuitBreakerEmbedder, FallbackRag, InMemoryRag, VectorRag } from '@mcp-abap-adt/llm-agent';
import { clearAgentConfig, loadAgentConfig } from '../../srv/agent-config';
import { startProviders } from '../../srv/lib/providers';

describe('default configuration builds today objects', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; clearAgentConfig(); });

  it('no RAG variables: in-memory everywhere, no embedder', async () => {
    delete process.env.LLM_AGENT_RAG_TYPE;
    const p = await startProviders(loadAgentConfig());
    expect(p.embedding).toBeNull();
    expect(p.stores.create('tools', 'reader')).toBeInstanceOf(InMemoryRag);
    expect(p.stores.create('session', 'history')).toBeInstanceOf(InMemoryRag);
  });

  it('LLM_AGENT_RAG_TYPE=vector, sap-ai-sdk: FallbackRag(VectorRag) and a breaker-wrapped AI Core embedder', async () => {
    process.env.LLM_AGENT_RAG_TYPE = 'vector';
    delete process.env.LLM_AGENT_PROVIDER;
    const p = await startProviders(loadAgentConfig());
    expect(p.embedding?.embedder).toBeInstanceOf(CircuitBreakerEmbedder);
    const tools = p.stores.create('tools', 'reader');
    expect(tools).toBeInstanceOf(FallbackRag);
    expect((tools as unknown as { primary: unknown }).primary).toBeInstanceOf(VectorRag);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx jest test/unit/providers-wiring.test.ts`
Expected: FAIL — `startProviders is not a function`.

- [ ] **Step 3: Implement `startProviders` in `srv/lib/providers.ts`**

```ts
import type { AgentConfig } from '../agent-config';
import { setDestinationSource } from './btp-destinations';
import { createDestinationSource, type DestinationSource } from './destination-source';
import { createRagStoreFactory, type RagStoreFactory } from './rag-store-factory';

export interface Providers {
  embedding: Embedding | null;
  stores: RagStoreFactory;
  destinations: DestinationSource;
}

/** The startup step (spec §4.1): short, awaited, before the registry and routes. */
export async function startProviders(cfg: AgentConfig): Promise<Providers> {
  await prefetchEmbedder(cfg.rag.embedder);
  const embedding = buildEmbedding(cfg.rag.embedder);
  const destinations = createDestinationSource(cfg.destinations);
  setDestinationSource(destinations);
  return { embedding, stores: createRagStoreFactory(cfg.rag, embedding), destinations };
}
```

- [ ] **Step 4: Rewire `srv/agent-manager.ts`**

1. Delete `sharedEmbedderBreaker`, `sharedEmbedder` (973-974) and
   `getOrCreateEmbedder` (995-1036).
2. Add near the other module state:

```ts
let providers: Providers | null = null;

/** Called once by server startup; components get instances, not config. */
export function initProviders(p: Providers): void {
  providers = p;
}

export function getProviders(): Providers {
  if (!providers) throw new Error('providers not initialized: startProviders() must run before use');
  return providers;
}
```

3. `getCollectionRegistry()` (983-992): use
   `const e = getProviders().embedding;` and pass
   `{ embedder: e?.embedder ?? null, breaker: e?.breaker ?? null }`. The
   persistent backend stays the registry default (`vector` or `in-memory`)
   until Plan B.
4. `createToolsRagStore()` (1039-1083):
   - if `getProviders().stores.backendOf('tools') === 'in-memory'`, return
     `new ExpositionFilteringRag(new InMemoryRag(), new InMemoryRag())` as
     today;
   - otherwise keep building `helperLlm` exactly as today, and replace
     `makeBackend` with
     `() => getProviders().stores.create('tools', 'unused', { queryPreprocessors: [new TranslatePreprocessor(helperLlm)] })`.
     `create` ignores the name for `vector`; `qdrant` tool stores are opened
     by Task 8.
5. `getSharedHistoryRag()` (1095-1113): if
   `getProviders().stores.backendOf('session') === 'in-memory'`, return
   `undefined` (today's behaviour without an embedder). Otherwise
   `new SessionHistoryRag(getProviders().stores.create('session', 'history'), currentTurnOwner)`.
6. Lines 2407 and 2629: replace `if (sharedEmbedder)` with
   `const e = getProviders().embedding; if (e) builder.withEmbedder(e.embedder);`.
7. In `ensureSharedToolsVectorized` (1562), replace
   `getOrCreateEmbedder(config.llm.resourceGroup)` with
   `getProviders().embedding`. Task 8 rewrites the rest of that function.

- [ ] **Step 5: Move the registry and routes behind the async startup in `srv/server.ts`**

`cds.on('bootstrap')` stays synchronous. It keeps `gatekeeperConfig()` and
`ensureAiCoreCredentials()`, and additionally calls `getAgentConfig()`, so a
configuration mistake still stops the server before it listens. Replace lines
515-518 with a router whose routes are registered after the providers are
ready:

```ts
  // RAG collection management routes (/v1/rag/*). Registered once the async
  // provider startup has finished (spec §4.1); until then the router is empty
  // and those paths answer 503.
  const ragRouter = express.Router();
  app.use('/v1', (req, res, next) => {
    if (!providersReady && req.path.startsWith('/rag')) {
      res.status(503).json({ error: { message: 'RAG not ready yet' } });
      return;
    }
    next();
  });
  app.use('/v1', ragRouter);
```

At module level:

```ts
let providersReady = false;
const ragRouterRef: { current: express.Router | null } = { current: null };
```

Set `ragRouterRef.current = ragRouter` in bootstrap. In `cds.on('served')`,
before `initSmartAgents()`:

```ts
  startProviders(getAgentConfig())
    .then((p) => {
      initProviders(p);
      if (ragRouterRef.current) registerRagRoutes(ragRouterRef.current, getCollectionRegistry());
      providersReady = true;
      return initSmartAgents();
    })
    .then(() => log.info('SmartAgents initialized and ready'))
    .catch((err) => log.error('Provider startup failed', { error: err instanceof Error ? err.message : String(err) }));
```

- This replaces the old `initSmartAgents()` call block (649-661).
- The session sweep interval (636) calls `getCollectionRegistry()`, so guard
  it with `if (providersReady)`.
- The session-store path (`getSharedHistoryRag`) is only reached from
  requests, and the 503 readiness guard in `openai-handler.ts` already covers
  requests that arrive before the agents are ready.
- Keep that guard, and make it also return 503 while `!providersReady`: export
  `isProvidersReady()` from agent-manager (`return providers !== null`) and use
  it there.

- [ ] **Step 6: Fix tests that mock agent-manager or build agents**

Run: `npx jest`
Expected: failures only where tests call code that now needs providers.
- For such a test, call once in its `beforeAll`:
  `initProviders(await startProviders(<the literal AgentConfig the test already uses, plus the rag/destinations fields>))`.
- `test/unit/helpers/channel-harness.ts` mocks agent-manager. Add
  `isProvidersReady: () => true` and `getProviders` there.

Re-run `npx jest` until it passes.

- [ ] **Step 7: Type-check, lint, commit**

```bash
npx tsc --noEmit && npm run lint:check
git add srv test/unit
git commit -m "refactor(agent): providers built once at startup, injected into the agent"
```

---

### Task 7: Tool corpus identity — fingerprint hash, corpus hash, store and bundle names

**Files:**
- Create: `srv/lib/tool-corpus.ts`
- Test: `test/unit/tool-corpus.test.ts`

**Interfaces:**
- Consumes: `EmbedderFingerprint` (Task 3), `SharedCorpusDoc` and
  `collectionFor` (agent-manager).
- Produces:
  ```ts
  export type ToolRole = 'reader' | 'writer';
  export function fingerprintHash(fp: EmbedderFingerprint): string              // 12 hex chars
  export function corpusByRole(docs: SharedCorpusDoc[]): Record<ToolRole, SharedCorpusDoc[]>
  export function corpusHash(docs: SharedCorpusDoc[]): string                   // 12 hex chars, order-independent
  export function toolStoreName(role: ToolRole, fp: EmbedderFingerprint, docs: SharedCorpusDoc[]): string // tools-<role>-<fp>-<corpus>
  export function bundleFileFor(fp: EmbedderFingerprint): string                // 'tool-embeddings.json' for the committed AI Core fingerprint, else 'tool-embeddings.<fp>.json'
  export const COMMITTED_BUNDLE_FINGERPRINT: EmbedderFingerprint                // { provider: 'sap-ai-sdk', embeddingModel: 'text-embedding-3-small', resourceGroup: 'default' }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { bundleFileFor, COMMITTED_BUNDLE_FINGERPRINT, corpusByRole, corpusHash, toolStoreName } from '../../srv/lib/tool-corpus';

const d = (name: string, text: string, exposition?: string) => ({ id: `tool:${name}`, name, text, exposition, cached: true });
const fp = { provider: 'ollama', embeddingModel: 'bge-m3', baseURL: 'http://localhost:11434' };

describe('tool corpus identity', () => {
  it('corpus hash is order-independent and text-sensitive', () => {
    expect(corpusHash([d('A', 'a'), d('B', 'b')])).toBe(corpusHash([d('B', 'b'), d('A', 'a')]));
    expect(corpusHash([d('A', 'a')])).not.toBe(corpusHash([d('A', 'a2')]));
  });

  it('a tool moving between roles changes both role names', () => {
    const before = [d('R', 'r', 'read'), d('W', 'w', 'high')];
    const after = [d('R', 'r', 'high'), d('W', 'w', 'high')];
    const rb = corpusByRole(before);
    const ra = corpusByRole(after);
    expect(toolStoreName('reader', fp, rb.reader)).not.toBe(toolStoreName('reader', fp, ra.reader));
    expect(toolStoreName('writer', fp, rb.writer)).not.toBe(toolStoreName('writer', fp, ra.writer));
  });

  it('store names are Qdrant-safe', () => {
    expect(toolStoreName('reader', fp, [d('A', 'a')])).toMatch(/^tools-reader-[0-9a-f]{12}-[0-9a-f]{12}$/);
  });

  it('the committed AI Core bundle keeps its file name; others get their own', () => {
    expect(bundleFileFor(COMMITTED_BUNDLE_FINGERPRINT)).toBe('tool-embeddings.json');
    expect(bundleFileFor(fp)).toMatch(/^tool-embeddings\.[0-9a-f]{12}\.json$/);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx jest test/unit/tool-corpus.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `srv/lib/tool-corpus.ts`**

```ts
import { createHash } from 'node:crypto';
import { collectionFor, type SharedCorpusDoc } from '../agent-manager';
import type { EmbedderFingerprint } from './providers';

export type ToolRole = 'reader' | 'writer';

export const COMMITTED_BUNDLE_FINGERPRINT: EmbedderFingerprint = {
  provider: 'sap-ai-sdk',
  embeddingModel: 'text-embedding-3-small',
  resourceGroup: 'default',
};

const h12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export function fingerprintHash(fp: EmbedderFingerprint): string {
  return h12(JSON.stringify([fp.provider, fp.embeddingModel, fp.baseURL ?? '', fp.resourceGroup ?? '']));
}

export function corpusByRole(docs: SharedCorpusDoc[]): Record<ToolRole, SharedCorpusDoc[]> {
  const out: Record<ToolRole, SharedCorpusDoc[]> = { reader: [], writer: [] };
  for (const doc of docs) out[collectionFor(doc.exposition)].push(doc);
  return out;
}

export function corpusHash(docs: SharedCorpusDoc[]): string {
  const pairs = docs.map((x) => `${x.id}\u0000${x.text}`).sort();
  return h12(pairs.join('\u0001'));
}

export function toolStoreName(role: ToolRole, fp: EmbedderFingerprint, docs: SharedCorpusDoc[]): string {
  return `tools-${role}-${fingerprintHash(fp)}-${corpusHash(docs)}`;
}

export function bundleFileFor(fp: EmbedderFingerprint): string {
  return fingerprintHash(fp) === fingerprintHash(COMMITTED_BUNDLE_FINGERPRINT)
    ? 'tool-embeddings.json'
    : `tool-embeddings.${fingerprintHash(fp)}.json`;
}
```

`agent-manager.ts` must not import `tool-corpus.ts` at module top level if
that creates a cycle that `tsc` or jest reports. If one appears, move
`collectionFor` and `SharedCorpusDoc` into `srv/lib/tool-corpus.ts` and
re-export them from agent-manager.

- [ ] **Step 4: Run, type-check, lint, commit**

```bash
npx jest test/unit/tool-corpus.test.ts && npx tsc --noEmit && npm run lint:check
git add srv/lib/tool-corpus.ts test/unit/tool-corpus.test.ts srv/agent-manager.ts
git commit -m "feat(tools): tool corpus identity for bundles and Qdrant generations"
```

---

### Task 8: Startup loads the tool corpus and never embeds it

**Files:**
- Modify: `srv/agent-manager.ts:1532-1640` (`loadToolEmbeddingBundle`, `ensureSharedToolsVectorized`)
- Test: `test/unit/tool-corpus-load.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7. Also `QdrantRagProvider` from
  `@mcp-abap-adt/qdrant-rag`: `describeCollections()` returns
  `Result<{records: {storeName}[]}>`.
- Produces:
  ```ts
  export class ToolCorpusMissingError extends Error {}   // message names the build step
  export async function loadToolCorpus(p: Providers, docs: SharedCorpusDoc[]): Promise<{ store: ExpositionFilteringRag; count: number }>
  ```
  `ensureSharedToolsVectorized` keeps its name and single-flight, and calls
  `loadToolCorpus`.

- [ ] **Step 1: Write the failing tests**

```ts
jest.mock('@sap/cds', () => ({ __esModule: true, default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }), { virtual: true });
import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import { loadToolCorpus, ToolCorpusMissingError } from '../../srv/agent-manager';

const docs = [
  { id: 'tool:ReadClass', name: 'ReadClass', text: 'read a class', exposition: 'read', cached: true },
  { id: 'tool:CreateClass', name: 'CreateClass', text: 'create a class', exposition: 'high', cached: true },
];

function fakeProviders(backend: 'in-memory' | 'vector' | 'qdrant', opts: { bundle?: unknown; records?: string[]; qdrantDown?: boolean } = {}) {
  const embedCalls: string[] = [];
  const embedder = { embed: async (t: string) => { embedCalls.push(t); return { vector: [1, 0] }; } };
  return {
    embedCalls,
    p: {
      embedding: backend === 'in-memory' ? null : { embedder, breaker: {}, fingerprint: { provider: 'ollama', embeddingModel: 'bge-m3', baseURL: 'http://localhost:11434' } },
      stores: {
        backendOf: () => backend,
        create: () => new InMemoryRag(),
        qdrantCollection: (n: string) => `hub-${n}`,
        listStores: async () => ({ ok: true, value: [] }),
        countPoints: async () => ({ ok: true, value: 1 }),
        deleteStore: async () => ({ ok: true, value: undefined }),
      },
      destinations: { list: async () => [], clearCache() {} },
      __bundle: opts.bundle,
      __records: opts.records,
      __qdrantDown: opts.qdrantDown,
    },
  };
}

describe('loadToolCorpus', () => {
  it('in-memory: loads texts, embeds nothing', async () => {
    const { p, embedCalls } = fakeProviders('in-memory');
    const r = await loadToolCorpus(p as never, docs);
    expect(r.count).toBe(2);
    expect(embedCalls).toEqual([]);
  });

  it('vector without a matching bundle: explicit error naming the build step, nothing embedded', async () => {
    const { p, embedCalls } = fakeProviders('vector', { bundle: null });
    await expect(loadToolCorpus(p as never, docs)).rejects.toThrow(ToolCorpusMissingError);
    await expect(loadToolCorpus(p as never, docs)).rejects.toThrow(/generate-tool-embeddings/);
    expect(embedCalls).toEqual([]);
  });

  it('qdrant without completion records: explicit error; Qdrant down: explicit error naming Qdrant', async () => {
    await expect(loadToolCorpus(fakeProviders('qdrant', { records: [] }).p as never, docs)).rejects.toThrow(ToolCorpusMissingError);
    await expect(loadToolCorpus(fakeProviders('qdrant', { qdrantDown: true }).p as never, docs)).rejects.toThrow(/Qdrant/);
  });
});
```

The `__bundle`, `__records` and `__qdrantDown` fields are read through two
seams added in Step 3:

- `setBundleReaderForTest(fn)`, which replaces `loadToolEmbeddingBundle`;
- `setCatalogReaderForTest(fn)`, which replaces the Qdrant catalog read.

In the test, wire them in a `beforeEach` from the `fakeProviders` result.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx jest test/unit/tool-corpus-load.test.ts`
Expected: FAIL — `loadToolCorpus` is not exported.

- [ ] **Step 3: Implement**

In `srv/agent-manager.ts`:

```ts
export class ToolCorpusMissingError extends Error {
  constructor(detail: string) {
    super(
      `Tool vectors for this configuration were not built (${detail}). ` +
        'Run the build step: npx tsx tools/generate-tool-embeddings.ts with the target configuration.',
    );
    this.name = 'ToolCorpusMissingError';
  }
}

type BundleReader = (file: string) => ToolEmbeddingBundle | null;
type CatalogReader = (p: Providers) => Promise<Set<string>>;
let readBundle: BundleReader = (file) => loadToolEmbeddingBundle(file);
let readCatalog: CatalogReader = async (p) => {
  const q = getAgentConfig().rag.qdrant;
  if (!q || !p.embedding) return new Set();
  const provider = new QdrantRagProvider({
    name: 'hub-tools', url: q.url, embedder: p.embedding.embedder,
    ...(q.apiKey ? { credential: apiKeyCredential(q.apiKey) } : {}),
    catalogCollection: `${q.prefix}-catalog`,
  });
  const r = await provider.describeCollections();
  if (!r.ok) throw new Error(`Qdrant catalog unreachable at ${q.url}: ${r.error.message}`);
  return new Set(r.value.records.map((x) => x.storeName));
};
export function setBundleReaderForTest(fn: BundleReader): void { readBundle = fn; }
export function setCatalogReaderForTest(fn: CatalogReader): void { readCatalog = fn; }

export async function loadToolCorpus(
  p: Providers,
  docs: SharedCorpusDoc[],
): Promise<{ store: ExpositionFilteringRag; count: number }> {
  const uncached = docs.filter((x) => !x.cached).map((x) => x.name);
  if (uncached.length) throw new ToolCorpusMissingError(`tools without intents: ${uncached.join(', ')}`);
  const backend = p.stores.backendOf('tools');

  if (backend === 'in-memory' || !p.embedding) {
    const store = new ExpositionFilteringRag(new InMemoryRag(), new InMemoryRag());
    const w = store.writer();
    for (const x of docs) await w?.upsertRaw(x.id, x.text, x.exposition ? { exposition: x.exposition } : {});
    return { store, count: docs.length };
  }

  const fp = p.embedding.fingerprint;
  if (backend === 'qdrant') {
    const roles = corpusByRole(docs);
    const names = { reader: toolStoreName('reader', fp, roles.reader), writer: toolStoreName('writer', fp, roles.writer) };
    const complete = await readCatalog(p);
    const missing = (['reader', 'writer'] as const).filter((r) => !complete.has(p.stores.qdrantCollection(names[r])));
    if (missing.length) throw new ToolCorpusMissingError(`no completed Qdrant generation for ${missing.join(', ')}`);
    const store = new ExpositionFilteringRag(p.stores.create('tools', names.reader), p.stores.create('tools', names.writer));
    return { store, count: docs.length };
  }

  // vector: exact bundle only — fingerprint AND every entry must match.
  const plan = planBundleLoad(readBundle(bundleFileFor(fp)), docs, fp);
  if (!plan.usable || plan.supplementNames.length > 0) {
    throw new ToolCorpusMissingError(
      plan.usable ? `bundle is stale for: ${plan.supplementNames.join(', ')}` : `no bundle ${bundleFileFor(fp)}`,
    );
  }
  const store = await createToolsRagStore(getAgentConfig().llm.resourceGroup);
  const w = store.writer();
  for (const e of plan.toLoad) {
    await w?.upsertPrecomputedRaw?.(e.id, e.text, e.vector, e.exposition ? { exposition: e.exposition } : {});
  }
  return { store, count: plan.toLoad.length };
}
```

Changes around it:

- `loadToolEmbeddingBundle` takes the file name, reading
  `path.resolve(__dirname, file)`.
- Replace the body of `ensureSharedToolsVectorized`'s `runOutsideAdmission`
  callback with:

```ts
    const { store, count } = await loadToolCorpus(getProviders(), getSharedCorpusDocs());
    sharedToolCount = count;
    sharedToolsRag = store;
    log.info('Shared tool corpus loaded', { toolCount: count, backend: getProviders().stores.backendOf('tools') });
    return store;
```

- Delete `vectorizeToolDocs` (1236-1335) when it is no longer referenced.
  `tsc` reports stale references; keep `buildToolDocs`, since the generator
  uses it through `getSharedCorpusDocs`.
- Where a `ToolCorpusMissingError` reaches `initSmartAgents`, log it at
  `error` level with its message. The request path already returns the
  destination error; make the 503 message include the missing-corpus reason
  when `sharedToolsInit` rejected with that error.

- [ ] **Step 4: Run the tests**

Run: `npx jest test/unit/tool-corpus-load.test.ts test/unit/bundle-load.test.ts test/unit/tool-collections.test.ts`
Expected: PASS.

- [ ] **Step 5: Full test run, type-check, lint, commit**

```bash
npx jest && npx tsc --noEmit && npm run lint:check
git add srv test/unit
git commit -m "feat(tools): startup loads built tool vectors and never embeds the corpus"
```

---

### Task 9: The build step writes bundles and Qdrant generations; `rag-gc` cleans up

**Files:**
- Modify: `tools/generate-tool-embeddings.ts`
- Create: `tools/rag-gc.ts`
- Modify: `.gitignore` (add `srv/tool-embeddings.*.json`)
- Test: `test/integration/tool-generation.qdrant.test.ts`, env-gated

**Interfaces:**
- Consumes: `loadAgentConfig` (Task 2), `startProviders` (Task 6), and
  `corpusByRole`, `toolStoreName`, `bundleFileFor` (Task 7). Also
  `QdrantRagProvider.createCollection(storeName, { scope: 'global', adoptExisting: true, attributes })`.
- Produces: the CLI behaviour below. There is no library API.

- [ ] **Step 1: Rewrite the generator's embedder and target selection**

In `tools/generate-tool-embeddings.ts`:

- Replace `PROVIDER`/`EMBEDDING_MODEL`/`RESOURCE_GROUP`/`BASE_URL`/`makeEmbedder`
  with the hub's own configuration:

```ts
import { QdrantRagProvider } from '@mcp-abap-adt/qdrant-rag';
import { loadAgentConfig } from '../srv/agent-config';
import { getSharedCorpusDocs } from '../srv/agent-manager';
import { apiKeyCredential } from '../srv/lib/llm-factory';
import { startProviders } from '../srv/lib/providers';
import { bundleFileFor, corpusByRole, toolStoreName } from '../srv/lib/tool-corpus';

const config = loadAgentConfig();
const target = config.rag.backends.tools;           // what startup will look for
```

- **Target configuration.** Accept `--mtaext <file>`. Before
  `loadAgentConfig()`, load `.env` with `dotenv` (secrets such as
  `LLM_AGENT_API_KEY`) and then the `parameters` map of the given `.mtaext`,
  parsed with `js-yaml`, into `process.env`. Values from the `.mtaext` win,
  because that is what the deployed app will run with:

```ts
import { load as loadYaml } from 'js-yaml';
import { config as loadDotenv } from 'dotenv';

loadDotenv();
const mtaextArg = process.argv.indexOf('--mtaext');
if (mtaextArg > 0) {
  const file = process.argv[mtaextArg + 1];
  const doc = loadYaml(fs.readFileSync(file, 'utf8')) as { parameters?: Record<string, unknown> };
  for (const [k, v] of Object.entries(doc.parameters ?? {})) {
    if (v !== null && v !== undefined) process.env[k] = String(v);
  }
}
const config = loadAgentConfig();
```

  Move `const config = loadAgentConfig();` below this block, and delete the
  earlier top-level `loadAgentConfig()` line.
- Keep the uncached-tools abort, the canary and the retry helper as they are.
- Decide first, with a pure exported function:

```ts
export type BuildDecision =
  | { action: 'none'; reason: 'tools are in-memory' }
  | { action: 'skip'; reason: string }
  | { action: 'build-bundle'; file: string }
  | { action: 'build-qdrant' };

export function decideToolBuild(
  config: AgentConfig,
  fingerprint: EmbedderFingerprint | null,
  docs: SharedCorpusDoc[],
  readBundle: (file: string) => ToolEmbeddingBundle | null,
): BuildDecision {
  const target = config.rag.backends.tools;
  if (target === 'in-memory' || !fingerprint) return { action: 'none', reason: 'tools are in-memory' };
  if (target === 'qdrant') return { action: 'build-qdrant' }; // per-role skip via completion records below
  const file = bundleFileFor(fingerprint);
  const plan = planBundleLoad(readBundle(file), docs, fingerprint);
  return plan.usable && plan.supplementNames.length === 0
    ? { action: 'skip', reason: `${file} already matches` }
    : { action: 'build-bundle', file };
}
```

  `main()` acts on it:
  - `none` / `skip`: print the reason and exit 0, with zero embedding calls;
  - `build-bundle`: write the bundle as described below;
  - `build-qdrant`: run the per-role Qdrant path below.
- For `target === 'vector'`, compute vectors with
  `providers.embedding.embedder.embed` and write the bundle to
  `srv/${bundleFileFor(fingerprint)}`, with the same header as today and
  `embedderFingerprint: providers.embedding.fingerprint`.
- For `target === 'qdrant'`, for each role:
  1. `name = toolStoreName(role, fp, roles[role])`, and
     `collection = providers.stores.qdrantCollection(name)`;
  2. **skip** the role when the catalog already has a record for
     `collection` (`describeCollections()`), printing `<role>: complete, skipped`;
  3. upsert every doc. `QdrantRag` creates the collection on the first write.
     Use the writer's `upsertPrecomputedRaw` when `QdrantRag.writer()`
     provides it; otherwise call
     `(store as QdrantRag).upsertPrecomputed(doc.text, vector, { id: doc.id, ...(doc.exposition ? { exposition: doc.exposition } : {}) })`.
     Check which one the installed `qdrant-rag.js` has before writing the
     loop;
  4. check `countPoints('tools', name)` equals `roles[role].length`, and else
     exit 1 with both numbers;
  5. write the completion record:

```ts
const provider = new QdrantRagProvider({
  name: 'hub-tools', url: q.url, embedder: providers.embedding.embedder,
  ...(q.apiKey ? { credential: apiKeyCredential(q.apiKey) } : {}),
  catalogCollection: `${q.prefix}-catalog`,
});
const rec = await provider.createCollection(collection, {
  scope: 'global',
  adoptExisting: true,
  collectionName: collection,
  attributes: { kind: 'tool-corpus', role, fingerprint: fingerprintHash(fp), corpus: corpusHash(roles[role]), count: roles[role].length },
});
if (!rec.ok) throw rec.error;
```

- Update the header comment: this is the build step of spec §4.4, run by
  `dev:local` and `tools/deploy.sh`.

- [ ] **Step 2: Create `tools/rag-gc.ts`**

```ts
/**
 * Operator cleanup of old tool-corpus generations on Qdrant (spec §4.4).
 * Never deletes the generation the current configuration resolves to.
 *
 *   npx tsx tools/rag-gc.ts --list
 *   npx tsx tools/rag-gc.ts --delete <store> [<store> ...]
 */
import { loadAgentConfig } from '../srv/agent-config';
import { getSharedCorpusDocs } from '../srv/agent-manager';
import { startProviders } from '../srv/lib/providers';
import { corpusByRole, toolStoreName } from '../srv/lib/tool-corpus';

async function main() {
  const config = loadAgentConfig();
  if (config.rag.backends.tools !== 'qdrant') throw new Error('tools are not on qdrant: nothing to clean');
  const p = await startProviders(config);
  if (!p.embedding) throw new Error('no embedder configured');
  const roles = corpusByRole(getSharedCorpusDocs());
  const current = new Set([
    toolStoreName('reader', p.embedding.fingerprint, roles.reader),
    toolStoreName('writer', p.embedding.fingerprint, roles.writer),
  ]);
  const all = await p.stores.listStores('tools', 'tools-');
  if (!all.ok) throw all.error;
  const args = process.argv.slice(2);
  if (args[0] === '--list' || args.length === 0) {
    for (const s of all.value) console.log(`${current.has(s) ? '* current ' : '  old     '} ${s}`);
    return;
  }
  if (args[0] !== '--delete') throw new Error('usage: --list | --delete <store>...');
  for (const s of args.slice(1)) {
    if (current.has(s)) {
      console.error(`refusing to delete the current generation ${s}`);
      process.exitCode = 1;
      continue;
    }
    const r = await p.stores.deleteStore('tools', s);
    console.log(r.ok ? `deleted ${s}` : `failed ${s}: ${r.error.message}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

Completion records of deleted generations stay in the catalog, where they are
harmless: startup checks both the record and the current name. `--delete` also
removes the record with
`provider.deleteCollection(p.stores.qdrantCollection(s))` instead of
`deleteStore` when the record exists. Implement that branch with the same
`QdrantRagProvider` construction as in Step 1.

- [ ] **Step 3: Write the env-gated integration test**

`test/integration/tool-generation.qdrant.test.ts`:
- It skips unless `LLM_AGENT_QDRANT_URL` points at a throwaway Qdrant, and
  **refuses port 6333**: `if (/:6333\b/.test(url)) throw new Error('use an isolated Qdrant port')`.
- It uses a fake embedder: an `IEmbedder` returning a deterministic 8-dim
  vector from the text hash, injected through `startProviders` with
  `LLM_AGENT_EMBEDDER=openai` and a mocked `resolveEmbedder`.
- It asserts:
  1. **first run** writes both role stores and records;
  2. **second run** is skipped, with zero embed calls;
  3. **interrupted run**: delete only the record of `reader`, and the next run
     rewrites `reader` idempotently and records it;
  4. **startup** (`loadToolCorpus`) after the run makes zero embed calls;
  5. **rag-gc** `--list` marks the current generations; `--delete` of a
     current one is refused.

- [ ] **Step 4: Run what can run locally**

```bash
docker compose -f docker-compose.local.yml up -d   # created in Task 10; or any Qdrant on 6433
LLM_AGENT_QDRANT_URL=http://localhost:6433 npx jest --testMatch='**/test/integration/tool-generation.qdrant.test.ts'
npx tsc --noEmit && npm run lint:check
```

Expected: PASS. Without `LLM_AGENT_QDRANT_URL` the test is skipped.

- [ ] **Step 5: Commit**

```bash
git add tools/generate-tool-embeddings.ts tools/rag-gc.ts .gitignore test/integration/tool-generation.qdrant.test.ts
git commit -m "feat(tools): build step writes bundles or Qdrant generations; rag-gc cleans up"
```

---

### Task 10: Local-run kit

**Files:**
- Create: `.env.local.example`, `docker-compose.local.yml`, `tools/dev-local.js`, `docs/development/LOCAL_RUN.md`
- Modify:
  - `package.json`: `"dev:local": "node tools/dev-local.js"`;
  - `tools/deploy.sh`: run the build step before `cf deploy` when the fork's
    tools backend is not in-memory;
  - `README.md`: a "Run locally" section linking `LOCAL_RUN.md`;
  - `docs/llm-agent/CONFIG_USAGE.md`: the new variables table from spec §3;
  - `.env.example`: comment block with the new variables;
  - `docs/development/README.md`: link.
- Test: `test/unit/dev-local.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 9.
- Produces: `tools/dev-local.js` exports `checkHybrid(root: string): string | null`,
  which returns a warning message naming the file, or null.

- [ ] **Step 1: Write the failing test**

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// biome-ignore lint/suspicious/noExplicitAny: plain JS module
const { checkHybrid } = require('../../tools/dev-local.js') as any;

it('warns about default-env.json, naming the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devlocal-'));
  expect(checkHybrid(dir)).toBeNull();
  fs.writeFileSync(path.join(dir, 'default-env.json'), '{}');
  expect(checkHybrid(dir)).toMatch(/default-env\.json/);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx jest test/unit/dev-local.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create the kit**

`tools/dev-local.js`:

```js
#!/usr/bin/env node
/** the `dev:local` npm script — spec §5: warn about hybrid, build tool vectors, start. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function checkHybrid(root) {
  const f = path.join(root, 'default-env.json');
  return fs.existsSync(f)
    ? `${f} exists: its VCAP_SERVICES make this run hybrid (real BTP services). Move it aside for a BTP-free run.`
    : null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const warn = checkHybrid(root);
  if (warn) console.warn(`WARNING: ${warn}`);
  run('npx', ['tsx', 'tools/generate-tool-embeddings.ts']);
  run('npx', ['cds', 'watch', '--profile', 'development']);
}

module.exports = { checkHybrid };
```

`docker-compose.local.yml`:

```yaml
# Local Qdrant for cloud-llm-hub (spec §5). Ports 6433/6434, not 6333:
# 6333 is commonly taken by other projects' Qdrant.
name: cloud-llm-hub-local
services:
  qdrant:
    image: qdrant/qdrant:v1.17.0
    ports:
      - '6433:6333'
      - '6434:6334'
    volumes:
      - qdrant-data:/qdrant/storage
volumes:
  qdrant-data:
```

`.env.local.example`:

```ini
# Local run (spec §5). Copy to .env. No credentials here: SAP login/password
# come per request in x-sap-login / x-sap-password headers.
LLM_AGENT_PROVIDER=openai
LLM_AGENT_BASE_URL=http://localhost:11434/v1
LLM_AGENT_API_KEY=ollama
LLM_AGENT_MODEL=qwen2.5:14b

LLM_AGENT_EMBEDDER=ollama
LLM_AGENT_EMBEDDING_MODEL=bge-m3
LLM_AGENT_EMBEDDER_URL=http://localhost:11434

LLM_AGENT_TOOLS_RAG_BACKEND=vector
LLM_AGENT_SESSION_RAG_BACKEND=vector
LLM_AGENT_RAG_BACKEND=vector
LLM_AGENT_QDRANT_URL=http://localhost:6433

LLM_AGENT_DESTINATION_SOURCE=env
LLM_AGENT_MCP_DESTINATION=SAP_DEV
destinations=[{"name":"SAP_DEV","url":"https://sap.example.com:44300","proxyType":"Internet","authentication":"NoAuthentication","sapClient":"100"}]
```

Plan B switches `LLM_AGENT_RAG_BACKEND` to `qdrant`. Task 11 decides the tools
line.

`docs/development/LOCAL_RUN.md` is ADHD-friendly: a TL;DR first, short chunks.
It has these sections:
- **TL;DR**: the five commands.
- **Prerequisites:**
  - Ollama with a tool-calling model (`qwen2.5:14b`) and `bge-m3`;
  - Docker;
  - Node 22;
  - a SAP system reachable from the machine;
  - a package you own for write tests.
- **Steps:**
  1. `cp .env.local.example .env`, then set the host and client;
  2. `docker compose -f docker-compose.local.yml up -d`;
  3. `ollama pull qwen2.5:14b && ollama pull bge-m3`;
  4. `npm ci`;
  5. the `dev:local` npm script.
- **Calling the agent:** a `curl` to `http://localhost:4004/v1/chat/completions`
  with `Authorization: Basic YWxpY2U6` (mocked user alice),
  `X-SAP-Destination: SAP_DEV`, `x-sap-login`, `x-sap-password`, `x-sap-client`.
- **Troubleshooting:**
  - "Tool vectors … were not built": run the build step;
  - the `default-env.json` warning;
  - port 6433 is in use;
  - a small model does not call tools.
- **A development setup, not production:** local models are weaker at tool
  calling.

`tools/deploy.sh`: after the CF-target check and before `[3/4] Build`, add:

```bash
# Tool vectors are built, not computed at startup (spec §4.4). Always run the
# build step: it resolves the effective tools backend with the app's own
# config rules (legacy LLM_AGENT_RAG_TYPE and defaults included), and it
# exits without work for in-memory or when matching vectors already exist.
# Same extension file cf deploy uses (.mtaext or .mtaext.staging).
echo ""
echo "[build] Tool vectors..."
npx tsx tools/generate-tool-embeddings.ts --mtaext "$MTAEXT"
```

- [ ] **Step 4: Run the tests and the docs check**

Run: `npx jest test/unit/dev-local.test.ts && node tools/check-docs.js`
Expected: PASS, and `docs:check — OK`. The new docs must name only variables
the code now reads.

Also add a unit test for `decideToolBuild`, with these cases:

- **legacy `.mtaext`:** only `LLM_AGENT_RAG_TYPE: vector`, with
  `LLM_AGENT_PROVIDER: openai`. `applyMtaext`, then `loadAgentConfig`, then the
  decision must be `build-bundle` with a `tool-embeddings.<fp>.json` file;
- **same config** with a reader returning a fully matching bundle: `skip`;
- **default AI Core config** with the committed bundle
  (`LLM_AGENT_RAG_TYPE: vector`, provider unset): `skip`;
- **no RAG variables:** `none`.

Also add a unit test for the generator's `--mtaext` loading. Extract the block
above into an exported `applyMtaext(file: string, env: NodeJS.ProcessEnv): void`
in `tools/generate-tool-embeddings.ts`, and assert that a temp `.mtaext` with
`parameters: { LLM_AGENT_TOOLS_RAG_BACKEND: qdrant }` sets that key and
overrides a pre-set value.

- [ ] **Step 5: Commit**

```bash
git add .env.local.example docker-compose.local.yml tools/dev-local.js tools/deploy.sh docs README.md .env.example package.json test/unit/dev-local.test.ts
git commit -m "feat(dev): local-run kit — Ollama, Qdrant, env destinations"
```

---

### Task 10b: Carry the new settings through the MTA descriptor

On BTP the app sees a `.mtaext` value only when `mta.yaml` declares the
parameter and passes it as `${NAME}` into the `cloud-llm-hub-srv` properties,
as it does for `LLM_AGENT_RAG_TYPE` (lines 19 and 89). Without this, the build
step (Task 9, reading `.mtaext`) and the deployed app would see different
configurations.

**Files:**
- Modify: `mta.yaml` (parameters block ~14-34, srv `properties` ~84-100)
- Modify: `docs/deployment/templates/*.mtaext.template`
- Test: `test/unit/mta-config-params.test.ts`

**Interfaces:**
- Consumes: the variable names parsed in Task 2.
- Produces: nothing new in code.

- [ ] **Step 1: Write the failing test**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';

// Non-secret settings parsed by parseRagConfig / parseDestinationConfig.
// Secrets (LLM_AGENT_EMBEDDER_API_KEY, LLM_AGENT_QDRANT_API_KEY) go through
// .env → cf set-env (tools/deploy.sh), never through mta.yaml.
const CARRIED = [
  'LLM_AGENT_EMBEDDER', 'LLM_AGENT_EMBEDDING_MODEL', 'LLM_AGENT_EMBEDDER_URL',
  'LLM_AGENT_TOOLS_RAG_BACKEND', 'LLM_AGENT_SESSION_RAG_BACKEND', 'LLM_AGENT_RAG_BACKEND',
  'LLM_AGENT_RAG_TYPE', 'LLM_AGENT_QDRANT_URL', 'LLM_AGENT_QDRANT_PREFIX',
  'LLM_AGENT_DESTINATION_SOURCE',
];

it('every non-secret RAG/destination setting reaches cloud-llm-hub-srv', () => {
  const mta = load(fs.readFileSync(path.resolve(__dirname, '../../mta.yaml'), 'utf8')) as {
    parameters: Record<string, unknown>;
    modules: { name: string; properties?: Record<string, unknown> }[];
  };
  const srv = mta.modules.find((m) => m.name === 'cloud-llm-hub-srv');
  for (const name of CARRIED) {
    expect([name, name in mta.parameters]).toEqual([name, true]);
    expect([name, srv?.properties?.[name]]).toEqual([name, `\${${name}}`]);
  }
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx jest test/unit/mta-config-params.test.ts`
Expected: FAIL on `LLM_AGENT_EMBEDDER`.

- [ ] **Step 3: Edit `mta.yaml`**

In `parameters`, after `LLM_AGENT_RAG_QUERY_K`, add:

```yaml
  # RAG providers (spec §3). Empty = today's behaviour. Secrets
  # (LLM_AGENT_EMBEDDER_API_KEY, LLM_AGENT_QDRANT_API_KEY) are NOT here:
  # put them in the fork's .env, which tools/deploy.sh applies with cf set-env.
  LLM_AGENT_EMBEDDER:
  LLM_AGENT_EMBEDDER_URL:
  LLM_AGENT_TOOLS_RAG_BACKEND:
  LLM_AGENT_SESSION_RAG_BACKEND:
  LLM_AGENT_RAG_BACKEND:
  LLM_AGENT_QDRANT_URL:
  LLM_AGENT_QDRANT_PREFIX:
  LLM_AGENT_DESTINATION_SOURCE:
```

In the `cloud-llm-hub-srv` `properties`, after `LLM_AGENT_RAG_QUERY_K`, add one
`NAME: ${NAME}` line for each of the eight names above.

Check the empty-value behaviour before relying on it: deploy the fork's
staging once in Task 12. Verify that `cf env cloud-llm-hub-staging-srv` shows
these keys empty or absent, not the string `null`. `parseRagConfig` treats an
empty value as unset. If CF sets the literal `null`, make `set()` in
`agent-config.ts` treat `'null'` as unset too, and extend the Task 2 tests.

- [ ] **Step 4: Templates and docs check**

Add the new non-secret parameters, commented out with their defaults, to each
`docs/deployment/templates/*.mtaext.template`. Then run:

Run: `npx jest test/unit/mta-config-params.test.ts && node tools/check-docs.js`
Expected: PASS and `docs:check — OK`. `check-docs` verifies that template
parameters are declared in `mta.yaml` and referenced.

- [ ] **Step 5: Commit**

```bash
git add mta.yaml docs/deployment/templates test/unit/mta-config-params.test.ts
git commit -m "feat(mta): carry RAG provider and destination settings to the srv module"
```

---

### Task 11: Measure tool retrieval — in-memory vs Qdrant

**Files:**
- Create: `tools/tool-rag-queries.json`, `tools/measure-tool-rag.ts`

**Interfaces:**
- Consumes: `startProviders`, `loadToolCorpus`, `getSharedCorpusDocs`.
- Produces: a printed report; no library API.

- [ ] **Step 1: Commit the query set (31 queries, neutral names)**

`tools/tool-rag-queries.json` is an array of `{ "q": string, "expect": string[] }`.
It uses these 31 entries: the set used for the lib 13.1 corpus check, with
names replaced.

```json
[
  { "q": "Які пакети в $TMP маємо?", "expect": ["GetPackageContents", "GetPackageTree"] },
  { "q": "List all objects in package $TMP", "expect": ["GetPackageContents", "GetPackageTree"] },
  { "q": "Покажи дерево пакета ZDEMO_LAB", "expect": ["GetPackageTree", "GetPackageContents"] },
  { "q": "Show me the source code of class ZCL_DEMO", "expect": ["ReadClass", "GetClass"] },
  { "q": "Покажи код програми ZREP_DEMO", "expect": ["ReadProgram", "GetProgram"] },
  { "q": "What fields does table MARA have?", "expect": ["ReadTable", "GetTable"] },
  { "q": "Show the first 10 rows of table T001", "expect": ["GetTableContents"] },
  { "q": "Read the CDS view I_PRODUCT", "expect": ["ReadView", "GetView", "ReadDdl", "GetDdl"] },
  { "q": "Show the behavior definition of ZI_TRAVEL", "expect": ["ReadBehaviorDefinition", "GetBehaviorDefinition"] },
  { "q": "Покажи функціональний модуль BAPI_USER_GET_DETAIL", "expect": ["ReadFunctionModule", "GetFunctionModule"] },
  { "q": "Find all classes whose name starts with Z", "expect": ["SearchObject"] },
  { "q": "Знайди об'єкти за маскою Z*", "expect": ["SearchObject"] },
  { "q": "Find source code that contains SELECT * in packages Z*", "expect": ["SearchSource"] },
  { "q": "Where is class ZCL_DEMO used?", "expect": ["GetWhereUsed"] },
  { "q": "Покажи короткі дампи за сьогодні", "expect": ["RuntimeListFeeds", "RuntimeListDumps"] },
  { "q": "Show ST22 runtime errors for user DEVELOPER", "expect": ["RuntimeListFeeds", "RuntimeListDumps"] },
  { "q": "Run the class ZCL_DEMO and show its output", "expect": ["RuntimeRunClass"] },
  { "q": "Run ATC checks on package ZDEMO_LAB", "expect": ["RunATC"] },
  { "q": "Run unit tests of class ZCL_DEMO", "expect": ["RunUnitTest"] },
  { "q": "Check syntax of program ZREP_DEMO", "expect": ["CheckProgram"] },
  { "q": "Які об'єкти в транспорті DEVK900001?", "expect": ["ReadTransportObjects", "GetTransport"] },
  { "q": "List my open transport requests", "expect": ["ListTransports"] },
  { "q": "Create a transport request for package ZDEMO_LAB", "expect": ["CreateTransport"] },
  { "q": "Add class ZCL_DEMO to transport DEVK900001", "expect": ["AddTransportObject"] },
  { "q": "Create class ZCL_DEMO in package $TMP", "expect": ["CreateClass"] },
  { "q": "Створи домен ZDEMO_D_TEST у пакеті $TMP", "expect": ["CreateDomain"] },
  { "q": "Create a CDS view ZI_DEMO in $TMP", "expect": ["CreateDdl", "CreateView"] },
  { "q": "Update the source code of program ZREP_DEMO", "expect": ["UpdateProgram"] },
  { "q": "Activate class ZCL_DEMO", "expect": ["ActivateClass", "ActivateObjects"] },
  { "q": "Delete class ZCL_DEMO", "expect": ["DeleteClass"] },
  { "q": "Видали таблицю ZDEMO_T_TEST з $TMP", "expect": ["DeleteTable"] }
]
```

- [ ] **Step 2: Write `tools/measure-tool-rag.ts`**

```ts
/**
 * Tool retrieval: hit rate and latency for the configured tools backend.
 * Run twice — LLM_AGENT_TOOLS_RAG_BACKEND=vector, then =qdrant — after the build
 * step for each, and compare. Spec §6 "Speed".
 *   npx tsx tools/measure-tool-rag.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QueryEmbedding } from '@mcp-abap-adt/llm-agent';
import { loadAgentConfig } from '../srv/agent-config';
import { getSharedCorpusDocs, initProviders, loadToolCorpus } from '../srv/agent-manager';
import { startProviders } from '../srv/lib/providers';

const K = 15;
type Q = { q: string; expect: string[] };

async function main() {
  const queries = JSON.parse(fs.readFileSync(path.join(__dirname, 'tool-rag-queries.json'), 'utf8')) as Q[];
  const config = loadAgentConfig();
  const p = await startProviders(config);
  initProviders(p);
  if (!p.embedding) throw new Error('measure needs an embedder (tools backend vector or qdrant)');
  const { store } = await loadToolCorpus(p, getSharedCorpusDocs());
  const times: number[] = [];
  let hits = 0;
  for (const { q, expect } of queries) {
    for (const exposition of ['read', 'high']) {
      const t0 = performance.now();
      const r = await store.query(new QueryEmbedding(q, p.embedding.embedder), K, { ragFilter: { exposition } } as never);
      times.push(performance.now() - t0);
      if (!r.ok) throw r.error;
      const names = r.value.map((x) => String(x.metadata.id ?? '').replace(/^tool:/, ''));
      if (names.some((n) => expect.includes(n))) hits++;
    }
  }
  times.sort((a, b) => a - b);
  const pct = (x: number) => times[Math.min(times.length - 1, Math.floor(x * times.length))].toFixed(1);
  console.log(JSON.stringify({ backend: config.rag.backends.tools, queries: times.length, hits, p50ms: pct(0.5), p95ms: pct(0.95) }));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
```

If `QueryEmbedding`'s constructor or the `ragFilter` option differs in
llm-agent 29, read `node_modules/@mcp-abap-adt/llm-agent/dist/index.d.ts` and
adapt. The shape of the numbers stays.

- [ ] **Step 3: Run both backends locally and record the numbers in the PR description**

```bash
LLM_AGENT_TOOLS_RAG_BACKEND=vector npx tsx tools/generate-tool-embeddings.ts && LLM_AGENT_TOOLS_RAG_BACKEND=vector npx tsx tools/measure-tool-rag.ts
LLM_AGENT_TOOLS_RAG_BACKEND=qdrant npx tsx tools/generate-tool-embeddings.ts && LLM_AGENT_TOOLS_RAG_BACKEND=qdrant npx tsx tools/measure-tool-rag.ts
```

Expected: two JSON lines. The spec says the result is "recorded in the spec's
follow-up", and that is a spec edit, so **ask the user** before writing it
there. Put the numbers in the PR description either way. The user decides
whether the local preset moves tools to Qdrant.

- [ ] **Step 4: Commit**

```bash
git add tools/tool-rag-queries.json tools/measure-tool-rag.ts
git commit -m "chore(tools): measure tool retrieval hit rate and latency per backend"
```

---

### Task 12: Local acceptance and BTP regression

This is a manual gate, run by the executor with the user's SAP credentials and
a package the user owns. Follow the SAP test-package rules: never touch
`TEST_MCP_SHR_PKG`, `TEST_ADT_SHR_PKG` or any `*AC_SHR`; create before testing;
read back.

- [ ] **Step 1: Local run with the kit** (Task 10). It passes when:
  - a read request (`Read the metadata of class CL_ABAP_TYPEDESCR…`) runs a
    real `ReadClass` through the env destination, as shown in the log;
  - a restart logs `Shared tool corpus loaded` with no embedding;
  - a scratch create + activate in the user's package leaves no lock, per
    SM12 or a second LOCK.
- [ ] **Step 2: BTP regression.** Deploy the branch to a deployment fork's
  staging (`<deployment fork>`, its deploy branch, `tools/deploy.sh staging`) with an
  **unchanged** `.mtaext`. It passes when:
  - `tools/verify-consumer-xsuaa.sh` passes for both consumers;
  - one agent read request succeeds;
  - the log shows `Shared tool corpus loaded` from the committed bundle.
  - the `.mtaext.staging` is unchanged, so it sets none of the Task 10b keys.
    `cf env cloud-llm-hub-staging-srv` therefore shows them empty or absent,
    never the string `null`;
  - the effective config agrees on both sides. The app log line
    `Agent configuration loaded` shows `ragBackends` and `embedder`, and they
    equal what the build step printed. Both equal the defaults derived from
    the legacy `LLM_AGENT_RAG_TYPE`: tools, session and persistent on
    `vector`, embedder `sap-ai-core`.
  - The generator must print that line. Add
    `console.log('effective config', { ragBackends: config.rag.backends, embedder: config.rag.embedder?.kind })`
    in Task 9 right after `loadAgentConfig()`.

  Deploying is outward-facing, so confirm with the user first.
- [ ] **Step 3: Full checks and the PR**

```bash
npx jest && npx tsc --noEmit && npm run lint:check && node tools/check-docs.js
git push -u origin feat/configurable-providers-a
gh pr create --base main --title "feat: configurable embedder, RAG backends and destination source; build-time tool vectors; local run"
```

The PR body: TL;DR, what changed per spec section, the migration note (an
`openai`-embedder deployment must run the build step), the Task 11 numbers, and
the test evidence.
