import cds from '@sap/cds';
import {
  clearAgentConfig,
  loadAgentConfig,
  parseToolSearchK,
} from '../../srv/agent-config';

const originalStrategy = process.env.LLM_AGENT_TOOLS_SELECTION;
const originalReader = process.env.LLM_AGENT_TOOLS_K_READER;
const originalWriter = process.env.LLM_AGENT_TOOLS_K_WRITER;
afterEach(() => {
  if (originalReader === undefined) delete process.env.LLM_AGENT_TOOLS_K_READER;
  else process.env.LLM_AGENT_TOOLS_K_READER = originalReader;
  if (originalWriter === undefined) delete process.env.LLM_AGENT_TOOLS_K_WRITER;
  else process.env.LLM_AGENT_TOOLS_K_WRITER = originalWriter;
  if (originalStrategy === undefined)
    delete process.env.LLM_AGENT_TOOLS_SELECTION;
  else process.env.LLM_AGENT_TOOLS_SELECTION = originalStrategy;
  clearAgentConfig();
});
it('defaults to 2/1 and reads independent environment overrides', () => {
  delete process.env.LLM_AGENT_TOOLS_K_READER;
  delete process.env.LLM_AGENT_TOOLS_K_WRITER;
  clearAgentConfig();
  delete process.env.LLM_AGENT_TOOLS_SELECTION;
  expect(loadAgentConfig().agent).toMatchObject({
    kReader: 2,
    kWriter: 1,
    toolSelection: 'per-collection',
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

it.each(['per-collection', 'step-kind'])(
  'reads selection strategy %s',
  (strategy) => {
    process.env.LLM_AGENT_TOOLS_SELECTION = strategy;
    clearAgentConfig();
    expect(loadAgentConfig().agent.toolSelection).toBe(strategy);
  },
);
it.each(['invalid', '', 'ALL-SEEDS'])(
  'rejects invalid selection strategy %s at config load',
  (strategy) => {
    process.env.LLM_AGENT_TOOLS_SELECTION = strategy;
    clearAgentConfig();
    expect(() => loadAgentConfig()).toThrow(
      'LLM_AGENT_TOOLS_SELECTION must be one of: per-collection, step-kind',
    );
  },
);

it('warns only once when the removed strategy variable is set', () => {
  const previous = process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY;
  const warn = jest
    .spyOn(cds.log('agent-config'), 'warn')
    .mockImplementation(() => {});
  try {
    process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY = 'obsolete';
    clearAgentConfig();
    loadAgentConfig();
    clearAgentConfig();
    loadAgentConfig();
    expect(
      warn.mock.calls.filter((call) =>
        String(call[0]).includes('LLM_AGENT_TOOLS_CLUSTER_STRATEGY'),
      ),
    ).toHaveLength(1);
  } finally {
    if (previous === undefined)
      delete process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY;
    else process.env.LLM_AGENT_TOOLS_CLUSTER_STRATEGY = previous;
    warn.mockRestore();
  }
});
