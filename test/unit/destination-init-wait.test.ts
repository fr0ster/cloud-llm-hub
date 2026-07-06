import { getDestinationInitWaitMs } from '../../srv/agent-manager';

describe('getDestinationInitWaitMs', () => {
  it('defaults to 90_000 when the env var is unset', () => {
    expect(getDestinationInitWaitMs({})).toBe(90_000);
  });

  it('honours a valid positive override', () => {
    expect(
      getDestinationInitWaitMs({
        LLM_AGENT_DESTINATION_INIT_WAIT_MS: '120000',
      }),
    ).toBe(120_000);
  });

  it('falls back to the default for non-numeric / zero / negative values', () => {
    expect(
      getDestinationInitWaitMs({ LLM_AGENT_DESTINATION_INIT_WAIT_MS: 'abc' }),
    ).toBe(90_000);
    expect(
      getDestinationInitWaitMs({ LLM_AGENT_DESTINATION_INIT_WAIT_MS: '0' }),
    ).toBe(90_000);
    expect(
      getDestinationInitWaitMs({ LLM_AGENT_DESTINATION_INIT_WAIT_MS: '-5' }),
    ).toBe(90_000);
  });
});
