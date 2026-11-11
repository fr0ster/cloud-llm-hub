import {
  clearAgentConfig,
  loadAgentConfig,
  parseToolSearchK,
} from '../../srv/agent-config';

const originalReader = process.env.LLM_AGENT_TOOLS_K_READER;
const originalWriter = process.env.LLM_AGENT_TOOLS_K_WRITER;
afterEach(() => {
  if (originalReader === undefined) delete process.env.LLM_AGENT_TOOLS_K_READER;
  else process.env.LLM_AGENT_TOOLS_K_READER = originalReader;
  if (originalWriter === undefined) delete process.env.LLM_AGENT_TOOLS_K_WRITER;
  else process.env.LLM_AGENT_TOOLS_K_WRITER = originalWriter;
  clearAgentConfig();
});
it('defaults to 2/5 and reads independent environment overrides', () => {
  delete process.env.LLM_AGENT_TOOLS_K_READER;
  delete process.env.LLM_AGENT_TOOLS_K_WRITER;
  clearAgentConfig();
  expect(loadAgentConfig().agent).toMatchObject({ kReader: 2, kWriter: 5 });
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
