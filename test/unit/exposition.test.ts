import {
  describeCaller,
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
  const DEVELOPER = [...READER, 'high'];

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

  // The hub serves neither the low-level API nor the compact facade; no role
  // carries a level for them.
  it('grants neither `low` nor `compact` to any role', () => {
    const all: string[] = resolveExposition([...MCP_ROLES]);
    expect(all).not.toContain('low');
    expect(all).not.toContain('compact');
  });
});

// The failure this exists to make visible: a human holding every role
// collection reaches the server through a client_credentials client and lands
// on that CLIENT's single scope. CAP names such a caller `system` and derives
// roles from the token alone, so nothing about the human is knowable here.
describe('describeCaller', () => {
  const userWith = (id: string, ...roles: string[]) => ({
    id,
    is: (r: string) => roles.includes(r),
  });

  it('reports a human caller by id, roles and exposition', () => {
    const c = describeCaller(userWith('someone@example.com', 'MCP_Developer'));
    expect(c.id).toBe('someone@example.com');
    expect(c.technical).toBe(false);
    expect(c.roles).toEqual(['MCP_Developer']);
    expect(c.exposition).toContain('high');
  });

  it('marks a technical caller, whatever scope it happens to hold', () => {
    // CAP sets id 'system' and role 'system-user' for client_credentials.
    const c = describeCaller(userWith('system', 'system-user', 'MCP_Analyst'));
    expect(c.technical).toBe(true);
    expect(c.id).toBe('system');
    expect(c.roles).toEqual(['MCP_Analyst']);
    // Analyst is reader-level: no write groups, which is what "cannot find the
    // create tools" looks like from the consumer's side.
    expect(c.exposition).not.toContain('high');
  });

  it('denies an unauthenticated caller without throwing', () => {
    expect(describeCaller(undefined)).toEqual({
      id: 'anonymous',
      technical: false,
      roles: [],
      exposition: [],
    });
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
