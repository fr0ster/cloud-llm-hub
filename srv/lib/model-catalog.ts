import { isOrchestrationChatModel } from '@mcp-abap-adt/sap-aicore-llm';
import cds from '@sap/cds';
import { BuildValidationError } from './build-validation-error';
import { makeHubCatalogProvider } from './llm-factory';
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
  if (
    usesModelCatalog(env) &&
    (env.LLM_AGENT_PROVIDER || 'sap-ai-sdk') !== 'sap-ai-sdk'
  )
    throw new BuildValidationError(
      'Invalid LLM_AGENT_MODELS: catalog requires LLM_AGENT_PROVIDER=sap-ai-sdk',
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
    const catalog = await makeHubCatalogProvider().getModelCatalog();
    setModelCatalogSnapshot(
      catalog.filter(isOrchestrationChatModel).map((info) => info.id),
    );
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
          cause instanceof Error ? cause : String(cause),
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
