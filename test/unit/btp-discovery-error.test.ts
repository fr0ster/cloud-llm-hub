const mockInfo = jest.fn();
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: { log: () => ({ info: mockInfo }) },
}));
jest.mock('../../srv/lib/btp-oauth', () => ({
  getServiceCredentials: () => {
    throw new TypeError('secret-service-binding');
  },
}));

import { btpDestinationSource } from '../../srv/lib/btp-destinations';

test('BTP startup failure logs its type at info without secret error content', async () => {
  const previous = process.env.LLM_AGENT_MCP_DESTINATION;
  delete process.env.LLM_AGENT_MCP_DESTINATION;
  try {
    expect(await btpDestinationSource().list()).toEqual([]);
    expect(mockInfo).toHaveBeenCalledWith(
      'Failed to fetch destinations, using env var fallback',
      { errorType: 'TypeError' },
    );
    expect(JSON.stringify(mockInfo.mock.calls)).not.toContain(
      'secret-service-binding',
    );
  } finally {
    if (previous === undefined) delete process.env.LLM_AGENT_MCP_DESTINATION;
    else process.env.LLM_AGENT_MCP_DESTINATION = previous;
  }
});
