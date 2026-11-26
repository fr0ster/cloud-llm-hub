import { isOrchestrationChatModel } from '@mcp-abap-adt/sap-aicore-llm';
import cds from '@sap/cds';
import { getFoundationModels } from './ai-core-models';
import { BuildValidationError } from './build-validation-error';
import { deployModel } from './deploy-model';
import {
  makeHubAnthropicCatalogProvider,
  makeHubCatalogProvider,
} from './llm-factory';
import { llmFailure } from './llm-failure';
import {
  parseModelAllowlist,
  setModelCatalogSnapshot,
  usesModelCatalog,
} from './model-policy';

let loaded = false;
let inFlight: Promise<void> | undefined;
let failureLogged = false;

export function validateModelCatalogProvider(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const provider = env.LLM_AGENT_PROVIDER || 'sap-ai-sdk';
  if (
    usesModelCatalog(env) &&
    provider !== 'sap-ai-sdk' &&
    provider !== 'sap-aicore-foundation' &&
    provider !== 'anthropic'
  )
    throw new BuildValidationError(
      'Invalid LLM_AGENT_MODELS: catalog requires LLM_AGENT_PROVIDER=sap-ai-sdk, sap-aicore-foundation or anthropic',
    );
}

/** Successful snapshots last for the process lifetime; only failed loads retry. */
export function ensureModelCatalog(): Promise<void> {
  if (!usesModelCatalog() || loaded) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = loadCatalog().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/** Return a load only while catalog mode still needs a snapshot. */
export function awaitModelCatalog(): Promise<void> | undefined {
  return !loaded && usesModelCatalog() ? ensureModelCatalog() : undefined;
}

/** Preserve the synchronous hot path once loaded or outside catalog mode. */
export function withModelCatalog<T>(run: () => Promise<T>): Promise<T> {
  const pending = awaitModelCatalog();
  return pending ? pending.then(run) : run();
}

async function loadCatalog(): Promise<void> {
  try {
    if (process.env.LLM_AGENT_PROVIDER === 'sap-aicore-foundation') {
      const catalog = await getFoundationModels({
        model: deployModel(),
        resourceGroup: process.env.LLM_AGENT_RESOURCE_GROUP,
      });
      setModelCatalogSnapshot(catalog.map(({ id }) => id));
    } else if (process.env.LLM_AGENT_PROVIDER === 'anthropic') {
      const catalog = await makeHubAnthropicCatalogProvider().getModels();
      setModelCatalogSnapshot(
        catalog
          .filter(
            (info) =>
              info.capabilities === undefined ||
              info.capabilities.includes('text-generation'),
          )
          .map((info) => info.id),
      );
    } else {
      const catalog = await makeHubCatalogProvider().getModelCatalog();
      setModelCatalogSnapshot(
        catalog.filter(isOrchestrationChatModel).map((info) => info.id),
      );
    }
    loaded = true;
    const allow = parseModelAllowlist();
    for (const role of ['COORDINATOR', 'PLANNER', 'EXECUTOR', 'CHECKER']) {
      const name = `LLM_AGENT_${role}_MODEL`;
      const model = process.env[name]?.trim();
      if (model && !allow.has(model))
        cds
          .log('model-catalog')
          .error(
            `${name}: model "${model}" is outside LLM_AGENT_MODELS after catalog loading`,
          );
    }
  } catch (cause) {
    if (!failureLogged) {
      failureLogged = true;
      cds
        .log('model-catalog')
        .error(
          'Failed to load LLM_AGENT_MODELS catalog',
          process.env.LLM_AGENT_PROVIDER === 'anthropic'
            ? llmFailure(cause)
            : cause instanceof Error
              ? cause
              : String(cause),
        );
    }
  }
}

/** Test hook for process-level catalog state. */
export function resetModelCatalog(): void {
  loaded = false;
  inFlight = undefined;
  failureLogged = false;
  setModelCatalogSnapshot([]);
}
