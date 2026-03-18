import { resolveExposition } from '../../srv/lib/exposition';

describe('resolveExposition', () => {
  it('returns empty array for user without MCP_Reader role', () => {
    expect(resolveExposition([])).toEqual([]);
    expect(resolveExposition(['SomeOtherRole'])).toEqual([]);
  });

  it('returns readonly + search for MCP_Reader', () => {
    const result = resolveExposition(['MCP_Reader']);
    expect(result).toEqual(['readonly', 'search']);
  });

  it('adds system for MCP_Analyst', () => {
    const result = resolveExposition(['MCP_Reader', 'MCP_Analyst']);
    expect(result).toContain('readonly');
    expect(result).toContain('search');
    expect(result).toContain('system');
    expect(result).not.toContain('high');
    expect(result).not.toContain('compact');
  });

  it('adds high for MCP_Developer', () => {
    const result = resolveExposition([
      'MCP_Reader',
      'MCP_Analyst',
      'MCP_Developer',
    ]);
    expect(result).toContain('readonly');
    expect(result).toContain('search');
    expect(result).toContain('system');
    expect(result).toContain('high');
    expect(result).not.toContain('compact');
  });

  it('adds compact for MCP_Full', () => {
    const result = resolveExposition([
      'MCP_Reader',
      'MCP_Analyst',
      'MCP_Developer',
      'MCP_Full',
    ]);
    expect(result).toContain('readonly');
    expect(result).toContain('search');
    expect(result).toContain('system');
    expect(result).toContain('high');
    expect(result).toContain('compact');
  });

  it('MCP_Analyst without MCP_Reader gets nothing', () => {
    expect(resolveExposition(['MCP_Analyst'])).toEqual([]);
  });

  it('MCP_Developer without MCP_Reader gets nothing', () => {
    expect(resolveExposition(['MCP_Developer'])).toEqual([]);
  });

  it('combines Analyst + Developer roles additively', () => {
    const result = resolveExposition([
      'MCP_Reader',
      'MCP_Analyst',
      'MCP_Developer',
    ]);
    expect(result).toEqual(['readonly', 'search', 'system', 'high']);
  });

  it('MCP_Reader + MCP_Developer skips system without Analyst', () => {
    const result = resolveExposition(['MCP_Reader', 'MCP_Developer']);
    expect(result).toContain('readonly');
    expect(result).toContain('search');
    expect(result).toContain('high');
    expect(result).not.toContain('system');
  });

  it('never includes low', () => {
    const result = resolveExposition([
      'MCP_Reader',
      'MCP_Analyst',
      'MCP_Developer',
      'MCP_Full',
    ]);
    expect(result).not.toContain('low');
  });

  it('produces no duplicates with overlapping roles', () => {
    const result = resolveExposition([
      'MCP_Reader',
      'MCP_Analyst',
      'MCP_Developer',
      'MCP_Full',
      'MCP_Reader',
    ]);
    const unique = [...new Set(result)];
    expect(result).toEqual(unique);
  });
});
