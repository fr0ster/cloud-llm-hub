/**
 * MCP exposition level types and role-based resolution.
 */

export type ExpositionLevel =
  | 'readonly'
  | 'search'
  | 'system'
  | 'compact'
  | 'high'
  | 'low';

/**
 * Resolve MCP exposition groups based on user roles.
 *
 * Role hierarchy (each higher role includes all lower):
 * - MCP_Reader:    readonly + search
 * - MCP_Analyst:   + system
 * - MCP_Developer: + high (per-object granular CRUD)
 * - MCP_Full:      + compact (unified CRUD router, both sets available)
 *
 * Roles are additive — users with multiple roles get the union of tool sets.
 */
export function resolveExposition(userRoles: string[]): ExpositionLevel[] {
  const roles = new Set(userRoles);

  // Base: readonly + search for any authenticated user with MCP_Reader
  if (!roles.has('MCP_Reader')) {
    return [];
  }

  const exposition: ExpositionLevel[] = ['readonly', 'search'];

  if (roles.has('MCP_Analyst')) {
    exposition.push('system');
  }

  if (roles.has('MCP_Developer')) {
    exposition.push('high');
  }

  // MCP_Full adds compact on top of high — both sets available
  if (roles.has('MCP_Full')) {
    exposition.push('compact');
  }

  return exposition;
}
