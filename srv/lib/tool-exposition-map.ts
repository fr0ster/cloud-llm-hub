/**
 * The tool → exposition-group map: the table every role check is made of.
 *
 * Built from the upstream handler groups, then corrected where those groups do
 * not match the boundary we actually enforce. The upstream split is by API
 * LEVEL; ours is by EFFECT (does the tool change anything). They agree for most
 * tools, which is why the groups are the starting point rather than a hand
 * list — but where they disagree, the overrides win.
 *
 * Extracted from `agent-manager` so it can be exercised without booting CAP:
 * the map is a security artefact and needs tests of its own.
 */

import {
  CompactHandlersGroup,
  HighLevelHandlersGroup,
  LowLevelHandlersGroup,
  ReadOnlyHandlersGroup,
  SearchHandlersGroup,
  SystemHandlersGroup,
} from '@mcp-abap-adt/core/handlers';
import type { ExpositionLevel } from './exposition';
import { SYSTEM_TOOLS_THAT_WRITE } from './exposition';

/** Minimal logger the handler groups need to be constructed. */
export interface QuietLogger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
  debug(...a: unknown[]): void;
}

const NOOP_LOGGER: QuietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/** The upstream groups, in the order that decides ties. */
export const HANDLER_GROUPS: readonly ExpositionLevel[] = [
  'readonly',
  'high',
  'search',
  'system',
  'compact',
  'low',
] as const;

/**
 * Build the map. Pure: no network, no connection — the groups are constructed
 * with a null connection purely to enumerate their tool names.
 *
 * A tool present in several groups keeps the FIRST group that claimed it, which
 * is why {@link HANDLER_GROUPS} order matters.
 */
export function buildToolExpositionMap(
  cloudLocalExpositions: Record<string, string> = {},
  logger: QuietLogger = NOOP_LOGGER,
): Map<string, ExpositionLevel> {
  const ctx = {
    connection: null,
    logger,
  } as unknown as ConstructorParameters<typeof ReadOnlyHandlersGroup>[0];

  const groups: Array<{ name: ExpositionLevel; group: HandlerGroupLike }> = [
    { name: 'readonly', group: new ReadOnlyHandlersGroup(ctx) },
    { name: 'high', group: new HighLevelHandlersGroup(ctx) },
    { name: 'search', group: new SearchHandlersGroup(ctx) },
    { name: 'system', group: new SystemHandlersGroup(ctx) },
    { name: 'compact', group: new CompactHandlersGroup(ctx) },
    { name: 'low', group: new LowLevelHandlersGroup(ctx) },
  ];

  const map = new Map<string, ExpositionLevel>();
  for (const { name, group } of groups) {
    for (const tool of toolNamesOf(group)) {
      if (!map.has(tool)) map.set(tool, name);
    }
  }

  // Tools this codebase adds itself.
  for (const [tool, level] of Object.entries(cloudLocalExpositions)) {
    map.set(tool, level as ExpositionLevel);
  }

  // Corrections where the upstream group does not match the effect.
  for (const [tool, level] of Object.entries(SYSTEM_TOOLS_THAT_WRITE)) {
    if (map.has(tool)) map.set(tool, level);
  }

  return map;
}

/** Shape we need from a handler group — just its tool names. */
export interface HandlerGroupLike {
  getHandlers(): Array<{
    toolDefinition?: { name?: string };
    definition?: { name?: string };
  }>;
}

/** Tool names a group exposes, in declaration order. */
export function toolNamesOf(group: HandlerGroupLike): string[] {
  return group
    .getHandlers()
    .map((h) => h.toolDefinition?.name ?? h.definition?.name ?? '')
    .filter((n): n is string => n.length > 0);
}
