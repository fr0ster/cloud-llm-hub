/**
 * AI Core Models — fetches and caches the list of deployed LLM models.
 *
 * Uses SAP AI Core REST API to list RUNNING deployments, filters to LLM-only
 * models (excludes embedding models and orchestration configs), and returns
 * them in OpenAI /v1/models format.
 *
 * Authentication: reads aicore binding from VCAP_SERVICES via @sap/xsenv.
 */

import cds from '@sap/cds';

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
 * Extract AI Core credentials from VCAP_SERVICES.
 */
function getAiCoreCredentials(): {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
} {
  const vcap = process.env.VCAP_SERVICES;
  if (!vcap) {
    throw new Error('VCAP_SERVICES not available');
  }

  const services = JSON.parse(vcap);
  const aicore = services.aicore?.[0] || services['ai-core']?.[0];
  if (!aicore?.credentials) {
    throw new Error('aicore service binding not found in VCAP_SERVICES');
  }

  const creds = aicore.credentials;
  return {
    tokenUrl: `${creds.url}/oauth/token`,
    clientId: creds.clientid,
    clientSecret: creds.clientsecret,
    apiUrl: creds.serviceurls?.AI_API_URL || creds.url,
  };
}

/**
 * Get OAuth2 client_credentials token from AI Core.
 */
async function getToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Fetch RUNNING deployments from AI Core and filter to LLM models.
 */
async function fetchModels(): Promise<AiCoreModelEntry[]> {
  const log = cds.log('ai-core-models');
  const creds = getAiCoreCredentials();
  const token = await getToken(
    creds.tokenUrl,
    creds.clientId,
    creds.clientSecret,
  );

  const resourceGroup = process.env.LLM_AGENT_RESOURCE_GROUP || 'default';
  const response = await fetch(
    `${creds.apiUrl}/v2/lm/deployments?status=RUNNING`,
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
 * Get available LLM models (cached with 5min TTL).
 */
export async function getAvailableModels(): Promise<AiCoreModelEntry[]> {
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  cachedModels = await fetchModels();
  cacheTimestamp = Date.now();
  return cachedModels;
}
