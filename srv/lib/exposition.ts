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
 * Every MCP role, in one place.
 *
 * Each channel used to carry its own copy of this list, which is how
 * `/v1/messages` ended up with no role handling at all — there was nothing
 * central to notice was missing.
 */
export const MCP_ROLES = [
  'MCP_Reader',
  'MCP_Analyst',
  'MCP_Developer',
  'MCP_Full',
] as const;

/** Minimal shape of the CAP user object — `cds.context?.user`. */
export interface RoleBearer {
  is?: (role: string) => boolean;
}

/**
 * Exposition groups the given caller's roles grant.
 *
 * Returns `[]` for a caller with no MCP role, which every consumer must treat
 * as "deny" — see `assertToolAllowed`.
 */
export function resolveExpositionForUser(
  user: RoleBearer | undefined,
): ExpositionLevel[] {
  return resolveExposition(
    MCP_ROLES.filter((role) => user?.is?.(role) ?? false),
  );
}

/**
 * Tools that the upstream `system` group carries but that CHANGE the system.
 *
 * The upstream groups are cut by API LEVEL, not by effect: `system` is mostly
 * diagnostics (structure, where-used, dumps, profiler data) but also carries
 * arbitrary ABAP execution. Since the role boundary here is "does it change
 * anything", these are re-tagged to `high` so they land with the write tools
 * where they belong.
 *
 * `RuntimeCreateProfilerTraceParameters` is included deliberately: it only
 * configures a trace, but it is a POST that leaves state behind, and the rule
 * for anything uncertain is the restrictive side.
 */
export const SYSTEM_TOOLS_THAT_WRITE: Readonly<
  Record<string, ExpositionLevel>
> = {
  RuntimeRunClass: 'high',
  RuntimeRunProgram: 'high',
  RuntimeRunClassWithProfiling: 'high',
  RuntimeRunProgramWithProfiling: 'high',
  RuntimeCreateProfilerTraceParameters: 'high',
};

/**
 * Resolve MCP exposition groups based on user roles.
 *
 * **Two levels, split by effect, not by API level:**
 *
 * - **Reader** — everything that changes nothing: `readonly`, `search` and
 *   `system` (minus {@link SYSTEM_TOOLS_THAT_WRITE}, re-tagged to `high`).
 * - **Developer** — Reader plus everything that changes something: `high` and
 *   `compact`.
 *
 * `low` is granted to NOBODY. It is the low-level write API — 87 of its 116
 * tools create, update, delete or lock — and nothing needs it today. It stays
 * in {@link ExpositionLevel} so a tool carrying it is classified (and therefore
 * refused) rather than unclassified.
 *
 * The four XSUAA roles map onto the two levels rather than being removed, so
 * nobody already assigned a collection loses access:
 *
 * | Role          | Level     |
 * |---------------|-----------|
 * | MCP_Reader    | Reader    |
 * | MCP_Analyst   | Reader    |
 * | MCP_Developer | Developer |
 * | MCP_Full      | Developer |
 *
 * Note this widens Reader (it now reaches `system` diagnostics such as dumps
 * and `GetSqlQuery`) and narrows MCP_Full (it no longer reaches `low`).
 *
 * Roles are additive — the union of whatever the caller holds.
 */
export function resolveExposition(userRoles: string[]): ExpositionLevel[] {
  const roles = new Set(userRoles);

  const hasAnyMcpRole = MCP_ROLES.some((role) => roles.has(role));
  if (!hasAnyMcpRole) return [];

  // Reader: everything that changes nothing.
  const exposition: ExpositionLevel[] = ['readonly', 'search', 'system'];

  // Developer: everything that changes something.
  if (roles.has('MCP_Developer') || roles.has('MCP_Full')) {
    exposition.push('high', 'compact');
  }

  return exposition;
}
