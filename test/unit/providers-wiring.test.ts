jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import {
  CircuitBreakerEmbedder,
  FallbackRag,
  InMemoryRag,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { clearAgentConfig, loadAgentConfig } from '../../srv/agent-config';
import { startProviders } from '../../srv/lib/providers';

describe('default configuration builds today objects', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    clearAgentConfig();
  });

  it('no RAG variables: in-memory everywhere, no embedder', async () => {
    delete process.env.LLM_AGENT_RAG_TYPE;
    const p = await startProviders(loadAgentConfig());
    expect(p.embedding).toBeNull();
    expect(p.stores.create('tools', 'reader')).toBeInstanceOf(InMemoryRag);
    expect(p.stores.create('session', 'history')).toBeInstanceOf(InMemoryRag);
  });

  it('LLM_AGENT_RAG_TYPE=vector, sap-ai-sdk: FallbackRag(VectorRag) and a breaker-wrapped AI Core embedder', async () => {
    process.env.LLM_AGENT_RAG_TYPE = 'vector';
    delete process.env.LLM_AGENT_PROVIDER;
    const p = await startProviders(loadAgentConfig());
    expect(p.embedding?.embedder).toBeInstanceOf(CircuitBreakerEmbedder);
    const tools = p.stores.create('tools', 'reader');
    expect(tools).toBeInstanceOf(FallbackRag);
    expect((tools as unknown as { primary: unknown }).primary).toBeInstanceOf(
      VectorRag,
    );
  });
});
