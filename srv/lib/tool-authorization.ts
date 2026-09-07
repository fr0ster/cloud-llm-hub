/**
 * Execution-time authorization for MCP tools.
 *
 * RAG exposition filtering decides which tools are OFFERED to the model. It is
 * a hint, not a control: the model can still ask for a tool by name — because
 * the user named it in the prompt, or because it remembers one — and until this
 * check existed, `invokeEmbeddedTool` would run it. The agent's handler map is
 * built from the full `HandlerExporter` set and cached per DESTINATION, not per
 * user, so nothing downstream knew who was asking.
 *
 * This is the control. A caller holding only `MCP_Reader` cannot execute a
 * create/modify tool, whatever the prompt says and whatever the model asks for.
 */

import type { ExpositionLevel } from './exposition';

/** Thrown when the caller's roles do not cover the tool's exposition group. */
export class ToolAuthorizationError extends Error {
  readonly statusCode = 403;
  readonly code = 'TOOL_FORBIDDEN';

  constructor(message: string) {
    super(message);
    this.name = 'ToolAuthorizationError';
  }
}

/**
 * Throw unless the caller may execute `toolName`.
 *
 * **Fail-closed on both unknowns.** An absent `allowed` means we could not tell
 * who is calling; an absent `toolExposition` means the tool is not in the map
 * that role checks are made of. Either way the answer is no — a tool that
 * nobody classified must not inherit access by being unclassified.
 *
 * @param toolName        Tool being invoked, for the message only.
 * @param toolExposition  The tool's group, from the tool→exposition map.
 * @param allowed         Exposition groups the caller's roles grant.
 */
export function assertToolAllowed(
  toolName: string,
  toolExposition: string | undefined,
  allowed: readonly ExpositionLevel[] | undefined,
): void {
  if (!allowed || allowed.length === 0) {
    throw new ToolAuthorizationError(
      `Tool "${toolName}" was not executed: the caller's permissions could not be determined. ` +
        'This request carries no MCP role.',
    );
  }

  if (!toolExposition) {
    throw new ToolAuthorizationError(
      `Tool "${toolName}" was not executed: it carries no exposition group, so no role can grant it.`,
    );
  }

  if (!allowed.includes(toolExposition as ExpositionLevel)) {
    throw new ToolAuthorizationError(
      `Tool "${toolName}" was not executed: it belongs to the "${toolExposition}" group and ` +
        `your roles grant only [${allowed.join(', ')}]. ` +
        'Asking for it by name does not grant it — a different MCP role is required.',
    );
  }
}
