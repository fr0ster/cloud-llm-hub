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
 * provider's default quota bucket. Session calls override it with quotaScope.
 */

import { createHash } from 'node:crypto';
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
import { captureLlm } from './context-capture';
import { reliableLlm } from './llm-failure';
import { sessionLlms } from './session-llms';
import { usageRuntime } from './usage/runtime';

export interface HubLlmConfig {
  provider: LlmProvider;
  component?: 'chat' | 'other' | 'planner-author' | 'classifier' | 'analyst';
  contextCapture?: 'off' | 'stats' | 'full';
  /** API key for openai / anthropic / deepseek. Unused for sap-ai-sdk. */
  apiKey?: string;
  /** Base URL for OpenAI-compatible endpoints (Azure OpenAI, Ollama, vLLM). */
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  /** SAP AI Core resource group (sap-ai-sdk only). */
  resourceGroup?: string;
  whenThrottled?: IThrottleStrategy;
  quotaScope?: string;
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
  const identity = createHash('sha256').update(key).digest('hex');
  let credential = apiKeyCredentials.get(identity);
  if (!credential) {
    credential = staticApiKey(key);
    apiKeyCredentials.set(identity, credential);
  }
  return credential;
}

/** Test hook: forget memoized credentials. */
export function resetLlmCredentials(): void {
  aiCoreAccess = undefined;
  apiKeyCredentials.clear();
}

const credentialIds = new WeakMap<object, number>();
let nextCredentialId = 0;

/** Cache identity contains configuration and an opaque credential identity only. */
export function hubLlmKey(cfg: HubLlmConfig, temperature: number): string {
  const credential =
    cfg.provider === 'sap-ai-sdk'
      ? getAiCoreAccess().credential
      : apiKeyCredential(cfg.apiKey ?? '');
  let credentialId = credentialIds.get(credential);
  if (credentialId === undefined) {
    credentialId = ++nextCredentialId;
    credentialIds.set(credential, credentialId);
  }
  return JSON.stringify({
    provider: cfg.provider,
    model: cfg.model,
    baseURL: cfg.baseURL,
    resourceGroup: cfg.resourceGroup,
    temperature,
    maxTokens: cfg.maxTokens,
    component: cfg.component,
    quotaScope: cfg.quotaScope,
    credentialId,
  });
}

/** Build the provider for `cfg` and wrap it as an `ILlm`. */
export async function makeHubLlm(
  cfg: HubLlmConfig,
  temperature: number,
): Promise<ILlm> {
  const llm = await createHubLlm(cfg, temperature);
  const key = hubLlmKey(cfg, temperature);
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'chat')
        return async (...args: Parameters<ILlm['chat']>) => {
          const owner = sessionLlms.getStore();
          const client = owner
            ? await owner.get(key, (quotaScope) =>
                createHubLlm({ ...cfg, quotaScope }, temperature),
              )
            : target;
          return client.chat(...args);
        };
      if (property === 'streamChat')
        return async function* (...args: Parameters<ILlm['streamChat']>) {
          const owner = sessionLlms.getStore();
          const client = owner
            ? await owner.get(key, (quotaScope) =>
                createHubLlm({ ...cfg, quotaScope }, temperature),
              )
            : target;
          yield* client.streamChat(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function createHubLlm(
  cfg: HubLlmConfig,
  temperature: number,
): Promise<ILlm> {
  const maxTokens = cfg.maxTokens != null ? Number(cfg.maxTokens) : undefined;
  const usage = usageRuntime()?.recorder;
  const common = {
    ...(usage ? { usage } : {}),
    model: cfg.model,
    temperature,
    maxTokens,
    whenThrottled: cfg.whenThrottled,
    quotaScope: cfg.quotaScope,
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

  const llm = reliableLlm(
    captureLlm(
      new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
      }),
      cfg.component,
      cfg.contextCapture,
      { temperature, maxTokens },
    ),
  );
  if (cfg.component !== 'planner-author') return llm;
  // SmartAgent supplies its tool-loop component in CallOptions. Attribute at
  // the LLM boundary, after the pipeline has selected that recorder.
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'chat')
        return (...[messages, tools, options]: Parameters<ILlm['chat']>) =>
          target.chat(messages, tools, {
            ...options,
            usage: (options?.usage ?? usage)?.with({
              component: 'planner-author',
            }),
          });
      if (property === 'streamChat')
        return (
          ...[messages, tools, options]: Parameters<ILlm['streamChat']>
        ) =>
          target.streamChat(messages, tools, {
            ...options,
            usage: (options?.usage ?? usage)?.with({
              component: 'planner-author',
            }),
          });
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
