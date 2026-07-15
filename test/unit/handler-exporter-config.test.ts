import { getHandlerExporterConfig } from '../../srv/agent-manager';

describe('getHandlerExporterConfig', () => {
  it('defaults compact + low-level OFF (high-level only)', () => {
    const c = getHandlerExporterConfig({});
    expect(c.includeCompact).toBe(false);
    expect(c.includeLowLevel).toBe(false);
    expect(c.includeHighLevel).toBe(true);
    expect(c.includeReadOnly).toBe(true);
    expect(c.includeSystem).toBe(true);
    expect(c.includeSearch).toBe(true);
  });

  it('enables compact only when LLM_AGENT_INCLUDE_COMPACT=true', () => {
    expect(
      getHandlerExporterConfig({ LLM_AGENT_INCLUDE_COMPACT: 'true' })
        .includeCompact,
    ).toBe(true);
    expect(
      getHandlerExporterConfig({ LLM_AGENT_INCLUDE_COMPACT: 'false' })
        .includeCompact,
    ).toBe(false);
    expect(
      getHandlerExporterConfig({ LLM_AGENT_INCLUDE_COMPACT: '1' })
        .includeCompact,
    ).toBe(false);
  });

  it('enables low-level only when LLM_AGENT_INCLUDE_LOW_LEVEL=true', () => {
    expect(
      getHandlerExporterConfig({ LLM_AGENT_INCLUDE_LOW_LEVEL: 'true' })
        .includeLowLevel,
    ).toBe(true);
  });
});
