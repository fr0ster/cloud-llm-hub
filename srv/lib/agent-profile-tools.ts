import type {
  ISubAgent,
  ISubAgentInput,
  WorkerToolPolicy,
} from '@mcp-abap-adt/llm-agent';
import { hasProfileToolScope } from '../request-session';
import { profileToolPolicy } from './agent-profile-records';
import { ToolAuthorizationError } from './tool-authorization';

export interface RegisteredProfileTool {
  readonly name: string;
  readonly effect: 'read' | 'write';
}

/** The private set is copied at construction and never exposed to callers. */
export class AgentToolPermissions {
  private readonly names: ReadonlySet<string>;

  constructor(names: Iterable<string>) {
    this.names = new Set(names);
    Object.freeze(this);
  }

  allows(name: string): boolean {
    return this.names.has(name);
  }
}

/** Catalogue entries must come from trusted host registration, never MCP hints. */
export function effectiveProfileTools(input: {
  catalogue: readonly RegisteredProfileTool[];
  grants: ReadonlySet<string>;
  parent?: Pick<AgentToolPermissions, 'allows'>;
  result: 'report' | 'verdict';
  policy: WorkerToolPolicy;
}): AgentToolPermissions {
  const catalogue = new Map<string, RegisteredProfileTool>();
  for (const tool of input.catalogue) {
    if (catalogue.has(tool.name))
      throw new Error(`Ambiguous tool identity: ${tool.name}`);
    catalogue.set(tool.name, tool);
  }
  const parsed = profileToolPolicy.safeParse(input.policy);
  if (!parsed.success) throw new Error('Invalid profile tool policy');
  const policy = parsed.data;
  if (typeof policy === 'object') {
    for (const name of [...(policy.allow ?? []), ...(policy.deny ?? [])])
      if (!catalogue.has(name))
        throw new Error(
          `Unregistered policy tool: ${name}. Update the stored agents profile allow/deny policy against the registered catalogue; migrate legacy RAG operations to collection_create/record_add, record_update, record_set_enabled or paged collection_records/rag_read. Seeds never overwrite existing profiles.`,
        );
  }
  return new AgentToolPermissions(
    input.catalogue
      .filter(
        (tool) =>
          input.grants.has(tool.name) &&
          (!input.parent || input.parent.allows(tool.name)) &&
          (input.result !== 'verdict' || tool.effect === 'read') &&
          (policy !== 'read-only' || tool.effect === 'read') &&
          (typeof policy !== 'object' ||
            ((!policy.allow || policy.allow.includes(tool.name)) &&
              !policy.deny?.includes(tool.name))),
      )
      .map((tool) => tool.name),
  );
}

/** Today's client tools have no trusted host registration or execution guard. */
export function guardProfileWorker(worker: ISubAgent): ISubAgent {
  return {
    name: worker.name,
    description: worker.description,
    capabilities: worker.capabilities,
    run: async (input: ISubAgentInput) => {
      if (!hasProfileToolScope()) return worker.run(input);
      if (input.externalResults?.size)
        throw new ToolAuthorizationError(
          'Untrusted external result cannot resume an agent profile task',
        );
      const result = await worker.run({
        ...input,
        externalTools: [],
        externalResults: undefined,
      });
      if (
        result.status === 'awaiting-external' ||
        result.pendingExternalToolCalls?.length
      )
        throw new ToolAuthorizationError(
          'Untrusted external execution request forbidden for agent profile task',
        );
      return result;
    },
  };
}
