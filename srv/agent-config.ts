/**
 * Agent Configuration Module
 *
 * Reads configuration from environment variables (set via mta.yaml or CF CLI).
 * This configuration is used by Agent Service (OData) and OpenAI-compatible
 * endpoints to connect SmartAgent to LLM (SAP AI Core) and MCP.
 *
 * Architecture:
 * - Configuration comes from environment variables (mta.yaml deployment or CF CLI)
 * - SAP AI Core access: the service key comes from the aicore binding in VCAP_SERVICES or
 *   AICORE_SERVICE_KEY, read by srv/lib/llm-factory.ts (llm-agent 27 providers read no env)
 * - MCP destination is resolved via SAP Cloud SDK (same as MCP proxy)
 *
 * Configuration variables:
 * - LLM_AGENT_MODEL: Model name (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet')
 * - LLM_AGENT_TEMPERATURE: Temperature (default: 0.7)
 * - LLM_AGENT_MAX_TOKENS: Max tokens (default: 2000)
 * - LLM_AGENT_MCP_DESTINATION: Destination name for MCP/ABAP connection (required)
 * - LLM_AGENT_MCP_ENDPOINT: MCP proxy endpoint URL (optional, defaults to local)
 * - LLM_AGENT_MODE: SmartAgent mode: 'smart' | 'pass' | 'hard' (default: 'smart')
 * - LLM_AGENT_MAX_ITERATIONS: Max tool loop iterations (default: 10)
 * - LLM_AGENT_RAG_TYPE: RAG backend: 'in-memory' | 'ollama' (default: 'in-memory')
 * - LLM_AGENT_EXPOSITION: (deprecated — tool filtering now role-based via RAG)
 */

import type { IThrottleStrategy } from '@mcp-abap-adt/llm-agent';
import { WaitAsTold } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  describeGatekeeperConfig,
  gatekeeperConfig,
} from './lib/gatekeeper-config';
import {
  DEFAULT_MAX_THROTTLE_WAIT_MS,
  WaitIfShortEnough,
} from './lib/throttle-strategy';

export type SmartAgentMode = 'smart' | 'pass' | 'hard';
export type RagType = 'in-memory' | 'ollama';

export type LlmProvider = 'sap-ai-sdk' | 'openai' | 'anthropic' | 'deepseek';

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
export interface QdrantConfig {
  url: string;
  apiKey?: string;
  prefix: string;
}
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

export interface AgentConfig {
  /**
   * LLM Configuration
   */
  llm: {
    /** LLM provider: 'sap-ai-sdk' (default), 'openai', 'anthropic', 'deepseek' */
    provider: LlmProvider;

    /** Model name (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet') */
    model: string;

    /**
     * Model for the helper calls (classification, query translation):
     * `LLM_AGENT_CLASSIFIER_MODEL`, else {@link model}.
     */
    classifierModel: string;

    /** Temperature (0.0 - 2.0) */
    temperature: number;

    /** Maximum tokens in response */
    maxTokens: number;

    /** API key for openai/anthropic/deepseek providers */
    apiKey?: string;

    /** Base URL for openai-compatible providers (e.g., https://api.openai.com/v1) */
    baseUrl?: string;

    /** SAP AI Core resource group (sap-ai-sdk only) */
    resourceGroup?: string;

    /**
     * What the provider does when the LLM service throttles it (HTTP 429).
     *
     * Since llm-agent 24.0.0 this is a strategy, not a number: the library
     * establishes the facts and leaves the decision to whoever can see who is
     * waiting. That is us. See `srv/lib/throttle-strategy.ts`.
     */
    whenThrottled: IThrottleStrategy;
  };

  /**
   * MCP Configuration
   */
  mcp: {
    /**
     * MCP destination name for ABAP connection
     * This destination must be configured in Destination service
     * The MCP proxy will use this destination to connect to ABAP
     */
    destination: string;

    /**
     * MCP proxy endpoint URL
     * If not provided, will be constructed from request (for BTP) or use localhost
     */
    endpoint?: string;

    /**
     * SAP system code → destination name (`DEV.100` → `S4HANA_DEV`), from
     * `DESTINATION_MAPPING` = `DEV.100=S4HANA_DEV,QAS.600=S4HANA_QAS`.
     */
    systemDestinations: Record<string, string>;
  };

