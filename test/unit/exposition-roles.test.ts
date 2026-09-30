import {
  type ExpositionLevel,
  resolveExposition,
  SYSTEM_TOOLS_THAT_WRITE,
} from '../../srv/lib/exposition';
import { assertToolAllowed } from '../../srv/lib/tool-authorization';
import { buildToolExpositionMap } from '../../srv/lib/tool-exposition-map';

// The boundary is EFFECT, not the upstream group: Reader gets everything that
// changes nothing, Developer adds everything that changes something. The
// upstream groups are cut by API level and mix the two, which is why `system`
// needs the re-tag below and why `low` — 87 of its 116 tools write — is
// granted to nobody.
const reader = resolveExposition(['MCP_Reader']);
const analyst = resolveExposition(['MCP_Analyst']);
const developer = resolveExposition(['MCP_Developer']);
const full = resolveExposition(['MCP_Full']);

describe('the boundary, exercised through the execution check', () => {
  it('lets a reader run system diagnostics', () => {
    for (const tool of [
      'GetPackageTree',
      'GetWhereUsed',
      'RuntimeGetDumpById',
    ]) {
      expect(() => assertToolAllowed(tool, 'system', reader)).not.toThrow();
    }
  });

  it('refuses a reader arbitrary ABAP execution', () => {
    // These live in the upstream `system` group but are re-tagged, because
    // running a program can change anything at all.
    for (const tool of Object.keys(SYSTEM_TOOLS_THAT_WRITE)) {
      const group = SYSTEM_TOOLS_THAT_WRITE[tool];
      expect(() => assertToolAllowed(tool, group, reader)).toThrow();
      expect(() => assertToolAllowed(tool, group, developer)).not.toThrow();
    }
  });

  it('refuses a reader the write groups', () => {
    expect(() => assertToolAllowed('CreateDomain', 'high', reader)).toThrow();
  });

  it('refuses EVERYONE a low-level tool: it is in no group', () => {
    const map = buildToolExpositionMap();
    for (const level of [reader, developer, full]) {
      expect(() =>
        assertToolAllowed(
          'DeletePackageLow',
          map.get('DeletePackageLow'),
          level,
        ),
      ).toThrow();
    }
  });

  it('re-tags every system write tool to a level a reader lacks', () => {
    for (const level of Object.values(SYSTEM_TOOLS_THAT_WRITE)) {
      expect(reader).not.toContain(level as ExpositionLevel);
    }
  });
});
