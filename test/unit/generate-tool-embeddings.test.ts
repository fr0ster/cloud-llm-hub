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
import { type Embedding, embedderFingerprint } from '../../srv/lib/providers';
import { createCollectionProvider } from '../../srv/lib/rag-provider-factory';
import type { SharedCorpusDoc } from '../../srv/lib/tool-corpus';
import {
  applyMtaext,
  decideToolBuild,
  loadTargetConfig,
  reportBuildError,
  requireBuildCredentials,
  resolveAiCoreCredentials,
  toolBuildConfig,
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
    id: 'tool:GetClass',
    name: 'GetClass',
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
  it.each(['explicit', 'aicore', 'ai-core'])(
    'does not read malformed default-env.json with %s environment credentials',
    (source) => {
      delete process.env.AICORE_SERVICE_KEY;
      delete process.env.VCAP_SERVICES;
      const credentials = {
        clientid: 'higher-priority',
        clientsecret: 'secret',
      };
      if (source === 'explicit')
        process.env.AICORE_SERVICE_KEY = JSON.stringify(credentials);
      else
        process.env.VCAP_SERVICES = JSON.stringify({
          [source]: [{ credentials }],
        });
      const defaultPath = path.resolve(__dirname, '../../default-env.json');
      const nativeFs = jest.requireActual<typeof fs>('node:fs');
      const read = nativeFs.readFileSync;
      const exists = nativeFs.existsSync;
      const existsSpy = jest
        .spyOn(nativeFs, 'existsSync')
        .mockImplementation((file) => file === defaultPath || exists(file));
      const readSpy = jest
        .spyOn(nativeFs, 'readFileSync')
        .mockImplementation(((file: fs.PathOrFileDescriptor, options: never) =>
          file === defaultPath
            ? '{malformed'
            : read(file, options)) as typeof read);
      try {
        expect(() => loadTargetConfig([])).not.toThrow();
        expect(JSON.parse(process.env.AICORE_SERVICE_KEY as string)).toEqual(
          credentials,
        );
        expect(readSpy.mock.calls.some(([file]) => file === defaultPath)).toBe(
          false,
        );
      } finally {
        readSpy.mockRestore();
        existsSpy.mockRestore();
      }
    },
  );

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

describe('toolBuildConfig', () => {
  it('a HANA deployment builds tool vectors without opening HANA (no VCAP_SERVICES locally)', () => {
    delete process.env.VCAP_SERVICES;
    const config = loadTargetConfig([
      '--mtaext',
      mtaext({
        LLM_AGENT_RAG_TYPE: 'vector',
        LLM_AGENT_RAG_BACKEND: 'hana-vector',
        LLM_AGENT_SESSION_RAG_BACKEND: 'hana-vector',
        LLM_AGENT_EMBEDDER: 'sap-ai-core',
        LLM_AGENT_PROVIDER: 'sap-ai-sdk',
      }),
    ]);
    const embedding = { retrieval: {} } as unknown as Embedding;
    expect(() => createCollectionProvider(config.rag, embedding)).toThrow(
      /VCAP_SERVICES/,
    );
    const built = toolBuildConfig(config);
    expect(built.rag.backends).toEqual({
      tools: config.rag.backends.tools,
      session: 'in-memory',
      persistent: 'in-memory',
    });
    expect(createCollectionProvider(built.rag, embedding)).toBeNull();
    expect(config.rag.backends.persistent).toBe('hana-vector');
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

  it('default AI Core config rebuilds a bundle with a stale tool description', () => {
    applyMtaext(mtaext({ LLM_AGENT_RAG_TYPE: 'vector' }), process.env);
    const config = loadAgentConfig();
    expect(config.rag.embedder?.kind).toBe('sap-ai-core');
    const fp = fingerprintOf(config);
    const d = decideToolBuild(
      config,
      fp,
      getSharedCorpusDocs().map((doc, index) =>
        index === 0 ? { ...doc, text: `${doc.text} changed schema` } : doc,
      ),
      loadToolEmbeddingBundle,
    );
    expect(d).toEqual({
      action: 'build-bundle',
      file: 'tool-embeddings.json',
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

describe('deployment AI Core credentials (no network)', () => {
  const individual = {
    AICORE_CLIENT_ID: 'client',
    AICORE_CLIENT_SECRET: 'secret',
    AICORE_AUTH_URL: 'https://auth.invalid',
    AICORE_BASE_URL: 'https://api.invalid',
  };
  it.each(['aicore', 'ai-core'])(
    'uses environment %s credentials before every fallback and preserves other bindings',
    (label) => {
      const credentials = {
        clientid: 'environment',
        clientsecret: 'env-secret',
      };
      const hana = [{ credentials: { host: 'hana.invalid' } }];
      const env: NodeJS.ProcessEnv = {
        ...individual,
        VCAP_SERVICES: JSON.stringify({ [label]: [{ credentials }], hana }),
      };
      resolveAiCoreCredentials(
        env,
        {
          aicore: [{ credentials: { clientid: 'fallback' } }],
        },
        'unused-file',
      );
      expect(JSON.parse(env.AICORE_SERVICE_KEY as string)).toEqual(credentials);
      expect(JSON.parse(env.VCAP_SERVICES as string)).toEqual({ hana });
    },
  );
  it.each(['aicore', 'ai-core'])(
    'uses environment-only %s credentials',
    (label) => {
      const env: NodeJS.ProcessEnv = {
        VCAP_SERVICES: JSON.stringify({
          [label]: [{ credentials: { clientid: 'environment-only' } }],
        }),
      };
      resolveAiCoreCredentials(env);
      expect(JSON.parse(env.AICORE_SERVICE_KEY as string).clientid).toBe(
        'environment-only',
      );
      expect(JSON.parse(env.VCAP_SERVICES as string)).toEqual({});
    },
  );
  it.each(['aicore', 'ai-core'])(
    'prefers an explicit key over %s bindings and individual variables',
    (label) => {
      const env = {
        ...individual,
        AICORE_SERVICE_KEY: '{"clientid":"explicit"}',
        VCAP_SERVICES: JSON.stringify({
          [label]: [{ credentials: { clientid: 'binding' } }],
        }),
      };
      resolveAiCoreCredentials(
        env,
        { [label]: [{ credentials: { clientid: 'default' } }] },
        'unused-file',
      );
      expect(JSON.parse(env.AICORE_SERVICE_KEY).clientid).toBe('explicit');
      expect(JSON.parse(env.VCAP_SERVICES)[label]).toBeUndefined();
    },
  );
  it.each(['aicore', 'ai-core'])(
    'prefers default-env %s bindings over individual variables and a key file',
    (label) => {
      const env: NodeJS.ProcessEnv = { ...individual };
      resolveAiCoreCredentials(
        env,
        { [label]: [{ credentials: { clientid: 'binding' } }] },
        'unused-file',
      );
      expect(JSON.parse(env.AICORE_SERVICE_KEY as string).clientid).toBe(
        'binding',
      );
    },
  );
  it('rejects malformed environment VCAP without disclosing its contents', () => {
    expect(() =>
      resolveAiCoreCredentials({ VCAP_SERVICES: 'private malformed value' }),
    ).toThrow('Could not read VCAP_SERVICES as JSON');
  });
  it('reuses the runtime mapping before trying the file', () => {
    const env: NodeJS.ProcessEnv = { ...individual };
    resolveAiCoreCredentials(env, {}, 'unused-file');
    expect(JSON.parse(env.AICORE_SERVICE_KEY as string)).toEqual({
      clientid: 'client',
      clientsecret: 'secret',
      url: individual.AICORE_AUTH_URL,
      serviceurls: { AI_API_URL: individual.AICORE_BASE_URL },
    });
  });
  it('uses the optional file last and never includes malformed contents in errors', () => {
    const file = path.join(dir, 'key.json');
    fs.writeFileSync(file, '{"clientid":"file"}');
    const env: NodeJS.ProcessEnv = {};
    resolveAiCoreCredentials(env, {}, file);
    expect(JSON.parse(env.AICORE_SERVICE_KEY as string).clientid).toBe('file');
    fs.writeFileSync(file, 'secret malformed JSON');
    expect(() => resolveAiCoreCredentials({}, {}, file)).toThrow(
      'Could not read AI Core service key JSON from --aicore-key file',
    );
  });
  it('allows missing credentials until regeneration and names every option', () => {
    resolveAiCoreCredentials({}, {});
    delete process.env.AICORE_SERVICE_KEY;
    process.env.LLM_AGENT_RAG_TYPE = 'vector';
    process.env.LLM_AGENT_EMBEDDER = 'sap-ai-core';
    const config = loadAgentConfig();
    expect(() => requireBuildCredentials(config)).toThrow(
      /AICORE_SERVICE_KEY.*default-env.json.*AICORE_CLIENT_ID.*--aicore-key/,
    );
  });
});

describe('CLI error reporting', () => {
  it.each([
    ['Authorization: Bearer header-token', 'Authorization: [REDACTED]'],
    [
      'Proxy-Authorization: Basic proxy-token',
      'Proxy-Authorization: [REDACTED]',
    ],
    [
      'Authorization: Digest username="private", response="private-response"',
      'Authorization: [REDACTED]',
    ],
    [
      'request Bearer anywhere-token rejected',
      'request Bearer [REDACTED] rejected',
    ],
    [
      'request Basic anywhere-basic rejected',
      'request Basic [REDACTED] rejected',
    ],
    [
      JSON.stringify({ clientsecret: 'prefix"secret-suffix' }),
      '{"clientsecret":[REDACTED]}',
    ],
    [
      JSON.stringify({ access_token: 'prefix\\"token-suffix' }),
      '{"access_token":[REDACTED]}',
    ],
  ])('redacts %s and retains diagnostics', (input, redacted) => {
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportBuildError(
        new TypeError(`HTTP 401\n${input}\nEmbedding request rejected`),
        {},
      );
      expect(output).toHaveBeenCalledWith(
        `TypeError: HTTP 401\n${redacted}\nEmbedding request rejected`,
      );
    } finally {
      output.mockRestore();
    }
  });

  it('redacts every selected key string value in raw, JSON and URL forms', () => {
    const secret = 'custom/secret"suffix';
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportBuildError(
        new Error(
          `HTTP 403 ${secret} ${JSON.stringify(secret)} ${encodeURIComponent(secret)} denied`,
        ),
        {
          AICORE_SERVICE_KEY: JSON.stringify({ nested: { custom: secret } }),
        },
      );
      expect(output).toHaveBeenCalledWith(
        'Error: HTTP 403 [REDACTED] "[REDACTED]" [REDACTED] denied',
      );
    } finally {
      output.mockRestore();
    }
  });

  it('redacts selected credentials in a thrown embedding error and keeps its type and diagnostic', async () => {
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const env = {
        AICORE_SERVICE_KEY: JSON.stringify({
          clientid: 'selected-client',
          clientsecret: 'selected/secret+value',
          tokens: { access_token: 'selected-token' },
        }),
      };
      await Promise.reject(
        new TypeError(
          'Embedding failed (401): selected/secret+value selected-client selected-token selected%2Fsecret%2Bvalue',
        ),
      ).catch((err) => reportBuildError(err, env));
      expect(output).toHaveBeenCalledWith(
        'TypeError: Embedding failed (401): [REDACTED] [REDACTED] [REDACTED] [REDACTED]',
      );
    } finally {
      output.mockRestore();
    }
  });

  it('redacts known credential fields even when their values are not in the selected key', () => {
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportBuildError(
        new Error(
          '401 {"clientsecret":"other-secret","access_token":"other-token"} api_key=private-key',
        ),
        {},
      );
      expect(output).toHaveBeenCalledWith(
        'Error: 401 {"clientsecret":[REDACTED],"access_token":[REDACTED]} api_key=[REDACTED]',
      );
    } finally {
      output.mockRestore();
    }
  });
});