  /**
   * SmartAgent orchestration settings
   */
  agent: {
    /** Agent mode: 'smart' (full orchestration), 'pass' (passthrough), 'hard' (tools only) */
    mode: SmartAgentMode;

    /** Maximum tool loop iterations */
    maxIterations: number;

    /** RAG backend type */
    ragType: RagType;

    /** Max recent messages to include from client history (older excluded, available via RAG) */
    historyRecencyWindow?: number;

    /** Number of tools selected by RAG per query (default: 5) */
    ragQueryK: number;

    /**
     * Most `skill:*` entries one RAG query may surface (`LLM_AGENT_SKILL_RAG_K`,
     * default 3; 0 disables skills). Skills and tools compete for one top-K.
     */
    skillRagK: number;

    /**
     * `LLM_AGENT_ALLOW_LLM_ONLY_FALLBACK=true`: a request that names no
     * destination may fall back to the LLM-only agent when the default one
     * is not ready.
     */
    allowLlmOnlyFallback: boolean;
  };

  /** Embedder + per-class RAG backend selection. */
  rag: RagConfig;

  /** Where SAP destinations come from: the BTP Destination service, or env-provided. */
  destinations: DestinationConfig;
}

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

/**
 * Parse the embedder and per-class RAG backend selection from the environment.
 *
 * Per-class variables (`LLM_AGENT_TOOLS_RAG_BACKEND`, `LLM_AGENT_SESSION_RAG_BACKEND`,
 * `LLM_AGENT_RAG_BACKEND`) override the legacy `LLM_AGENT_RAG_TYPE` default for that
 * class. Mixing `LLM_AGENT_RAG_TYPE=in-memory` with a per-class override that is not
 * `in-memory` is rejected as contradictory. An embedder is only required — and only
 * accepted — when at least one class is not `in-memory`.
 */
export function parseRagConfig(
  env: NodeJS.ProcessEnv,
  llm: {
    provider: LlmProvider;
    apiKey?: string;
    baseUrl?: string;
    resourceGroup?: string;
  },
): RagConfig {
  const ragType = set(env, 'LLM_AGENT_RAG_TYPE');
  const legacy: RagBackendKind =
    !ragType || ragType === 'in-memory' ? 'in-memory' : 'vector';
  const backends = {} as Record<RagStoreClass, RagBackendKind>;
  for (const cls of Object.keys(CLASS_VARS) as RagStoreClass[]) {
    const name = CLASS_VARS[cls];
    const raw = set(env, name);
    if (raw !== undefined && !BACKENDS.includes(raw as RagBackendKind)) {
      throw new Error(
        `Invalid ${name}: expected one of ${BACKENDS.join(', ')}, got ${JSON.stringify(raw)}`,
      );
    }
    if (raw !== undefined && ragType === 'in-memory' && raw !== 'in-memory') {
      throw new Error(
        `LLM_AGENT_RAG_TYPE=in-memory and ${name}=${raw} contradict each other`,
      );
    }
    backends[cls] = (raw as RagBackendKind | undefined) ?? legacy;
  }
  if (backends.session === 'qdrant') {
    throw new Error(
      'LLM_AGENT_SESSION_RAG_BACKEND=qdrant is not yet supported (spec phase 2)',
    );
  }
  if (backends.persistent === 'qdrant') {
    throw new Error(
      'LLM_AGENT_RAG_BACKEND=qdrant is not yet supported: it arrives with Plan B (persistent collections)',
    );
  }

  const needsEmbedder = Object.values(backends).some((b) => b !== 'in-memory');
  const kindRaw = set(env, 'LLM_AGENT_EMBEDDER');
  if (!needsEmbedder) {
    if (kindRaw !== undefined) {
      throw new Error(
        'LLM_AGENT_EMBEDDER is set, but every RAG class is in-memory, so nothing would use it',
      );
    }
    return { embedder: null, backends };
  }
  if (kindRaw !== undefined && !EMBEDDERS.includes(kindRaw as EmbedderKind)) {
    throw new Error(
      `Invalid LLM_AGENT_EMBEDDER: expected one of ${EMBEDDERS.join(', ')}, got ${JSON.stringify(kindRaw)}`,
    );
  }
  const kind =
    (kindRaw as EmbedderKind | undefined) ??
    (llm.provider === 'sap-ai-sdk' ? 'sap-ai-core' : 'openai');
  const model = set(env, 'LLM_AGENT_EMBEDDING_MODEL');
  let embedder: EmbedderConfig;
  if (kind === 'sap-ai-core') {
    embedder = {
      kind,
      model: model ?? DEFAULT_EMBEDDING_MODEL,
      resourceGroup: llm.resourceGroup,
    };
  } else if (kind === 'openai') {
    embedder = {
      kind,
      model: model ?? DEFAULT_EMBEDDING_MODEL,
      url: set(env, 'LLM_AGENT_EMBEDDER_URL') ?? llm.baseUrl,
      apiKey: set(env, 'LLM_AGENT_EMBEDDER_API_KEY') ?? llm.apiKey,
    };
  } else {
    if (!model)
      throw new Error(
        'LLM_AGENT_EMBEDDER=ollama needs LLM_AGENT_EMBEDDING_MODEL (no default model)',
      );
    embedder = {
      kind,
      model,
      url: set(env, 'LLM_AGENT_EMBEDDER_URL') ?? 'http://localhost:11434',
    };
  }
  // Drop undefined keys so configs compare structurally.
  for (const k of Object.keys(embedder) as (keyof EmbedderConfig)[]) {
    if (embedder[k] === undefined) delete embedder[k];
  }

  const rag: RagConfig = { embedder, backends };
  if (Object.values(backends).includes('qdrant')) {
    const url = set(env, 'LLM_AGENT_QDRANT_URL');
    if (!url)
      throw new Error(
        'A RAG class uses qdrant, but LLM_AGENT_QDRANT_URL is not set',
      );
    const apiKey = set(env, 'LLM_AGENT_QDRANT_API_KEY');
    rag.qdrant = {
      // Paths are appended as `${url}/collections`; a trailing slash would double it.
      url: url.replace(/\/+$/, ''),
      prefix: set(env, 'LLM_AGENT_QDRANT_PREFIX') ?? 'cloud-llm-hub',
      ...(apiKey ? { apiKey } : {}),
    };
  }
  return rag;
}

