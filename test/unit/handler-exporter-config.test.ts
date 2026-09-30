import { HandlerExporter } from '@mcp-abap-adt/lib/handlers';
import { getHandlerExporterConfig } from '../../srv/agent-manager';
import { lowLevelOnlyTools } from './helpers/low-level-tools';

// The hub serves the read-only and high-level tools, plus search and system.
// It has no use for the low-level API, and no environment variable brings it
// back: the include-config is fixed.
describe('getHandlerExporterConfig', () => {
  it('serves read-only, high-level, search and system — never low-level', () => {
    const c = getHandlerExporterConfig();
    expect(c.includeLowLevel).toBe(false);
    expect(c.includeHighLevel).toBe(true);
    expect(c.includeReadOnly).toBe(true);
    expect(c.includeSystem).toBe(true);
    expect(c.includeSearch).toBe(true);
    expect(c).not.toHaveProperty('includeCompact');
  });

  it('ignores the removed opt-in variables a deployment may still set', () => {
    const saved = { ...process.env };
    try {
      process.env.LLM_AGENT_INCLUDE_LOW_LEVEL = 'true';
      process.env.LLM_AGENT_INCLUDE_COMPACT = 'true';
      expect(getHandlerExporterConfig().includeLowLevel).toBe(false);
    } finally {
      process.env = saved;
    }
  });

  it('exports no tool that only the low-level group carries', () => {
    const served = new Set(
      new HandlerExporter(getHandlerExporterConfig())
        .getHandlerEntries()
        .map((e) => e.toolDefinition.name),
    );
    const lowOnly = lowLevelOnlyTools();
    expect(lowOnly.length).toBeGreaterThan(0);
    expect(lowOnly.filter((t) => served.has(t))).toEqual([]);
    expect([...served].filter((n) => /^Handler[A-Z]/.test(n))).toEqual([]);
  });
});
