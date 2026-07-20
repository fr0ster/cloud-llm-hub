import type { ExpositionLevel } from './exposition';

/**
 * Role-scope for each shipped executor skill.
 *
 * Skills are instruction TEXT injected into the executor's context, not callable
 * tools — but a WRITE skill (how to create/activate an object) handed to a
 * read-only caller is not harmless: the executor follows the skill, finds no
 * write tool (those are role-gated), and fabricates a success it never performed.
 * So a skill is gated by the SAME exposition as the tools it describes:
 *
 * - `creating-*` / `activating-*` / `enforcing-target-package` → `high`
 *   (the Create/Update/Activate tools they drive are `high` = MCP_Developer).
 * - `reading-*` → `readonly` (available to any MCP role).
 * - `reading-short-dumps` → `system` (dumps need MCP_Analyst, like RuntimeGetDumpById).
 *
 * `ExpositionFilteringRag.query` drops a tagged skill whose exposition the caller
 * lacks; an UNtagged skill (absent here) still passes through, preserving the
 * "instructions are harmless" default for any future/consumer skill.
 */
export const SKILL_EXPOSITIONS: Record<string, ExpositionLevel> = {
  // Write skills — gated to MCP_Developer (high).
  'creating-bdef': 'high',
  'creating-bimp': 'high',
  'creating-data-element': 'high',
  'creating-domain': 'high',
  'creating-draft-table': 'high',
  'creating-interface-cds-view': 'high',
  'creating-metadata-extension': 'high',
  'creating-persistent-table': 'high',
  'creating-projection-bdef': 'high',
  'creating-projection-cds-view': 'high',
  'creating-service-binding': 'high',
  'creating-service-definition': 'high',
  'activating-objects': 'high',
  'enforcing-target-package': 'high',
  // Read skills — available to any MCP role.
  'reading-bdef': 'readonly',
  'reading-draft-table': 'readonly',
  'reading-interface-cds-view': 'readonly',
  'reading-persistent-table': 'readonly',
  // Dump analysis — MCP_Analyst tier (same as RuntimeGetDumpById / GetDumpSection).
  'reading-short-dumps': 'system',
};
