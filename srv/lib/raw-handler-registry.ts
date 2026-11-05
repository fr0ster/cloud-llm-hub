import {
  BackgroundRunHandlersGroup,
  type BaseHandlerGroup,
  CompositeHandlersRegistry,
  HighLevelHandlersGroup,
  isArgsOnly,
  NoDedupStrategy,
  noConnectionContext,
  ReadOnlyHandlersGroup,
  RuntimeRunHandlersGroup,
  SearchHandlersGroup,
  SystemHandlersGroup,
} from '@mcp-abap-adt/lib/handlers';
import { boundHandlerExporter } from './bound-handler-exporter';
import type { ExpositionLevel } from './exposition';
import type { SystemType } from './system-type';

type ToolArgument =
  | string
  | number
  | boolean
  | null
  | ToolArgument[]
  | {
      [key: string]: ToolArgument;
    };

export function rawHandlerRegistry(
  exposition: ExpositionLevel[],
  systemType: SystemType,
) {
  const context = noConnectionContext();
  const high = exposition.includes('high')
    ? [new HighLevelHandlersGroup(context)]
    : [];
  const overriding = new Set(
    high.flatMap((group) =>
      group.getHandlers().map((entry) => entry.toolDefinition.name),
    ),
  );
  const groups: BaseHandlerGroup[] = [];
  if (exposition.includes('readonly'))
    groups.push(
      new ReadOnlyHandlersGroup(context, overriding, new NoDedupStrategy()),
    );
  groups.push(...high);
  if (exposition.includes('system'))
    groups.push(
      new SystemHandlersGroup(context),
      new RuntimeRunHandlersGroup(context),
      new BackgroundRunHandlersGroup(context),
    );
  if (exposition.includes('search'))
    groups.push(new SearchHandlersGroup(context));
  const registry = new CompositeHandlersRegistry(groups);
  for (const group of registry.getHandlerGroups()) {
    const entries = group.getHandlers().map((entry) => {
      const schema: Record<string, object> = entry.toolDefinition.inputSchema;
      // lib 23 exposes no long-read metadata. Its schemas are either raw
      // Zod shapes or JSON Schemas with the arguments under properties.
      const hasTimeout =
        Object.hasOwn(schema, 'timeout') ||
        (schema.properties !== null &&
          typeof schema.properties === 'object' &&
          Object.hasOwn(schema.properties, 'timeout'));
      if (!hasTimeout) return entry;
      return {
        ...entry,
        handler: async (
          context: Parameters<typeof boundHandlerExporter>[0],
          args: Record<string, ToolArgument>,
        ) => {
          // lib 23 does not declare the system kind on injected long-read
          // connections. The exporter states it on the actual call connection.
          const exporter = boundHandlerExporter(context, { systemType });
          const handler = exporter
            .getHandlerEntries()
            .find(
              (candidate) =>
                candidate.toolDefinition.name === entry.toolDefinition.name,
            )?.handler;
          if (!handler)
            throw new Error(
              `Unknown long-read tool: ${entry.toolDefinition.name}`,
            );
          return isArgsOnly(handler) ? handler(args) : handler(context, args);
        },
      };
    });
    group.getHandlers = () => entries;
  }
  return registry;
}
