import { parseDestinationConfig, parseRagConfig } from '../../srv/agent-config';

const llmSap = { provider: 'sap-ai-sdk' as const, resourceGroup: 'default' };
const llmOpenai = {
  provider: 'openai' as const,
  apiKey: 'k',
  baseUrl: 'http://llm.example.com/v1',
};

describe('parseRagConfig', () => {
  it('no variables: every class in-memory, no embedder (today)', () => {
    expect(parseRagConfig({}, llmSap)).toEqual({
      embedder: null,
      backends: {
        tools: 'in-memory',
        session: 'in-memory',
        persistent: 'in-memory',
      },
    });
  });

  it('LLM_AGENT_RAG_TYPE=vector with sap-ai-sdk: vector everywhere, AI Core embedder (today)', () => {
    expect(parseRagConfig({ LLM_AGENT_RAG_TYPE: 'vector' }, llmSap)).toEqual({
      embedder: {
        kind: 'sap-ai-core',
        model: 'text-embedding-3-small',
        resourceGroup: 'default',
      },
      backends: { tools: 'vector', session: 'vector', persistent: 'vector' },
    });
  });

  it('LLM_AGENT_RAG_TYPE=vector with openai: openai embedder at the LLM base URL (today)', () => {
    expect(
      parseRagConfig({ LLM_AGENT_RAG_TYPE: 'vector' }, llmOpenai).embedder,
    ).toEqual({
      kind: 'openai',
      model: 'text-embedding-3-small',
      url: 'http://llm.example.com/v1',
      apiKey: 'k',
    });
  });

  it('ollama embedder needs a model and defaults its URL', () => {
    const env = {
      LLM_AGENT_TOOLS_RAG_BACKEND: 'vector',
      LLM_AGENT_EMBEDDER: 'ollama',
      LLM_AGENT_EMBEDDING_MODEL: 'bge-m3',
    };
    expect(parseRagConfig(env, llmOpenai).embedder).toEqual({
      kind: 'ollama',
      model: 'bge-m3',
      url: 'http://localhost:11434',
    });
    expect(() =>
      parseRagConfig({ ...env, LLM_AGENT_EMBEDDING_MODEL: '' }, llmOpenai),
    ).toThrow(/LLM_AGENT_EMBEDDING_MODEL/);
  });

  it('tools on qdrant needs a URL; prefix defaults', () => {
    const env = {
      LLM_AGENT_TOOLS_RAG_BACKEND: 'qdrant',
      LLM_AGENT_EMBEDDER: 'ollama',
      LLM_AGENT_EMBEDDING_MODEL: 'bge-m3',
    };
    expect(() => parseRagConfig(env, llmOpenai)).toThrow(
      /LLM_AGENT_QDRANT_URL/,
    );
    expect(
      parseRagConfig(
        { ...env, LLM_AGENT_QDRANT_URL: 'http://localhost:6433' },
        llmOpenai,
      ).qdrant,
    ).toEqual({ url: 'http://localhost:6433', prefix: 'cloud-llm-hub' });
    // A trailing slash would make every REST path `//collections`.
    expect(
      parseRagConfig(
        { ...env, LLM_AGENT_QDRANT_URL: 'http://localhost:6433//' },
        llmOpenai,
      ).qdrant?.url,
    ).toBe('http://localhost:6433');
  });

  it.each([
    [{ LLM_AGENT_TOOLS_RAG_BACKEND: 'hana' }, /LLM_AGENT_TOOLS_RAG_BACKEND/],
    [
      { LLM_AGENT_EMBEDDER: 'foo', LLM_AGENT_RAG_TYPE: 'vector' },
      /LLM_AGENT_EMBEDDER/,
    ],
    [{ LLM_AGENT_EMBEDDER: 'ollama' }, /every RAG class is in-memory/],
    [
      {
        LLM_AGENT_RAG_TYPE: 'in-memory',
        LLM_AGENT_TOOLS_RAG_BACKEND: 'vector',
      },
      /contradict/,
    ],
    [
      {
        LLM_AGENT_SESSION_RAG_BACKEND: 'qdrant',
        LLM_AGENT_QDRANT_URL: 'http://q',
      },
      /not yet supported/,
    ],
    [
      { LLM_AGENT_RAG_BACKEND: 'qdrant', LLM_AGENT_QDRANT_URL: 'http://q' },
      /Plan B|not yet supported/,
    ],
  ])('rejects %j', (env, msg) => {
    expect(() => parseRagConfig(env, llmSap)).toThrow(msg);
  });
});

describe('parseDestinationConfig', () => {
  it('defaults to btp', () => {
    expect(parseDestinationConfig({})).toEqual({ source: 'btp' });
  });
  it('env: reads the Cloud SDK destinations variable (name or Name)', () => {
    const destinations = JSON.stringify([
      {
        name: 'SAP_DEV',
        url: 'https://sap.example.com:44300',
        proxyType: 'Internet',
        authentication: 'NoAuthentication',
        sapClient: '100',
      },
      {
        Name: 'SAP_QAS',
        URL: 'https://qas.example.com',
        ProxyType: 'Internet',
        Authentication: 'NoAuthentication',
      },
    ]);
    expect(
      parseDestinationConfig({
        LLM_AGENT_DESTINATION_SOURCE: 'env',
        destinations,
      }),
    ).toEqual({
      source: 'env',
      destinations: [
        {
          name: 'SAP_DEV',
          url: 'https://sap.example.com:44300',
          proxyType: 'Internet',
          authentication: 'NoAuthentication',
          sapClient: '100',
        },
        {
          name: 'SAP_QAS',
          url: 'https://qas.example.com',
          proxyType: 'Internet',
          authentication: 'NoAuthentication',
        },
      ],
    });
  });
  it.each([
    [{ LLM_AGENT_DESTINATION_SOURCE: 'env' }, /destinations/],
    [
      { LLM_AGENT_DESTINATION_SOURCE: 'env', destinations: '{' },
      /destinations/,
    ],
    [
      { LLM_AGENT_DESTINATION_SOURCE: 'env', destinations: '[]' },
      /at least one/,
    ],
    [
      { LLM_AGENT_DESTINATION_SOURCE: 'env', destinations: '[{"url":"x"}]' },
      /name/,
    ],
    [{ LLM_AGENT_DESTINATION_SOURCE: 'ldap' }, /LLM_AGENT_DESTINATION_SOURCE/],
  ])('rejects %j', (env, msg) => {
    expect(() => parseDestinationConfig(env)).toThrow(msg);
  });
});
