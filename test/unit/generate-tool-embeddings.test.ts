jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type AgentConfig,
  clearAgentConfig,
  loadAgentConfig,
} from '../../srv/agent-config';
import {
  getSharedCorpusDocs,
  loadToolEmbeddingBundle,
} from '../../srv/agent-manager';
import { embedderFingerprint } from '../../srv/lib/providers';
import type { SharedCorpusDoc } from '../../srv/lib/tool-corpus';
import {
  applyMtaext,
  decideToolBuild,
  loadTargetConfig,
} from '../../tools/generate-tool-embeddings';

const RAG_VARS = [
  'LLM_AGENT_RAG_TYPE',
  'LLM_AGENT_TOOLS_RAG_BACKEND',
  'LLM_AGENT_SESSION_RAG_BACKEND',
  'LLM_AGENT_RAG_BACKEND',
  'LLM_AGENT_EMBEDDER',
  'LLM_AGENT_EMBEDDING_MODEL',
  'LLM_AGENT_EMBEDDER_URL',
  'LLM_AGENT_EMBEDDER_API_KEY',
  'LLM_AGENT_QDRANT_URL',
  'LLM_AGENT_PROVIDER',
  'LLM_AGENT_BASE_URL',
];

const docs: SharedCorpusDoc[] = [
  {
    id: 'tool:ReadClass',
    name: 'ReadClass',
    text: 'read a class',
    exposition: 'readonly',
    cached: true,
  },
  {
    id: 'tool:CreateClass',
    name: 'CreateClass',
    text: 'create a class',
    exposition: 'high',
    cached: true,
  },
];

/** The configured embedder's fingerprint; the test fails if there is none. */
function fingerprintOf(config: AgentConfig) {
  const e = config.rag.embedder;
  if (!e) throw new Error('expected an embedder in this configuration');
  return embedderFingerprint(e);
}

let dir: string;
function mtaext(parameters: Record<string, unknown>): string {
  const file = path.join(
    dir,
    `t-${Math.random().toString(36).slice(2)}.mtaext`,
  );
  const lines = Object.entries(parameters).map(
    ([k, v]) => `  ${k}: ${v === null ? 'null' : JSON.stringify(v)}`,
  );
  fs.writeFileSync(
    file,
    `_schema-version: '3.3.0'\nID: x\nextends: y\nparameters:\n${lines.join('\n')}\n`,
  );
  return file;
}

const saved = { ...process.env };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtaext-'));
  for (const k of RAG_VARS) delete process.env[k];
});
afterEach(() => {
  process.env = { ...saved };
  clearAgentConfig();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('applyMtaext', () => {
  it('sets a parameter and overrides a pre-set value', () => {
    const env: NodeJS.ProcessEnv = { LLM_AGENT_TOOLS_RAG_BACKEND: 'vector' };
    applyMtaext(mtaext({ LLM_AGENT_TOOLS_RAG_BACKEND: 'qdrant' }), env);
    expect(env.LLM_AGENT_TOOLS_RAG_BACKEND).toBe('qdrant');
  });

  it('stringifies scalars and leaves null parameters out', () => {
    const env: NodeJS.ProcessEnv = { KEEP: 'me' };
    applyMtaext(mtaext({ LLM_AGENT_MAX_TOKENS: 32000, KEEP: null }), env);
    expect(env.LLM_AGENT_MAX_TOKENS).toBe('32000');
    expect(env.KEEP).toBe('me');
  });
});

describe('loadTargetConfig', () => {
  it('applies --mtaext before loadAgentConfig, so the file wins over the environment', () => {
    process.env.LLM_AGENT_RAG_TYPE = 'vector';
    process.env.LLM_AGENT_EMBEDDING_MODEL = 'model-a';
    const config = loadTargetConfig([
      '--mtaext',
      mtaext({ LLM_AGENT_EMBEDDING_MODEL: 'model-b' }),
    ]);
    expect(config.rag.embedder?.model).toBe('model-b');
  });
});

describe('decideToolBuild', () => {
  it('legacy .mtaext (RAG_TYPE vector, provider openai): build a per-fingerprint bundle', () => {
    applyMtaext(
      mtaext({ LLM_AGENT_RAG_TYPE: 'vector', LLM_AGENT_PROVIDER: 'openai' }),
      process.env,
    );
    const config = loadAgentConfig();
    const fp = fingerprintOf(config);
    const d = decideToolBuild(config, fp, docs, () => null);
    expect(d.action).toBe('build-bundle');
    expect(d.action === 'build-bundle' && d.file).toMatch(
      /^tool-embeddings\.[0-9a-f]{12}\.json$/,
    );
  });

  it('same config with a fully matching bundle: skip', () => {
    applyMtaext(
      mtaext({ LLM_AGENT_RAG_TYPE: 'vector', LLM_AGENT_PROVIDER: 'openai' }),
      process.env,
    );
    const config = loadAgentConfig();
    const fp = fingerprintOf(config);
    const bundle = {
      header: { embedderFingerprint: fp, embeddingDim: 2 },
      entries: docs.map((x) => ({
        id: x.id,
        name: x.name,
        text: x.text,
        vector: [1, 0],
      })),
    };
    let asked = '';
    const d = decideToolBuild(config, fp, docs, (file) => {
      asked = file;
      return bundle;
    });
    expect(d.action).toBe('skip');
    expect(asked).toMatch(/^tool-embeddings\.[0-9a-f]{12}\.json$/);
  });

  it('a bundle stale for one tool: build', () => {
    process.env.LLM_AGENT_RAG_TYPE = 'vector';
    process.env.LLM_AGENT_PROVIDER = 'openai';
    const config = loadAgentConfig();
    const fp = fingerprintOf(config);
    const bundle = {
      header: { embedderFingerprint: fp, embeddingDim: 2 },
      entries: [
        { id: docs[0].id, name: docs[0].name, text: docs[0].text, vector: [1] },
      ],
    };
    expect(decideToolBuild(config, fp, docs, () => bundle).action).toBe(
      'build-bundle',
    );
  });

  it('default AI Core config with the committed bundle: skip', () => {
    applyMtaext(mtaext({ LLM_AGENT_RAG_TYPE: 'vector' }), process.env);
    const config = loadAgentConfig();
    expect(config.rag.embedder?.kind).toBe('sap-ai-core');
    const fp = fingerprintOf(config);
    const d = decideToolBuild(
      config,
      fp,
      getSharedCorpusDocs(),
      loadToolEmbeddingBundle,
    );
    expect(d).toEqual({
      action: 'skip',
      reason: 'tool-embeddings.json already matches',
    });
  });

  it('no RAG variables: none', () => {
    const config = loadAgentConfig();
    expect(decideToolBuild(config, null, docs, () => null)).toEqual({
      action: 'none',
      reason: 'tools are in-memory',
    });
  });

  it('tools on qdrant: build-qdrant, whatever bundles exist', () => {
    process.env.LLM_AGENT_RAG_TYPE = 'vector';
    process.env.LLM_AGENT_TOOLS_RAG_BACKEND = 'qdrant';
    process.env.LLM_AGENT_QDRANT_URL = 'http://localhost:6433';
    const config = loadAgentConfig();
    const fp = fingerprintOf(config);
    const reader = jest.fn(() => null);
    expect(decideToolBuild(config, fp, docs, reader)).toEqual({
      action: 'build-qdrant',
    });
    expect(reader).not.toHaveBeenCalled();
  });
});
