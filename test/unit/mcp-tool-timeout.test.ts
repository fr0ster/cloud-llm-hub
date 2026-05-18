import { resolveMcpToolTimeoutMs } from '../../srv/agent-manager';

describe('resolveMcpToolTimeoutMs', () => {
  it('returns 600_000 for SearchSource when no env is set', () => {
    expect(resolveMcpToolTimeoutMs('SearchSource', {})).toBe(600_000);
  });

  it('returns 120_000 for other tools when no env is set', () => {
    expect(resolveMcpToolTimeoutMs('RuntimeListFeeds', {})).toBe(120_000);
    expect(resolveMcpToolTimeoutMs('GetClass', {})).toBe(120_000);
    expect(resolveMcpToolTimeoutMs('SearchObject', {})).toBe(120_000);
  });

  it('global env override wins for any tool', () => {
    const env = { LLM_AGENT_MCP_TOOL_TIMEOUT_MS: '900000' };
    expect(resolveMcpToolTimeoutMs('SearchSource', env)).toBe(900_000);
    expect(resolveMcpToolTimeoutMs('GetClass', env)).toBe(900_000);
  });

  it('non-numeric env value falls through to per-tool default', () => {
    expect(
      resolveMcpToolTimeoutMs('SearchSource', {
        LLM_AGENT_MCP_TOOL_TIMEOUT_MS: 'abc',
      }),
    ).toBe(600_000);
    expect(
      resolveMcpToolTimeoutMs('GetClass', {
        LLM_AGENT_MCP_TOOL_TIMEOUT_MS: 'abc',
      }),
    ).toBe(120_000);
  });

  it('zero env value falls through to per-tool default', () => {
    expect(
      resolveMcpToolTimeoutMs('SearchSource', {
        LLM_AGENT_MCP_TOOL_TIMEOUT_MS: '0',
      }),
    ).toBe(600_000);
  });

  it('negative env value falls through to per-tool default', () => {
    expect(
      resolveMcpToolTimeoutMs('GetClass', {
        LLM_AGENT_MCP_TOOL_TIMEOUT_MS: '-1',
      }),
    ).toBe(120_000);
  });
});
