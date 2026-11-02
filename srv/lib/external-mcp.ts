import {
  type IMcpClient,
  McpError,
  type McpTool,
  normalizeTrust,
  type ToolTrust,
} from '@mcp-abap-adt/llm-agent';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import cds from '@sap/cds';
import { buildHeadersForDestination } from '@sap-cloud-sdk/connectivity';
import { resolveHttpDestination } from '../connections/destinationResolver';
import { profileToolAllowed } from '../request-session';
import { BuildValidationError } from './build-validation-error';
import type { TrustResolver } from './trust-resolver';

const roles = ['planner', 'executor', 'checker', 'analyst'] as const;
export type ExternalMcpRole = (typeof roles)[number];
export interface ExternalMcpConfig {
  roles: Record<ExternalMcpRole, string[]>;
  trust: Record<string, number>;
}
export function parseExternalMcp(env: NodeJS.ProcessEnv): ExternalMcpConfig {
  const list = (value: string | undefined): string[] => [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ];
  // Explicit names keep the variables discoverable (docs check, grep).
  const result: ExternalMcpConfig = {
    roles: {
      planner: list(env.LLM_AGENT_PLANNER_MCP),
      executor: list(env.LLM_AGENT_EXECUTOR_MCP),
      checker: list(env.LLM_AGENT_CHECKER_MCP),
      analyst: list(env.LLM_AGENT_ANALYST_MCP),
    } satisfies Record<ExternalMcpRole, string[]>,
    trust: {},
  };
  if (env.LLM_AGENT_MCP_TRUST !== undefined)
    for (const entry of env.LLM_AGENT_MCP_TRUST.split(',')) {
      const [destination, raw, extra] = entry.split('=').map((s) => s.trim());
      const trust = raw ? normalizeTrust(Number(raw)) : undefined;
      if (!destination || extra !== undefined || trust === undefined)
        throw new BuildValidationError(
          `Invalid LLM_AGENT_MCP_TRUST entry: ${entry}`,
        );
      result.trust[destination] = trust;
    }
  return result;
}
async function connectDestination(name: string): Promise<IMcpClient> {
  const destination = await resolveHttpDestination(name);
  if (destination.proxyType === 'OnPremise')
    throw new Error('Docs MCP requires an Internet destination');
  const wrapper = new MCPClientWrapper({
    name,
    transport: 'stream-http',
    url: destination.url,
    headers: await buildHeadersForDestination(destination),
    timeout: 10000,
  });
  try {
    await wrapper.connect();
    return new McpClientAdapter(wrapper);
  } catch (error) {
    await wrapper.disconnect().catch(() => undefined);
    throw error;
  }
}
interface Connection {
  client: IMcpClient;
  tools: McpTool[];
}
/** Live connections and ownership, never a tool-result or destination credential cache. */
export class ExternalMcp {
  private readonly connections = new Map<
    string,
    Promise<Connection | undefined>
  >();
  private readonly retryAt = new Map<string, number>();
  private readonly owners = new Map<
    string,
    { destination: string; tool: string }
  >();
  constructor(
    private readonly config: ExternalMcpConfig,
    private readonly reserved: () => Iterable<string>,
    private readonly connect = connectDestination,
    private readonly warn = (
      message: string,
      detail: { destination: string },
    ) => cds.log('external-mcp').warn(message, detail),
    private readonly now = Date.now,
  ) {}
  catalogue(role?: ExternalMcpRole): { name: string; effect: 'read' }[] {
    return [...this.owners]
      .filter(
        ([, owner]) =>
          !role || this.config.roles[role].includes(owner.destination),
      )
      .map(([name]) => ({ name, effect: 'read' }));
  }
  owns(name: string): boolean {
    return this.owners.has(name);
  }
  toolTrust(name: string, resolver: TrustResolver): ReturnType<ToolTrust> {
    const owner = this.owners.get(name);
    return owner
      ? {
          source: `docs:${owner.tool}`,
          trust:
            this.config.trust[owner.destination] ??
            resolver.classDefault('docs'),
        }
      : undefined;
  }
  private failed(destination: string): void {
    this.retryAt.set(destination, this.now() + 30000);
    this.connections.delete(destination);
    this.warn('External docs MCP unavailable', { destination });
  }
  private connection(destination: string): Promise<Connection | undefined> {
    const existing = this.connections.get(destination);
    if (existing) return existing;
    if ((this.retryAt.get(destination) ?? 0) > this.now())
      return Promise.resolve(undefined);
    const pending = (async () => {
      try {
        const client = await this.connect(destination);
        const listed = await client.listTools();
        if (!listed.ok) throw listed.error;
        const reserved = new Set(this.reserved());
        const staged = new Map<string, { destination: string; tool: string }>();
        const tools = listed.value.map((tool) => {
          let name = tool.name;
          if (
            reserved.has(name) ||
            (this.owners.has(name) &&
              this.owners.get(name)?.destination !== destination)
          )
            name = `${destination}__${name}`;
          if (
            reserved.has(name) ||
            (this.owners.has(name) &&
              this.owners.get(name)?.destination !== destination)
          )
            throw new Error('Ambiguous external MCP tool');
          if (staged.has(name)) throw new Error('Duplicate external MCP tool');
          staged.set(name, { destination, tool: tool.name });
          return { ...tool, name };
        });
        for (const [name, owner] of staged) this.owners.set(name, owner);
        return { client, tools };
      } catch {
        this.retryAt.set(destination, this.now() + 30000);
        this.connections.delete(destination);
        this.warn('External docs MCP unavailable', { destination });
        return undefined;
      }
    })();
    this.connections.set(destination, pending);
    return pending;
  }
  async clients(role: string): Promise<IMcpClient[]> {
    const selected = roles.find((value) => value === role);
    if (!selected) return [];
    const clients: IMcpClient[] = [];
    for (const destination of this.config.roles[selected]) {
      const connection = await this.connection(destination);
      if (!connection) continue;
      clients.push({
        cacheable: false,
        listTools: async () => ({
          ok: true,
          value: connection.tools.filter((t) => profileToolAllowed(t.name)),
        }),
        callTool: async (name, args, options) => {
          const owner = this.owners.get(name);
          if (
            !owner ||
            owner.destination !== destination ||
            !profileToolAllowed(name)
          )
            return {
              ok: false,
              error: new McpError('External docs tool forbidden'),
            };
          try {
            const result = await connection.client.callTool(
              owner.tool,
              args,
              options,
            );
            if (!result.ok) this.failed(destination);
            return result;
          } catch {
            this.failed(destination);
            return {
              ok: true,
              value: {
                isError: true,
                content: 'External docs MCP unavailable',
              },
            };
          }
        },
      });
    }
    return clients;
  }
}
