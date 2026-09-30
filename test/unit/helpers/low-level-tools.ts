import {
  HighLevelHandlersGroup,
  LowLevelHandlersGroup,
  ReadOnlyHandlersGroup,
  SearchHandlersGroup,
  SystemHandlersGroup,
} from '@mcp-abap-adt/lib/handlers';
import { toolNamesOf } from '../../../srv/lib/tool-exposition-map';

/**
 * Tools only the upstream low-level group carries — the ones the hub must
 * never serve. A name suffix is not enough: `GetVirtualFoldersLow` lives in
 * `system` too.
 */
export function lowLevelOnlyTools(): string[] {
  const ctx = {
    connection: null,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as ConstructorParameters<typeof ReadOnlyHandlersGroup>[0];
  const served = new Set(
    [
      new ReadOnlyHandlersGroup(ctx),
      new HighLevelHandlersGroup(ctx),
      new SearchHandlersGroup(ctx),
      new SystemHandlersGroup(ctx),
    ].flatMap((g) => toolNamesOf(g)),
  );
  return toolNamesOf(new LowLevelHandlersGroup(ctx)).filter(
    (t) => !served.has(t),
  );
}
