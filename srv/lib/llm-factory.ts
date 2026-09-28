/**
 * LLM construction — the hub's composition root for concrete LLM providers.
 *
 * llm-agent 27 removed `makeLlm`: the library no longer builds providers, and
 * no provider reads a secret from the environment. The hub owns both now, so
 * this module constructs the provider named by `LLM_AGENT_PROVIDER` with a
 * credential it built, and wraps it into the `ILlm` the SmartAgent consumes —
 * the same wrapping `makeLlm` applied.
 *
 * Credentials are memoized per process: a credential object's identity keys the
 * provider's 429 quota bucket, so every LLM on one account must share one.
 */

import { AnthropicProvider } from '@mcp-abap-adt/anthropic-llm';
import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import {
  type ILlm,
  type IThrottleStrategy,
  staticApiKey,
} from '@mcp-abap-adt/llm-agent';
import { LlmAdapter, LlmProviderBridge } from '@mcp-abap-adt/llm-agent-libs';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';
import { SapCoreAIProvider } from '@mcp-abap-adt/sap-aicore-llm';
import cds from '@sap/cds';
import type { LlmProvider } from '../agent-config';

export interface HubLlmConfig {
  provider: LlmProvider;
  /** API key for openai / anthropic / deepseek. Unused for sap-ai-sdk. */
  apiKey?: string;
  /** Base URL for OpenAI-compatible endpoints (Azure OpenAI, Ollama, vLLM). */
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  /** SAP AI Core resource group (sap-ai-sdk only). */
  resourceGroup?: string;
  whenThrottled?: IThrottleStrategy;
}

type AiCoreAccess = ReturnType<typeof serviceKeyCredential>;
// Typed through llm-agent's own factory: the providers take the interfaces-auth
// release llm-agent depends on, which is not the one lib depends on.
type IApiKeyCredential = ReturnType<typeof staticApiKey>;

let aiCoreAccess: AiCoreAccess | undefined;
const apiKeyCredentials = new Map<string, IApiKeyCredential>();

/**
 * The AI Core service key, as the SAP AI SDK itself used to find it: the
 * `aicore` / `ai-core` binding in VCAP_SERVICES first, then AICORE_SERVICE_KEY
 * (set directly, or assembled from AICORE_* by `ensureAiCoreCredentials`).
 */
export function readAiCoreServiceKey(): string {
  const vcap = process.env.VCAP_SERVICES;
  if (vcap) {
    const services = JSON.parse(vcap) as Record<
      string,
      Array<{ credentials?: unknown }> | undefined
    >;
    const binding = services.aicore?.[0] ?? services['ai-core']?.[0];
    if (binding?.credentials) return JSON.stringify(binding.credentials);
  }
  const serviceKey = process.env.AICORE_SERVICE_KEY;
  if (serviceKey) return serviceKey;
  throw new Error(
    'SAP AI Core credentials not found: bind an "aicore" service or set AICORE_SERVICE_KEY (or AICORE_AUTH_URL, AICORE_CLIENT_ID, AICORE_CLIENT_SECRET, AICORE_BASE_URL).',
  );
}

/**
 * One credential and base URL for SAP AI Core, shared by every LLM in the
 * process. Lazy: the service key is read on the first token or address asked
 * for, not here — a deployment without AI Core (the binding is optional) must
 * still start, and fail only the call that needs a model, as before llm-agent 27.
 */
export function getAiCoreAccess(): AiCoreAccess {
  if (!aiCoreAccess) {
    let loaded: AiCoreAccess | undefined;
    const load = () => {
      loaded ??= serviceKeyCredential(readAiCoreServiceKey());
      return loaded;
    };
    aiCoreAccess = {
      credential: {
        kind: 'bearer',
        token: async () => load().credential.token(),
      },
      get apiBaseUrl() {
        return load().apiBaseUrl;
      },
    };
  }
  return aiCoreAccess;
}

/** One credential per key, shared by every LLM and embedder on that account. */
export function apiKeyCredential(key: string): IApiKeyCredential {
  let credential = apiKeyCredentials.get(key);
  if (!credential) {
    credential = staticApiKey(key);
    apiKeyCredentials.set(key, credential);
  }
  return credential;
}

/** Test hook: forget memoized credentials. */
export function resetLlmCredentials(): void {
  aiCoreAccess = undefined;
  apiKeyCredentials.clear();
}

/** Build the provider for `cfg` and wrap it as an `ILlm`. */
export async function makeHubLlm(
  cfg: HubLlmConfig,
  temperature: number,
): Promise<ILlm> {
  const maxTokens = cfg.maxTokens != null ? Number(cfg.maxTokens) : undefined;
  const common = {
    model: cfg.model,
    temperature,
    maxTokens,
    whenThrottled: cfg.whenThrottled,
  };

  let provider:
    | SapCoreAIProvider
    | OpenAIProvider
    | AnthropicProvider
    | DeepSeekProvider;
  switch (cfg.provider) {
    case 'sap-ai-sdk': {
      const access = getAiCoreAccess();
      const log = cds.log('sap-ai-sdk');
      provider = new SapCoreAIProvider({
        ...common,
        credential: access.credential,
        // A getter, so the service key is still unread at construction.
        get apiBaseUrl() {
          return access.apiBaseUrl;
        },
        resourceGroup: cfg.resourceGroup,
        log: {
          debug: (msg, meta) => log.debug(msg, meta ?? ''),
          error: (msg, meta) => log.error(msg, meta ?? ''),
        },
      });
      break;
    }
    case 'openai':
      provider = new OpenAIProvider({
        ...common,
        baseURL: cfg.baseURL,
        credential: apiKeyCredential(cfg.apiKey ?? ''),
      });
      break;
    case 'anthropic':
      provider = new AnthropicProvider({
        ...common,
        baseURL: cfg.baseURL,
        credential: apiKeyCredential(cfg.apiKey ?? ''),
      });
      break;
    case 'deepseek':
      provider = new DeepSeekProvider({
        ...common,
        baseURL: cfg.baseURL,
        credential: apiKeyCredential(cfg.apiKey ?? ''),
      });
      break;
    default: {
      const exhaustive: never = cfg.provider;
      throw new Error(`Unknown LLM provider: ${exhaustive}`);
    }
  }

  return new LlmAdapter(new LlmProviderBridge(provider), {
    model: provider.model,
    getModels: () => provider.getModels?.() ?? Promise.resolve([]),
    getEmbeddingModels: () =>
      provider.getEmbeddingModels?.() ?? Promise.resolve([]),
  });
}
