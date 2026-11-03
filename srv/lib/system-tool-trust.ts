import type { ToolTrust } from '@mcp-abap-adt/llm-agent';
import type { TrustResolver } from './trust-resolver';

/** Registry membership, never a name heuristic or the exposed hub catalogue. */
export function systemToolTrust(
  isSystemTool: (name: string) => boolean,
  resolver: TrustResolver,
): ToolTrust {
  return (name) =>
    isSystemTool(name)
      ? { source: `target:${name}`, trust: resolver.systemTool(name) }
      : undefined;
}