/** `LLM_AGENT_SKILL_RAG_K`: a finite number, truncated and floored at 0; else 3. */
export function parseSkillRagK(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.LLM_AGENT_SKILL_RAG_K);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 3;
}

/** `DESTINATION_MAPPING` = `DEV.100=S4HANA_DEV,QAS.600=S4HANA_QAS`; malformed pairs are skipped. */
export function parseDestinationMapping(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const pair of (env.DESTINATION_MAPPING || '').split(',')) {
    const [system, dest] = pair.split('=').map((s) => s.trim());
    if (system && dest) mapping[system] = dest;
  }
  return mapping;
}

function pick(
  o: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/**
 * Parse where SAP destinations come from: the BTP Destination service (default),
 * or the Cloud SDK `destinations` env var (`LLM_AGENT_DESTINATION_SOURCE=env`) —
 * used off-platform, where no Destination service is reachable.
 */
export function parseDestinationConfig(
  env: NodeJS.ProcessEnv,
): DestinationConfig {
  const source = set(env, 'LLM_AGENT_DESTINATION_SOURCE') ?? 'btp';
  if (source === 'btp') return { source };
  if (source !== 'env') {
    throw new Error(
      `Invalid LLM_AGENT_DESTINATION_SOURCE: expected btp or env, got ${JSON.stringify(source)}`,
    );
  }
  const raw = set(env, 'destinations');
  if (!raw)
    throw new Error(
      'LLM_AGENT_DESTINATION_SOURCE=env needs the Cloud SDK `destinations` variable',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `The \`destinations\` variable is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      'The `destinations` variable must be a JSON array with at least one destination',
    );
  }
  const destinations = parsed.map((d, i): EnvDestination => {
    const o = (d ?? {}) as Record<string, unknown>;
    const name = pick(o, 'name', 'Name');
    const url = pick(o, 'url', 'URL');
    if (!name || !url)
      throw new Error(`destinations[${i}] needs a name and a url`);
    const sapClient = pick(o, 'sapClient', 'sap-client');
    return {
      name,
      url,
      proxyType: pick(o, 'proxyType', 'ProxyType') ?? 'Internet',
      authentication:
        pick(o, 'authentication', 'Authentication') ?? 'NoAuthentication',
      ...(sapClient ? { sapClient } : {}),
    };
  });
  return { source: 'env', destinations };
}

/**
 * Load agent configuration from environment variables
 *
 * Configuration priority:
 * 1. Environment variables (set via mta.yaml or CF CLI)
 * 2. Default values
 *
 * @throws Error if required configuration is missing
 */
export function loadAgentConfig(): AgentConfig {
  const log = cds.log('agent-config');

  // Validated here because this runs at startup. A malformed limit must stop
  // the service before it takes traffic, not on the first request that meets it.
  const gatekeeper = gatekeeperConfig();

  // LLM Configuration
  const provider = (process.env.LLM_AGENT_PROVIDER ||
    'sap-ai-sdk') as LlmProvider;

  // With a door, an admitted session is carried to the end: it waits out exactly
  // what the server named, and a ceiling behind the door would only kill work in
  // flight. With no door nothing is admitted, and the ceiling still keeps a wait
  // shorter than the client's own timeout.
  const throttleStrategy =
    gatekeeper.maxLiveSessions !== undefined
      ? new WaitAsTold()
      : new WaitIfShortEnough(readThrottleMaxWaitMs());
  const model =
    process.env.LLM_AGENT_MODEL ||
    process.env.SAP_CORE_AI_MODEL ||
    'gpt-4o-mini';
  const temperature = Number.parseFloat(
    process.env.LLM_AGENT_TEMPERATURE ||
      process.env.SAP_CORE_AI_TEMPERATURE ||
      '0.7',
  );
  const maxTokens = Number.parseInt(
    process.env.LLM_AGENT_MAX_TOKENS ||
      process.env.SAP_CORE_AI_MAX_TOKENS ||
      '2000',
    10,
  );
  const resourceGroup = process.env.LLM_AGENT_RESOURCE_GROUP;
  const apiKey = process.env.LLM_AGENT_API_KEY || '';
  const baseUrl = process.env.LLM_AGENT_BASE_URL || '';

  const rag = parseRagConfig(process.env, {
    provider,
    apiKey: apiKey || undefined,
    baseUrl: baseUrl || undefined,
    resourceGroup,
  });
  const destinations = parseDestinationConfig(process.env);

  // MCP Configuration (optional — empty = LLM-only mode without MCP tools)
  const mcpDestination = process.env.LLM_AGENT_MCP_DESTINATION || '';

  const mcpEndpoint =
    process.env.LLM_AGENT_MCP_ENDPOINT || process.env.MCP_ENDPOINT;

  // SmartAgent settings
  const mode = (process.env.LLM_AGENT_MODE || 'smart') as SmartAgentMode;
  const maxIterations = Number.parseInt(
    process.env.LLM_AGENT_MAX_ITERATIONS || '10',
    10,
  );
  const ragType = (process.env.LLM_AGENT_RAG_TYPE || 'in-memory') as RagType;

  // History recency window (max recent messages from client history)
  const historyRecencyWindowRaw = process.env.LLM_AGENT_HISTORY_RECENCY_WINDOW;
  const historyRecencyWindow = historyRecencyWindowRaw
    ? Number.parseInt(historyRecencyWindowRaw, 10)
    : undefined;

  // RAG query K — number of tools selected per query
  const ragQueryK = Number.parseInt(
    process.env.LLM_AGENT_RAG_QUERY_K || '5',
    10,
  );

  const config: AgentConfig = {
    llm: {
      provider,
      model,
      classifierModel: process.env.LLM_AGENT_CLASSIFIER_MODEL || model,
      temperature,
      maxTokens,
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || undefined,
      resourceGroup,
      whenThrottled: throttleStrategy,
    },
    mcp: {
      destination: mcpDestination,
      endpoint: mcpEndpoint,
      systemDestinations: parseDestinationMapping(process.env),
    },
    agent: {
      mode,
      maxIterations,
      ragType,
      historyRecencyWindow,
      ragQueryK,
      skillRagK: parseSkillRagK(process.env),
      allowLlmOnlyFallback:
        process.env.LLM_AGENT_ALLOW_LLM_ONLY_FALLBACK === 'true',
    },
    rag,
    destinations,
  };

  log.info('Agent configuration loaded', {
    provider: config.llm.provider,
    // Logged because it is the setting nobody can otherwise confirm arrived:
    // it only shows itself under load, as the difference between an answer and
    // a dropped connection.
    throttleStrategy: config.llm.whenThrottled.name,
    // Meaningless once the door is on, and said so rather than printed as if it applied.
    throttleMaxWaitMs:
      gatekeeper.maxLiveSessions !== undefined
        ? 'not applied (door on)'
        : readThrottleMaxWaitMs(),
    model: config.llm.model,
    mcpDestination: config.mcp.destination,
    mcpEndpoint: config.mcp.endpoint || 'auto-detect',
    agentMode: config.agent.mode,
    maxIterations: config.agent.maxIterations,
    ragType: config.agent.ragType,
    historyRecencyWindow: config.agent.historyRecencyWindow ?? 'unlimited',
    gatekeeper: describeGatekeeperConfig(gatekeeper),
    ragBackends: config.rag.backends,
    embedder: config.rag.embedder?.kind,
    destinationSource: config.destinations.source,
  });

  return config;
}

/**
 * Get agent configuration (singleton)
 * Configuration is loaded once and cached
 */
let cachedConfig: AgentConfig | null = null;

/** The longest single wait we will hold a caller for. */
export const DEFAULT_THROTTLE_MAX_WAIT_MS = DEFAULT_MAX_THROTTLE_WAIT_MS;

/**
 * Read the wait budget from the environment.
 *
 * `Number(v) || default` was wrong in three directions at once: a negative
 * number and `Infinity` both passed straight through to the library, a
 * fractional value was never rounded, and an explicit `0` — the one value an
 * operator writes deliberately, meaning do not wait at all — was indistinguish-
 * able from nonsense and silently became the default.
 *
 * Zero is honoured. Anything that is not a whole, finite, non-negative number
 * of milliseconds is refused loudly rather than half-applied, because this
 * setting shows itself only under load.
 */
function readThrottleMaxWaitMs(): number {
  const raw = process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_THROTTLE_MAX_WAIT_MS;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      `Invalid LLM_AGENT_THROTTLE_MAX_WAIT_MS: expected a whole number of milliseconds, 0 or more, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export function getAgentConfig(): AgentConfig {
  if (!cachedConfig) {
    cachedConfig = loadAgentConfig();
  }
  return cachedConfig;
}

/**
 * Clear cached configuration (useful for testing)
 */
export function clearAgentConfig(): void {
  cachedConfig = null;
}

/**
 * Check whether SAP AI Core service binding is available.
 *
 * The sap-ai-sdk reads credentials from AICORE_SERVICE_KEY env var
 * or from 'aicore' / 'ai-core' entries in VCAP_SERVICES.
 * When AI Core resource is set to `active: false` in mta.yaml (no binding),
 * none of these will be present and agent endpoints cannot function.
 */
export function isAiCoreConfigured(): boolean {
  if (process.env.AICORE_SERVICE_KEY) return true;

  const vcap = process.env.VCAP_SERVICES;
  if (!vcap) return false;

  try {
    const services = JSON.parse(vcap);
    return !!(services.aicore?.[0] || services['ai-core']?.[0]);
  } catch {
    return false;
  }
}

/**
 * Ensure AI Core credentials are available.
 * Priority: VCAP_SERVICES > AICORE_SERVICE_KEY > individual AICORE_* env vars
 */
export function ensureAiCoreCredentials(): void {
  if (isAiCoreConfigured()) return;

  const authUrl = process.env.AICORE_AUTH_URL;
  const clientId = process.env.AICORE_CLIENT_ID;
  const clientSecret = process.env.AICORE_CLIENT_SECRET;
  const baseUrl = process.env.AICORE_BASE_URL;

  if (authUrl && clientId && clientSecret && baseUrl) {
    process.env.AICORE_SERVICE_KEY = JSON.stringify({
      clientid: clientId,
      clientsecret: clientSecret,
      url: authUrl,
      serviceurls: { AI_API_URL: baseUrl },
    });
    cds.log('agent-config').info('AI Core credentials assembled from env vars');
  }
}
