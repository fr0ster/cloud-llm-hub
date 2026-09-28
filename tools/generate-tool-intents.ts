/**
 * Generate tool intent cache for VectorRag enrichment.
 *
 * Runs IntentEnricher (via LLM) once for all MCP tools and saves results
 * to srv/tool-intents.json. This file is committed to git and used at
 * startup instead of calling LLM for every tool on each restart.
 *
 * Usage:
 *   npx tsx tools/generate-tool-intents.ts
 *
 * Loads default-env.json for SAP AI Core credentials (same as cds watch).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { HandlerExporter } from '@mcp-abap-adt/lib/handlers';
import { IntentEnricher } from '@mcp-abap-adt/llm-agent';
import { CLOUD_LOCAL_TOOLS } from '../srv/lib/cloud-local-tools';
import { makeHubLlm } from '../srv/lib/llm-factory';

type LlmProvider = 'sap-ai-sdk' | 'openai' | 'anthropic' | 'deepseek';

// Load default-env.json (VCAP_SERVICES) for SAP AI SDK — same as cds watch
const defaultEnvPath = path.resolve(__dirname, '../default-env.json');
if (fs.existsSync(defaultEnvPath)) {
  const defaultEnv = JSON.parse(fs.readFileSync(defaultEnvPath, 'utf-8'));
  if (defaultEnv.VCAP_SERVICES && !process.env.VCAP_SERVICES) {
    process.env.VCAP_SERVICES = JSON.stringify(defaultEnv.VCAP_SERVICES);
  }
}

const MODEL = process.env.LLM_AGENT_CLASSIFIER_MODEL || 'gpt-4.1-mini';
const PROVIDER = (process.env.LLM_AGENT_PROVIDER ||
  'sap-ai-sdk') as LlmProvider;
const OUTPUT = path.resolve(__dirname, '../srv/tool-intents.json');

async function main() {
  console.log(
    `Generating tool intents with model=${MODEL}, provider=${PROVIDER}`,
  );

  // Match the runtime exposition set used by srv/agent-manager.ts so that
  // pre-cached intents cover exactly the tools the agent will see at runtime.
  const exporter = new HandlerExporter({
    includeReadOnly: true,
    includeHighLevel: true,
    includeLowLevel: false,
    includeCompact: true,
    includeSystem: true,
    includeSearch: true,
  });
  const entries = exporter.getHandlerEntries();
  console.log(`Tools: ${entries.length}`);

  // Build tool texts (same format as vectorizeTools)
  const tools = entries.map((e) => {
    const def = e.toolDefinition;
    const paramNames = Object.keys(def.inputSchema ?? {}).join(', ');
    const text = [
      `Tool: ${def.name}`,
      `Description: ${def.description}`,
      paramNames ? `Parameters: ${paramNames}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return { name: def.name as string, text };
  });

  // Merge cloud-local tools (mirrors the shared corpus in agent-manager.ts via
  // mergeCloudLocalTools). Without this, GetDumpSection is invisible here and the
  // purge pass below would delete any GetDumpSection intent as an "unknown" tool.
  // Cloud-local inputSchema is already JSON Schema, so read `.properties` directly.
  for (const cl of CLOUD_LOCAL_TOOLS) {
    if (tools.some((t) => t.name === cl.name)) continue;
    const props =
      (cl.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties ?? {};
    const paramNames = Object.keys(props).join(', ');
    const text = [
      `Tool: ${cl.name}`,
      `Description: ${cl.description}`,
      paramNames ? `Parameters: ${paramNames}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    tools.push({ name: cl.name, text });
  }
  console.log(`Tools (incl. cloud-local): ${tools.length}`);

  // Create LLM for enrichment
  const llm = await makeHubLlm(
    {
      provider: PROVIDER,
      apiKey: process.env.LLM_AGENT_API_KEY,
      baseURL: process.env.LLM_AGENT_BASE_URL,
      model: MODEL,
      resourceGroup: process.env.LLM_AGENT_RESOURCE_GROUP || 'default',
    },
    0.1,
  );

  const enricher = new IntentEnricher(llm);

  // Load existing cache to skip already-enriched tools
  let cache: Record<string, { text: string; enriched: string }> = {};
  if (fs.existsSync(OUTPUT)) {
    cache = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
    console.log(`Existing cache: ${Object.keys(cache).length} entries`);
  }

  let skipped = 0;
  let enriched = 0;
  let failed = 0;

  for (const tool of tools) {
    // Skip if text unchanged and enriched text contains Intent:
    if (
      cache[tool.name]?.text === tool.text &&
      cache[tool.name]?.enriched.includes('\nIntent:')
    ) {
      skipped++;
      continue;
    }

    const result = await enricher.enrich(tool.text);
    if (result.ok && result.value.includes('\nIntent:')) {
      cache[tool.name] = { text: tool.text, enriched: result.value };
      enriched++;
      process.stdout.write(`  ${tool.name}: OK\n`);
    } else {
      failed++;
      process.stdout.write(`  ${tool.name}: FAILED (no Intent in response)\n`);
    }

    // Throttle to avoid rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  // Remove tools that no longer exist
  const toolNames = new Set(tools.map((t) => t.name));
  for (const name of Object.keys(cache)) {
    if (!toolNames.has(name)) {
      delete cache[name];
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(cache, null, 2));
  console.log(
    `\nDone: ${enriched} enriched, ${skipped} cached, ${failed} failed. Total: ${Object.keys(cache).length}`,
  );
  console.log(`Written to: ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
