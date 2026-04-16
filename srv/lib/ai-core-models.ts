/**
 * AI Core Models — fetches and caches the list of deployed LLM models.
 *
 * Uses SAP AI Core REST API to list RUNNING deployments, filters to LLM-only
 * models (excludes embedding models and orchestration configs), and returns
 * them in OpenAI /v1/models format.
 */

import cds from '@sap/cds';
import { getServiceCredentials, getToken } from './btp-oauth';

interface AiCoreModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

interface DeploymentResource {
  id: string;
  configurationName: string;
  status: string;
  details?: {
    resources?: {
      backend_details?: {
        model?: { name: string; version: string };
      };
    };
  };
}

/** Embedding and non-LLM model prefixes to exclude */
const EXCLUDED_PREFIXES = [
  'text-embedding-',
  'ada-',
  'gemini-embedding',
  'sap-rpt-',
];

/** Skip deployments with generic orchestration config names */
const EXCLUDED_CONFIG_PREFIXES = ['defaultOrchestrationConfig'];

let cachedModels: AiCoreModelEntry[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch RUNNING deployments from AI Core and filter to LLM models.
 */
async function fetchModels(): Promise<AiCoreModelEntry[]> {
  const log = cds.log('ai-core-models');
  const creds = getServiceCredentials('aicore', 'ai-core');
  const token = await getToken(creds);

  const resourceGroup = process.env.LLM_AGENT_RESOURCE_GROUP || 'default';
  const response = await fetch(
    `${creds.uri}/v2/lm/deployments?status=RUNNING`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'AI-Resource-Group': resourceGroup,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`AI Core deployments API failed: ${response.status}`);
  }

  const data = (await response.json()) as { resources: DeploymentResource[] };
  const seen = new Set<string>();
  const models: AiCoreModelEntry[] = [];

  for (const d of data.resources) {
    const modelName = d.details?.resources?.backend_details?.model?.name;
    if (!modelName) continue;

    // Skip excluded config names
    if (EXCLUDED_CONFIG_PREFIXES.some((p) => d.configurationName.startsWith(p)))
      continue;

    // Skip embedding and non-LLM models
    if (EXCLUDED_PREFIXES.some((p) => modelName.startsWith(p))) continue;

    // Deduplicate by model name
    if (seen.has(modelName)) continue;
    seen.add(modelName);

    models.push({
      id: modelName,
      object: 'model',
      created: 0,
      owned_by: 'sap-ai-core',
    });
  }

  // Sort alphabetically
  models.sort((a, b) => a.id.localeCompare(b.id));

  log.info('Fetched AI Core models', {
    total: data.resources.length,
    llmModels: models.length,
    models: models.map((m) => m.id),
  });

  return models;
}

/**
 * Fetch models from OpenAI-compatible API (openai, anthropic, deepseek providers).
 * Uses LLM_AGENT_BASE_URL + LLM_AGENT_API_KEY to call GET /models.
 */
async function fetchOpenAiModels(): Promise<AiCoreModelEntry[]> {
  const log = cds.log('ai-core-models');
  const apiKey = process.env.LLM_AGENT_API_KEY;
  const baseUrl = process.env.LLM_AGENT_BASE_URL || 'https://api.openai.com/v1';
  const provider = process.env.LLM_AGENT_PROVIDER || 'openai';

  if (!apiKey) {
    log.warn('No LLM_AGENT_API_KEY — returning active model only');
    const model = process.env.LLM_AGENT_MODEL;
    return model
      ? [{ id: model, object: 'model', created: 0, owned_by: provider }]
      : [];
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      throw new Error(`Models API failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      data: Array<{ id: string; created?: number; owned_by?: string }>;
    };

    const models = data.data
      .map((m) => ({
        id: m.id,
        object: 'model' as const,
        created: m.created || 0,
        owned_by: m.owned_by || provider,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    log.info('Fetched provider models', {
      provider,
      total: data.data.length,
      llmModels: models.length,
    });

    return models;
  } catch (err) {
    log.warn('Failed to fetch provider models, returning active model only', {
      error: err instanceof Error ? err.message : String(err),
    });
    const model = process.env.LLM_AGENT_MODEL;
    return model
      ? [{ id: model, object: 'model', created: 0, owned_by: provider }]
      : [];
  }
}

/**
 * Get available LLM models (cached with 5min TTL).
 */
export async function getAvailableModels(): Promise<AiCoreModelEntry[]> {
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  const provider = process.env.LLM_AGENT_PROVIDER || 'sap-ai-sdk';
  cachedModels =
    provider === 'sap-ai-sdk' ? await fetchModels() : await fetchOpenAiModels();
  cacheTimestamp = Date.now();
  return cachedModels;
}
