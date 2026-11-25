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
import {
  type AnthropicConfig,
  AnthropicProvider,
} from '@mcp-abap-adt/anthropic-llm';
import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import {
  findThrottled,
  type ILlm,
  type IThrottleStrategy,
  type IUsageRecorder,
  type LLMProvider,
  type LLMResponse,
  ReportThrottling,
  runWithThrottleRetry,
  staticApiKey,
} from '@mcp-abap-adt/llm-agent';
import { LlmAdapter, LlmProviderBridge } from '@mcp-abap-adt/llm-agent-libs';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';
import {
  type SapAiCoreFoundationConfig,
  SapAiCoreFoundationProvider,
  type SapCoreAIConfig,
  SapCoreAIProvider,
} from '@mcp-abap-adt/sap-aicore-llm';
import cds from '@sap/cds';
import {
  aiCoreServiceKeyFromEnv,
  getAgentConfig,
  type LlmProvider,
} from '../agent-config';
import { BuildValidationError } from './build-validation-error';
import { captureLlm } from './context-capture';
import { deployModel } from './deploy-model';
import {
  configuredPromptCaching,
  type PromptCachingRole,
} from './deploy-role-config';
import {
  anthropicStreamCode,
  mergeStreamUsage,
  reliableLlm,
  reportLlmSpend,
  reportUsageFreeLlmAttempt,
  StreamContentError,
} from './llm-failure';
import { foundationMaxTokens } from './model-capabilities';
import { sessionLlms } from './session-llms';
import { usageRuntime } from './usage/runtime';

/** Route Anthropic SSE quota errors through the provider's existing retry policy. */
export class HubAnthropicProvider extends AnthropicProvider {
  /** Keep one throttle attempt counter across the complete SSE consumption. */
  override async *streamChat(
    ...args: Parameters<AnthropicProvider['streamChat']>
  ): AsyncIterable<LLMResponse> {
    const [messages, tools, options] = args;
    // A call-local provider reports HTTP throttling without retrying it. The
    // outer loop owns the single HTTP/SSE budget; public config keeps concurrent
    // calls isolated and preserves the provider's separate transient policy.
    const provider = new AnthropicProvider({
      ...this.config,
      whenThrottled: {
        name: 'stream-open',
        // Let the outer policy alone choose and record the quota wait.
        decide: () => ({ retry: false, waitMs: 0 }),
      },
    });
    const controller = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let item: LLMResponse | undefined;
    let done = false;
    let failed = false;
    let failure: Error | undefined;
    let wake = () => {};
    let consumed = () => {};
    let contentStarted = false;
    // Reuse the provider quota and strategy for SSE quota failures. Holding
    // metadata also lets the outer transient policy retry before content starts.
    const work = runWithThrottleRetry(
      async () => {
        const held: LLMResponse[] = [];
        let sawUsage = false;
        // The provider records each attempt that reached the transport, even
        // when the stream fails before emitting any usage to the caller.
        const observeRequests = (
          recorder?: IUsageRecorder,
        ): IUsageRecorder => ({
          record: (record) => {
            if (record.kind === 'llm.call' && !sawUsage)
              reportUsageFreeLlmAttempt(record.model, record.outcome === 'ok');
            recorder?.record(record);
          },
          with: (context) => observeRequests(recorder?.with(context)),
        });
        contentStarted = false;
        const publish = async (response: LLMResponse) => {
          if (signal.aborted) return;
          const acknowledged = new Promise<void>((resolve) => {
            consumed = resolve;
          });
          item = response;
          wake();
          await acknowledged;
        };
        try {
          for await (const response of provider.streamChat(messages, tools, {
            ...options,
            signal,
            usage: observeRequests(options?.usage ?? this.config.usage),
          })) {
            if (signal.aborted) return;
            if (response.usage) sawUsage = true;
            if (!contentStarted) {
              held.push(response);
              if (
                !response.content &&
                !response.toolCalls?.length &&
                !response.finishReason
              )
                continue;
              contentStarted = true;
              for (const chunk of held) await publish(chunk);
              held.length = 0;
            } else await publish(response);
          }
          for (const chunk of held) await publish(chunk);
        } catch (error) {
          if (!contentStarted) {
            let spent: LLMResponse['usage'];
            for (const chunk of held) {
              if (chunk.usage) spent = mergeStreamUsage(spent, chunk.usage);
            }
            if (spent) reportLlmSpend(spent, options?.model ?? this.model);
          }
          throw error;
        }
      },
      {
        key: this.quotaKey(options?.model),
        strategy: {
          name: this.config.whenThrottled?.name ?? 'stream',
          decide: (context) =>
            contentStarted
              ? { retry: false, waitMs: 0, reason: 'content-started' }
              : this.config.whenThrottled
                ? this.config.whenThrottled.decide(context)
                : new ReportThrottling().decide(context),
        },
        isThrottled: (error) =>
          !!findThrottled(error) ||
          anthropicStreamCode(error) === 'rate_limit_error',
        retryAfterSeconds: (error) => this.retryAfterSeconds(error),
        signal,
      },
    )
      .catch((error: Error) => {
        failed = true;
        failure =
          contentStarted && !findThrottled(error)
            ? new StreamContentError(error)
            : error;
      })
      .finally(() => {
        done = true;
        wake();
      });
    try {
      while (true) {
        const available = new Promise<void>((resolve) => {
          wake = resolve;
        });
        if (item === undefined && !done) await available;
        if (item !== undefined) {
          const response = item;
          item = undefined;
          yield response;
          consumed();
        } else if (done) {
          if (failed) throw failure;
          return;
        }
      }
    } finally {
      controller.abort();
      consumed();
      await work;
    }
  }
}

