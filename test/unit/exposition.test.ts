import {
  MCP_ROLES,
  resolveExposition,
  resolveExpositionForUser,
} from '../../srv/lib/exposition';

// Two levels, split by EFFECT rather than by the upstream group's API level:
// Reader gets everything that changes nothing, Developer adds everything that
// changes something. The four XSUAA roles map onto those two so that nobody
// already assigned a role collection loses access.
describe('resolveExposition', () => {
  const READER = ['readonly', 'search', 'system'];
  const DEVELOPER = [...READER, 'high', 'compact'];

  const sorted = (v: string[]) => [...v].sort();

  it('gives nothing to a caller without an MCP role', () => {
    expect(resolveExposition([])).toEqual([]);
    expect(resolveExposition(['SomeOtherRole'])).toEqual([]);
  });

  it.each([
    ['MCP_Reader', READER],
    ['MCP_Analyst', READER],
    ['MCP_Developer', DEVELOPER],
    ['MCP_Full', DEVELOPER],
  ])('%s resolves to its level', (role, expected) => {
    expect(sorted(resolveExposition([role]))).toEqual(sorted(expected));
  });

  it('is additive — the union of whatever the caller holds', () => {
    expect(sorted(resolveExposition(['MCP_Reader', 'MCP_Developer']))).toEqual(
      sorted(DEVELOPER),
    );
  });

  it('produces no duplicates with overlapping roles', () => {
    const result = resolveExposition([...MCP_ROLES]);
    expect(new Set(result).size).toBe(result.length);
  });

  // `low` is the low-level write API — 87 of its 116 tools create, update,
  // delete or lock. Nothing needs it today, so no role carries it. It stays a
  // known level so a tool tagged `low` is classified, and therefore refused,
  // rather than unclassified.
  it('grants `low` to no role', () => {
    for (const role of MCP_ROLES) {
      expect(resolveExposition([role])).not.toContain('low');
    }
    expect(resolveExposition([...MCP_ROLES])).not.toContain('low');
  });
});

describe('resolveExpositionForUser', () => {
  const userWith = (...roles: string[]) => ({
    is: (r: string) => roles.includes(r),
  });

  it('reads the roles off the CAP user', () => {
    expect(
      sortedLevels(resolveExpositionForUser(userWith('MCP_Developer'))),
    ).toEqual(sortedLevels(resolveExposition(['MCP_Developer'])));
  });

  it('denies a user with no roles, and an absent user', () => {
    expect(resolveExpositionForUser(userWith())).toEqual([]);
    expect(resolveExpositionForUser(undefined)).toEqual([]);
    // A user object without `is` at all — mocked auth, or a malformed context.
    expect(resolveExpositionForUser({})).toEqual([]);
  });
});

function sortedLevels(v: string[]): string[] {
  return [...v].sort();
}
