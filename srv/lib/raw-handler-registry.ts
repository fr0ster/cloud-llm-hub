import {
  AbapGitHandlersGroup,
  BackgroundRunHandlersGroup,
  type BaseHandlerGroup,
  CompositeHandlersRegistry,
  DataHandlersGroup,
  HighLevelHandlersGroup,
  NoDedupStrategy,
  noConnectionContext,
  ReadOnlyHandlersGroup,
  RuntimeRunHandlersGroup,
  SearchHandlersGroup,
  SystemHandlersGroup,
} from '@mcp-abap-adt/lib/handlers';
import type { ExpositionLevel } from './exposition';
import { DATA_TOOL_EXPOSITIONS } from './tool-exposition-map';

export function rawHandlerRegistry(exposition: ExpositionLevel[]) {
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
  if (exposition.includes('high')) {
    groups.push(new AbapGitHandlersGroup(context));
  } else if (exposition.includes('readonly')) {
    groups.push(new AbapGitHandlersGroup(context, 'reads'));
  }
  if (exposition.includes('system'))
    groups.push(
      new SystemHandlersGroup(context),
      new RuntimeRunHandlersGroup(context),
      new BackgroundRunHandlersGroup(context),
    );
  if (exposition.includes('search'))
    groups.push(new SearchHandlersGroup(context));
  const data = new DataHandlersGroup(context);
  const dataEntries = data.getHandlers().filter(({ toolDefinition }) => {
    const level = DATA_TOOL_EXPOSITIONS.get(toolDefinition.name);
    return level !== undefined && exposition.includes(level);
  });
  if (dataEntries.length) {
    data.getHandlers = () => dataEntries;
    groups.push(data);
  }
  return new CompositeHandlersRegistry(groups);
}