export interface HubLlmConfig {
  provider: LlmProvider;
  role?: PromptCachingRole;
  component?:
    | 'chat'
    | 'other'
    | 'planner-author'
    | 'classifier'
    | 'analyst'
    | 'tool-retriever';
  contextCapture?: 'off' | 'stats' | 'full';
  /** API key for openai / anthropic / deepseek. */
  apiKey?: string;
  /** Base URL for OpenAI-compatible endpoints (Azure OpenAI, Ollama, vLLM). */
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  /** SAP AI Core resource group. */
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
 * or the individual AICORE_* variables.
 */
export function readAiCoreServiceKey(): string {
  const vcap = process.env.VCAP_SERVICES;
  if (vcap) {
    const services = JSON.parse(vcap) as Record<
      string,
      Array<{ credentials?: object }> | undefined
    >;
    const binding = services.aicore?.[0] ?? services['ai-core']?.[0];
    if (binding?.credentials) return JSON.stringify(binding.credentials);
  }
  const serviceKey =
    process.env.AICORE_SERVICE_KEY || aiCoreServiceKeyFromEnv(process.env);
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

/** The only SapCoreAIProvider construction: process credential, logger and usage recorder. */
function aiCoreProvider(
  options: Omit<SapCoreAIConfig, 'credential' | 'apiBaseUrl' | 'log' | 'usage'>,
): SapCoreAIProvider {
  const access = getAiCoreAccess();
  const log = cds.log('sap-ai-sdk');
  const usage = usageRuntime()?.recorder;
  return new SapCoreAIProvider({
    ...options,
    ...(usage ? { usage } : {}),
    credential: access.credential,
    // A getter, so the service key is still unread at construction.
    get apiBaseUrl() {
      return access.apiBaseUrl;
    },
    log: {
      debug: (msg, meta) => log.debug(msg, meta ?? ''),
      error: (msg, meta) => log.error(msg, meta ?? ''),
    },
  });
}

/** Build a catalog provider with the same process credential as chat providers. */
export function makeHubCatalogProvider(): SapCoreAIProvider {
  return aiCoreProvider({
    model: deployModel(),
    promptCaching: configuredPromptCaching(),
    resourceGroup: process.env.LLM_AGENT_RESOURCE_GROUP,
  });
}

export function makeHubFoundationProvider(
  options: Omit<SapAiCoreFoundationConfig, 'credential' | 'apiBaseUrl'>,
): SapAiCoreFoundationProvider {
  const access = getAiCoreAccess();
  return new SapAiCoreFoundationProvider({
    ...options,
    resourceGroup: options.resourceGroup?.trim() || undefined,
    credential: access.credential,
    get apiBaseUrl() {
      return access.apiBaseUrl;
    },
  });
}

/** The Anthropic construction shared by chat and catalog discovery. */
function anthropicProvider(
  cfg: Pick<HubLlmConfig, 'apiKey' | 'baseURL'>,
  options: Omit<AnthropicConfig, 'credential' | 'baseURL'>,
): HubAnthropicProvider {
  return new HubAnthropicProvider({
    ...options,
    baseURL: cfg.baseURL,
    credential: apiKeyCredential(cfg.apiKey ?? ''),
  });
}

/** Discover models with the same configuration and credential as Anthropic chat. */
export function makeHubAnthropicCatalogProvider(): AnthropicProvider {
  const { llm } = getAgentConfig();
  return anthropicProvider(
    { apiKey: llm.apiKey, baseURL: llm.baseUrl },
    { model: llm.model, promptCaching: configuredPromptCaching() },
  );
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
export function hubLlmKey(
  cfg: HubLlmConfig,
  temperature: number | undefined,
): string {
  const credential =
    cfg.provider === 'sap-ai-sdk' || cfg.provider === 'sap-aicore-foundation'
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
    promptCaching: configuredPromptCaching(cfg.role),
    maxTokens: cfg.maxTokens,
    component: cfg.component,
    quotaScope: cfg.quotaScope,
    credentialId,
  });
}

/** Build the provider for `cfg` and wrap it as an `ILlm`. */
export async function makeHubLlm(
  cfg: HubLlmConfig,
  temperature: number | undefined,
): Promise<ILlm> {
  const promptCaching = configuredPromptCaching(cfg.role);
  const key = hubLlmKey(cfg, temperature);
  const llm = await createHubLlm(cfg, temperature, promptCaching);
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'chat')
        return async (...args: Parameters<ILlm['chat']>) => {
          const owner = sessionLlms.getStore();
          const client = owner
            ? await owner.get(key, (quotaScope) =>
                createHubLlm(
                  { ...cfg, quotaScope },
                  temperature,
                  promptCaching,
                ),
              )
            : target;
          return client.chat(...args);
        };
      if (property === 'streamChat')
        return async function* (...args: Parameters<ILlm['streamChat']>) {
          const owner = sessionLlms.getStore();
          const client = owner
            ? await owner.get(key, (quotaScope) =>
                createHubLlm(
                  { ...cfg, quotaScope },
                  temperature,
                  promptCaching,
                ),
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
  temperature: number | undefined,
  promptCaching: boolean,
): Promise<ILlm> {
  const modelMaximum =
    cfg.provider === 'sap-aicore-foundation' && cfg.model
      ? foundationMaxTokens(cfg.model)
      : undefined;
  const maxTokens =
    modelMaximum ?? (cfg.maxTokens != null ? Number(cfg.maxTokens) : undefined);
  const usage = usageRuntime()?.recorder;
  const common = {
    ...(usage ? { usage } : {}),
    model: cfg.model,
    promptCaching,
    ...(temperature === undefined ? {} : { temperature }),
    maxTokens,
    whenThrottled: cfg.whenThrottled,
    quotaScope: cfg.quotaScope,
  };

  let provider: LLMProvider & { readonly model: string };
  switch (cfg.provider) {
    case 'sap-ai-sdk':
      provider = aiCoreProvider({
        ...common,
        resourceGroup: cfg.resourceGroup,
      });
      break;
    case 'sap-aicore-foundation':
      if (!cfg.model)
        throw new BuildValidationError(
          'A deployed model is required for LLM_AGENT_PROVIDER=sap-aicore-foundation.',
        );
      provider = makeHubFoundationProvider({
        ...common,
        resourceGroup: cfg.resourceGroup,
      });
      break;
    case 'openai':
      provider = new OpenAIProvider({
        ...common,
        baseURL: cfg.baseURL,
        credential: apiKeyCredential(cfg.apiKey ?? ''),
      });
      break;
    case 'anthropic':
      provider = anthropicProvider(cfg, common);
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
  const component = cfg.component;
  if (component !== 'planner-author' && component !== 'tool-retriever')
    return llm;
  const attribution =
    component === 'tool-retriever'
      ? { component, role: component }
      : { component };
  // SmartAgent supplies its tool-loop component in CallOptions. Attribute at
  // the LLM boundary, after the pipeline has selected that recorder.
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'chat')
        return (...[messages, tools, options]: Parameters<ILlm['chat']>) =>
          target.chat(messages, tools, {
            ...options,
            usage: (options?.usage ?? usage)?.with(attribution),
          });
      if (property === 'streamChat')
        return (
          ...[messages, tools, options]: Parameters<ILlm['streamChat']>
        ) =>
          target.streamChat(messages, tools, {
            ...options,
            usage: (options?.usage ?? usage)?.with(attribution),
          });
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
