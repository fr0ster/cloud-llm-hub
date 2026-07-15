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
 * - MCP_Analyst:   readonly + search + system
 * - MCP_Developer: readonly + search + system + high
 * - MCP_Full:      readonly + search + system + high + compact
 *
 * Any MCP_* role grants at least readonly + search as base.
 * Roles are additive — users with multiple roles get the union of tool sets.
 */
export function resolveExposition(userRoles: string[]): ExpositionLevel[] {
  const roles = new Set(userRoles);

  // Any MCP role grants base access
  const hasMcpRole =
    roles.has('MCP_Reader') ||
    roles.has('MCP_Analyst') ||
    roles.has('MCP_Developer') ||
    roles.has('MCP_Full');

  if (!hasMcpRole) return [];

  // Base: readonly + search for any MCP role
  const exposition: ExpositionLevel[] = ['readonly', 'search'];

  // Analyst adds system; Developer includes Analyst level
  if (
    roles.has('MCP_Analyst') ||
    roles.has('MCP_Developer') ||
    roles.has('MCP_Full')
  ) {
    exposition.push('system');
  }

  // Developer adds high; Full includes Developer level
  if (roles.has('MCP_Developer') || roles.has('MCP_Full')) {
    exposition.push('high');
  }

  // Full adds compact + low (the low-level generic handlers, opt-in via
  // LLM_AGENT_INCLUDE_LOW_LEVEL — only the highest role may reach them).
  if (roles.has('MCP_Full')) {
    exposition.push('compact');
    exposition.push('low');
  }

  return exposition;
}
