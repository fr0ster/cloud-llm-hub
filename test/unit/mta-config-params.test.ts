import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';

// Non-secret settings parsed by parseRagConfig / parseDestinationConfig.
// Secrets (LLM_AGENT_EMBEDDER_API_KEY, LLM_AGENT_QDRANT_API_KEY) go through
// .env → cf set-env (tools/deploy.sh), never through mta.yaml.
const CARRIED = [
  'LLM_AGENT_EMBEDDER',
  'LLM_AGENT_EMBEDDING_MODEL',
  'LLM_AGENT_EMBEDDER_URL',
  'LLM_AGENT_TOOLS_RAG_BACKEND',
  'LLM_AGENT_SESSION_RAG_BACKEND',
  'LLM_AGENT_RAG_BACKEND',
  'LLM_AGENT_RAG_TYPE',
  'LLM_AGENT_QDRANT_URL',
  'LLM_AGENT_QDRANT_PREFIX',
  'LLM_AGENT_DESTINATION_SOURCE',
];

it('every non-secret RAG/destination setting reaches cloud-llm-hub-srv', () => {
  const mta = load(
    fs.readFileSync(path.resolve(__dirname, '../../mta.yaml'), 'utf8'),
  ) as {
    parameters: Record<string, unknown>;
    modules: { name: string; properties?: Record<string, unknown> }[];
  };
  const srv = mta.modules.find((m) => m.name === 'cloud-llm-hub-srv');
  for (const name of CARRIED) {
    expect([name, name in mta.parameters]).toEqual([name, true]);
    expect([name, srv?.properties?.[name]]).toEqual([name, `\${${name}}`]);
  }
});

const NEW = [
  'LLM_AGENT_EMBEDDER',
  'LLM_AGENT_EMBEDDER_URL',
  'LLM_AGENT_TOOLS_RAG_BACKEND',
  'LLM_AGENT_SESSION_RAG_BACKEND',
  'LLM_AGENT_RAG_BACKEND',
  'LLM_AGENT_QDRANT_URL',
  'LLM_AGENT_QDRANT_PREFIX',
  'LLM_AGENT_DESTINATION_SOURCE',
];

it('every deployment template documents the new parameters', () => {
  const dir = path.resolve(__dirname, '../../docs/deployment/templates');
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.mtaext.template'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const name of NEW) {
      expect([
        f,
        name,
        new RegExp(`^\\s*#?\\s*${name}:`, 'm').test(text),
      ]).toEqual([f, name, true]);
    }
  }
});

// A parameter with no value cannot be resolved by the deploy service unless the
// deployment's .mtaext sets it ("Unable to resolve ...#LLM_AGENT_DESTINATION_SOURCE").
// Existing deployments set none of the new ones, so each needs a default; the
// empty string reads as "not set" in agent-config.ts, i.e. today's behaviour.
it('every new parameter has a default, so a deployment without it still resolves', () => {
  const mta = load(
    fs.readFileSync(path.resolve(__dirname, '../../mta.yaml'), 'utf8'),
  ) as { parameters: Record<string, unknown> };
  for (const name of NEW) {
    expect([name, mta.parameters[name]]).toEqual([name, '']);
  }
});
