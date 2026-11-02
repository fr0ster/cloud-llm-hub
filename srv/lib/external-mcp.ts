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
async function connectDestination(name: string): Promise<ExternalMcpClient> {
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
    const adapter = new McpClientAdapter(wrapper);
    return {
      // A fresh adapter per listing: the adapter caches its first discovery.
      listTools: (options) => new McpClientAdapter(wrapper).listTools(options),
      callTool: (name, args, options) => adapter.callTool(name, args, options),
      disconnect: () => wrapper.disconnect(),
    };
  } catch (error) {
    await wrapper.disconnect().catch(() => undefined);
    throw error;
  }
}
interface ExternalMcpClient extends IMcpClient {
  disconnect?(): Promise<void>;
}
interface Connection {
  client: ExternalMcpClient;
  active: number;
  retired: boolean;
  tools: McpTool[];
}
/** Live connections and ownership, never a tool-result or destination credential cache. */
export class ExternalMcp {
  private readonly connections = new Map<
    string,
    Promise<Connection | undefined>
  >();
  private readonly cached = new Map<string, Connection>();
  private readonly unhealthy = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly owners = new Map<
    string,
    { destination: string; tool: string }
  >();
  constructor(
    private readonly config: ExternalMcpConfig,
    private readonly reserved: () => Iterable<string>,
    private readonly connect: (
      destination: string,
    ) => Promise<ExternalMcpClient> = connectDestination,
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
  acceptsPolicyName(name: string): boolean {
    const destinations = this.destinations();
    // Raw names exist only with a single destination; otherwise all are prefixed.
    return (
      destinations.length > 0 &&
      ((destinations.length === 1 && !name.includes('__')) ||
        destinations.some(
          (destination) =>
            name.startsWith(`${destination}__`) &&
            name.length > destination.length + 2,
        ))
    );
  }
  private async disconnect(client: ExternalMcpClient): Promise<void> {
    try {
      await client.disconnect?.();
    } catch {
      /* Best-effort cleanup. */
    }
  }
  private retire(connection: Connection): void {
    if (connection.retired) return;
    connection.retired = true;
    if (connection.active === 0) void this.disconnect(connection.client);
  }
  private failed(destination: string): void {
    this.unhealthy.add(destination);
    this.retryAt.set(destination, this.now() + 30000);
    this.connections.delete(destination);
    this.warn('External docs MCP unavailable', { destination });
  }
  private connection(destination: string): Promise<Connection | undefined> {
    const existing = this.connections.get(destination);
    if (existing) return existing;
    if ((this.retryAt.get(destination) ?? 0) > this.now())
      return Promise.resolve(this.cached.get(destination));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let candidate: ExternalMcpClient | undefined;
    const previous = this.cached.get(destination);
    const pending = (async () => {
      try {
        const connection = await Promise.race([
          (async (): Promise<Connection> => {
            candidate =
              previous && !this.unhealthy.has(destination)
                ? previous.client
                : await this.connect(destination);
            if (expired) {
              await this.disconnect(candidate);
              throw new Error('Discovery timed out');
            }
            const listed = await candidate.listTools();
            if (!listed.ok) throw listed.error;
            return {
              client: candidate,
              tools: listed.value,
              active: 0,
              retired: false,
            };
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new Error('Discovery timed out'));
            }, 10000);
            timer.unref();
          }),
        ]);
        // Keep the activity counter when refreshing the same live client.
        if (previous?.client === connection.client) {
          previous.tools = connection.tools;
          this.cached.set(destination, previous);
        } else {
          this.cached.set(destination, connection);
          if (previous) this.retire(previous);
        }
        this.unhealthy.delete(destination);
        this.rebuildOwners();
        this.retryAt.set(destination, this.now() + 30000);
        return this.cached.get(destination);
      } catch {
        if (candidate) {
          if (previous?.client === candidate) this.retire(previous);
          else await this.disconnect(candidate);
        }
        this.failed(destination);
        return undefined;
      } finally {
        clearTimeout(timer);
        this.connections.delete(destination);
      }
    })();
    this.connections.set(destination, pending);
    return pending;
  }
  private destinations(): string[] {
    return [
      ...new Set(roles.flatMap((role) => this.config.roles[role])),
    ].sort();
  }
  private rebuildOwners(): void {
    const reserved = new Set(this.reserved());
    for (const destination of this.destinations()) {
      const connection = this.cached.get(destination);
      if (!connection) continue;
      for (const tool of connection.tools) {
        // Namespace all tools in multi-destination configurations before discovery
        // can reveal collisions. Reachability never participates in naming.
        const name =
          reserved.has(tool.name) || this.destinations().length > 1
            ? `${destination}__${tool.name}`
            : tool.name;
        // Assigned names remain owned for the process lifetime, even if removed.
        if (
          [...this.owners.values()].some(
            (owner) =>
              owner.destination === destination && owner.tool === tool.name,
          )
        )
          continue;
        // Reject ambiguous generated aliases as well as duplicate raw names.
        if (reserved.has(name) || this.owners.has(name)) continue;
        this.owners.set(name, { destination, tool: tool.name });
      }
    }
  }
  /** Start bounded discovery without delaying profile reads. */
  refresh(): void {
    for (const destination of this.destinations()) {
      if ((this.retryAt.get(destination) ?? 0) <= this.now()) {
        // Successful connections can be refreshed after the cooldown too.
        void this.connection(destination);
      }
    }
  }
  async clients(role: string): Promise<IMcpClient[]> {
    const selected = roles.find((value) => value === role);
    if (!selected) return [];
    await Promise.all(this.destinations().map((name) => this.connection(name)));
    const clients: IMcpClient[] = [];
    for (const destination of this.config.roles[selected]) {
      const connection = await this.connection(destination);
      if (!connection) continue;
      clients.push({
        cacheable: false,
        listTools: async () => ({
          ok: true,
          value: [...this.owners].flatMap(([name, owner]) => {
            if (owner.destination !== destination || !profileToolAllowed(name))
              return [];
            const tool = this.cached
              .get(destination)
              ?.tools.find((tool) => tool.name === owner.tool);
            return tool ? [{ ...tool, name }] : [];
          }),
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
          const live = this.cached.get(destination);
          if (!live || live.retired)
            return {
              ok: false,
              error: new McpError('External docs MCP unavailable'),
            };
          live.active++;
          try {
            const result = await live.client.callTool(
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
          } finally {
            live.active--;
            if (live.retired && live.active === 0)
              void this.disconnect(live.client);
          }
        },
      });
    }
    return clients;
  }
}
