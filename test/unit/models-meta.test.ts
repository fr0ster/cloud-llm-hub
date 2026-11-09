import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IModelInfo } from '@mcp-abap-adt/llm-agent';
import express from 'express';
import { resetModelCatalog } from '../../srv/lib/model-catalog';

const mockCatalog = jest.fn<Promise<IModelInfo[]>, []>();
jest.mock('../../srv/lib/llm-factory', () => ({
  makeHubCatalogProvider: () => ({ getModelCatalog: mockCatalog }),
}));

// Bootstrap logging is tested with real CAP in logging-config.test.ts.
jest.mock('../../srv/lib/logging-config', () => ({
  applyLoggingConfig: jest.fn(),
}));

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: {},
    },
  }),
  { virtual: true },
);

const mockLlm: {
  model: string;
  plannerModel?: string;
  temperature: number;
  maxTokens: number;
} = {
  model: 'main-model',
  temperature: 0,
  maxTokens: 1,
};

const mockRag = {
  embedder: null as null | { kind: string; model: string },
  backends: {
    tools: 'in-memory',
    session: 'in-memory',
    persistent: 'in-memory',
  },
};
jest.mock('../../srv/agent-config', () => ({
  ...jest.requireActual('../../srv/agent-config'),
  getAgentConfig: () => ({
    llm: mockLlm,
    agent: { mode: 'smart', maxIterations: 1, ragType: 'in-memory' },
    mcp: { destination: undefined },
    rag: mockRag,
  }),
}));
jest.mock('../../srv/lib/ai-core-models', () => ({
  getAvailableModels: async () => [],
}));

import { handleModels } from '../../srv/openai-handler';

async function meta(): Promise<Record<string, unknown>> {
  let body = '';
  const res = { writeHead: () => {}, end: (b: string) => (body = b) };
  await handleModels({} as never, res as never);
  return JSON.parse(body)._meta;
}

describe('/v1/models _meta', () => {
  it.each([undefined, 'independent-planner'])(
    'reports the planner model with override %s',
    async (plannerModel) => {
      mockLlm.plannerModel = plannerModel;
      try {
        expect((await meta()).planner_model).toBe(plannerModel ?? 'main-model');
      } finally {
        delete mockLlm.plannerModel;
      }
    },
  );

  it('reports no embedding model when no embedder is configured', async () => {
    mockRag.embedder = null;
    const m = await meta();
    expect(m.embedding_model).toBeNull();
    expect(m.rag_backends).toEqual(mockRag.backends);
  });

  it('reports the configured embedder model, not the environment', async () => {
    process.env.LLM_AGENT_EMBEDDING_MODEL = 'from-env-must-not-show';
    mockRag.embedder = { kind: 'ollama', model: 'bge-m3' };
    try {
      expect((await meta()).embedding_model).toBe('bge-m3');
    } finally {
      delete process.env.LLM_AGENT_EMBEDDING_MODEL;
    }
  });
});

it('/v1/models includes _meta.capabilities for the allowlist', async () => {
  const previous = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'gpt-5,unrecognized-model';
  try {
    expect((await meta()).capabilities).toMatchObject({
      'gpt-5': { family: 'openai-reasoning' },
      'unrecognized-model': null,
    });
  } finally {
    if (previous === undefined) delete process.env.LLM_AGENT_MODELS;
    else process.env.LLM_AGENT_MODELS = previous;
  }
});

it('GET /v1/models retries a failed catalog and returns the catalog allowlist', async () => {
  const previousEnv = { ...process.env };
  process.env.LLM_AGENT_MODELS = 'catalog,extra-model';
  process.env.LLM_AGENT_MODEL = 'main-model';
  delete process.env.LLM_AGENT_PLANNER_MODEL;
  resetModelCatalog();
  mockCatalog
    .mockRejectedValueOnce(new Error('catalog unavailable'))
    .mockResolvedValue([
      {
        id: 'gpt-6-luna',
        capabilities: ['text-generation'],
        scenarios: ['orchestration'],
      },
    ]);
  const app = express();
  app.get('/v1/models', handleModels);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/models`;
  try {
    const before = await fetch(url);
    expect(await before.json()).toMatchObject({
      data: [{ id: 'extra-model' }, { id: 'main-model' }],
    });
    const after = await fetch(url);
    expect(await after.json()).toMatchObject({
      data: [{ id: 'extra-model' }, { id: 'main-model' }, { id: 'gpt-6-luna' }],
      _meta: { capabilities: { 'gpt-6-luna': { family: 'openai' } } },
    });
    expect(mockCatalog).toHaveBeenCalledTimes(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = previousEnv;
    resetModelCatalog();
  }
});
