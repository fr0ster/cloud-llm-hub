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

export interface AgentConfig {
  /**
   * LLM Configuration
   */
  llm: {
    /** LLM provider: 'sap-ai-sdk' (default), 'openai', 'anthropic', 'deepseek' */
    provider: LlmProvider;

    /** Model name (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet') */
    model: string;

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
  };
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
    },
    agent: {
      mode,
      maxIterations,
      ragType,
      historyRecencyWindow,
      ragQueryK,
    },
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
