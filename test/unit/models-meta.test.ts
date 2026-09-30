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
    llm: { temperature: 0, maxTokens: 1 },
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
