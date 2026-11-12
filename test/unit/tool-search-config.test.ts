import {
  clearAgentConfig,
  loadAgentConfig,
  parseToolSearchK,
} from '../../srv/agent-config';

const originalStrategy = process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY;
const originalReader = process.env.LLM_AGENT_TOOLS_K_READER;
const originalWriter = process.env.LLM_AGENT_TOOLS_K_WRITER;
afterEach(() => {
  if (originalReader === undefined) delete process.env.LLM_AGENT_TOOLS_K_READER;
  else process.env.LLM_AGENT_TOOLS_K_READER = originalReader;
  if (originalWriter === undefined) delete process.env.LLM_AGENT_TOOLS_K_WRITER;
  else process.env.LLM_AGENT_TOOLS_K_WRITER = originalWriter;
  if (originalStrategy === undefined)
    delete process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY;
  else process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY = originalStrategy;
  clearAgentConfig();
});
it('defaults to 2/1 and reads independent environment overrides', () => {
  delete process.env.LLM_AGENT_TOOLS_K_READER;
  delete process.env.LLM_AGENT_TOOLS_K_WRITER;
  clearAgentConfig();
  delete process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY;
  expect(loadAgentConfig().agent).toMatchObject({
    kReader: 2,
    kWriter: 1,
    toolClusterStrategy: 'all-seeds',
  });
  process.env.LLM_AGENT_TOOLS_K_READER = '3';
  process.env.LLM_AGENT_TOOLS_K_WRITER = '7';
  clearAgentConfig();
  expect(loadAgentConfig().agent).toMatchObject({ kReader: 3, kWriter: 7 });
});
it.each(['0', '-1', '1.5', '2junk', '', 'NaN', 'Infinity'])(
  'rejects invalid K %s',
  (value) => {
    expect(() => parseToolSearchK(value, 2)).toThrow('positive integer');
  },
);

it.each(['all-seeds', 'top-writer'])(
  'reads cluster strategy %s',
  (strategy) => {
    process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY = strategy;
    clearAgentConfig();
    expect(loadAgentConfig().agent.toolClusterStrategy).toBe(strategy);
  },
);
it.each(['invalid', '', 'ALL-SEEDS'])(
  'rejects invalid cluster strategy %s at config load',
  (strategy) => {
    process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY = strategy;
    clearAgentConfig();
    expect(() => loadAgentConfig()).toThrow(
      'LLM_AGENT_TOOLS_CLUSTER_STRATEGY must be one of: all-seeds, top-writer',
    );
  },
);
