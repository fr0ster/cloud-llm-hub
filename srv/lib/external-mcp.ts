import {
  type IMcpClient,
  type IRag,
  type IRetrievalEmbedder,
  McpError,
  type McpTool,
  normalizeTrust,
  type RagResult,
  type ToolTrust,
  type WorkerProfileSummary,
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
export type McpSelection = 'direct' | 'rag' | 'auto';
export interface ExternalMcpConfig {
  selection?: Record<string, McpSelection>;
  directMax?: number;
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
  if (env.LLM_AGENT_MCP_TRUST?.trim())
    for (const entry of env.LLM_AGENT_MCP_TRUST.split(',')) {
      const [destination, raw, extra] = entry.split('=').map((s) => s.trim());
      const trust = raw ? normalizeTrust(Number(raw)) : undefined;
      if (!destination || extra !== undefined || trust === undefined)
        throw new BuildValidationError(
          `Invalid LLM_AGENT_MCP_TRUST entry: ${entry}`,
        );
      result.trust[destination] = trust;
    }
  result.selection = {};
  for (const entry of list(env.LLM_AGENT_MCP_SELECTION)) {
    const [destination, mode, extra] = entry.split('=').map((s) => s.trim());
    if (
      !destination ||
      extra !== undefined ||
      (mode !== 'direct' && mode !== 'rag' && mode !== 'auto')
    )
      throw new BuildValidationError(
        `Invalid LLM_AGENT_MCP_SELECTION entry: ${entry}`,
      );
    result.selection[destination] = mode;
  }
  const rawMax = env.LLM_AGENT_MCP_DIRECT_MAX?.trim();
  const max = Number(rawMax);
  result.directMax = 12;
  if (rawMax) {
    if (Number.isSafeInteger(max) && max > 0) result.directMax = max;
    else
      cds
        .log('external-mcp')
        .warn('Invalid LLM_AGENT_MCP_DIRECT_MAX; using 12');
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
    // The MCP SDK requires a positive timeout; its library safety net applies.
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
  private readonly vectors = new Map<
    string,
    { destination: string; text: string; vector: number[] }
  >();
  constructor(
    private readonly config: ExternalMcpConfig,
    private readonly reserved: () => Iterable<string>,
    private readonly connect: (
      destination: string,
    ) => Promise<ExternalMcpClient> = connectDestination,
    private readonly warn = (
      message: string,
      detail?: { destination: string },
    ) => cds.log('external-mcp').warn(message, detail),
    private readonly now = Date.now,
    private readonly embedder?: () => IRetrievalEmbedder | undefined,
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
    const connection = this.cached.get(destination);
    if (connection) this.retire(connection);
    this.cached.delete(destination);
    this.rebuildOwners();
    this.retryAt.set(destination, this.now() + 30000);
    this.connections.delete(destination);
    this.warn('External docs MCP unavailable', { destination });
  }
  private connection(destination: string): Promise<Connection | undefined> {
    const existing = this.connections.get(destination);
    if (existing) return existing;
    if ((this.retryAt.get(destination) ?? 0) > this.now())
      return Promise.resolve(this.cached.get(destination));
    // Background discovery has no caller signal and never blocks profiles.
    // Release hung discovery or indexing after ten minutes and log a warning.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let indexing = false;
    const controller = new AbortController();
    let candidate: ExternalMcpClient | undefined;
    const previous = this.cached.get(destination);
    const pending = (async () => {
      try {
        await Promise.race([
          (async (): Promise<void> => {
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
            const connection: Connection = {
              client: candidate,
              tools: listed.value,
              active: 0,
              retired: false,
            };
            controller.signal.throwIfAborted();
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
            indexing = true;
            await this.indexDestination(destination, controller.signal);
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new Error('Discovery timed out'));
              controller.abort();
            }, 600_000);
            timer.unref();
          }),
        ]);
        cds.log('external-mcp').info('External docs MCP connected', {
          destination,
          mode: this.mode(destination),
          tools: this.available()
            .filter(([, owner]) => owner.destination === destination)
            .map(([name]) => name),
        });
        this.retryAt.set(destination, this.now() + 30000);
        return this.cached.get(destination);
      } catch {
        if (indexing) {
          for (const [name, entry] of this.vectors) {
            if (entry.destination === destination) this.vectors.delete(name);
          }
          this.warn('External docs MCP indexing unavailable; no docs hits', {
            destination,
          });
          this.retryAt.set(destination, this.now() + 30000);
          return this.cached.get(destination);
        }
        if (candidate && this.cached.get(destination)?.client !== candidate) {
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
    this.owners.clear();
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
        // Skip duplicate tool names returned by a destination.
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
  mode(destination: string): 'direct' | 'rag' {
    const mode = this.config.selection?.[destination] ?? 'auto';
    return mode === 'auto'
      ? (this.cached.get(destination)?.tools.length ?? 0) <=
        (this.config.directMax ?? 12)
        ? 'direct'
        : 'rag'
      : mode;
  }
  private available(role?: string) {
    return [...this.owners].filter(([, owner]) => {
      const connection = this.cached.get(owner.destination);
      return (
        connection &&
        !connection.retired &&
        (!role ||
          roles.some(
            (r) =>
              r === role && this.config.roles[r].includes(owner.destination),
          ))
      );
    });
  }
  private async indexDestination(
    destination: string,
    signal: AbortSignal,
  ): Promise<void> {
    const entries = this.available().filter(
      ([, owner]) => owner.destination === destination,
    );
    const texts = entries.map(([name, owner]) => {
      const tool = this.cached
        .get(destination)
        ?.tools.find((tool) => tool.name === owner.tool);
      return { name, text: `Tool: ${name} \u2014 ${tool?.description ?? ''}` };
    });
    if (this.mode(destination) !== 'rag') {
      for (const [name, entry] of this.vectors) {
        if (entry.destination === destination) this.vectors.delete(name);
      }
      return;
    }
    const previous = [...this.vectors.values()].filter(
      (entry) => entry.destination === destination,
    );
    if (
      previous.length === texts.length &&
      texts.every(({ name, text }) => this.vectors.get(name)?.text === text)
    )
      return;
    const embedder = this.embedder?.();
    if (!embedder) throw new Error('Docs MCP RAG requires an embedder');
    const indexed = await Promise.all(
      texts.map(async ({ name, text }) => ({
        name,
        destination,
        text,
        vector: (await embedder.embedDocument(text, { signal })).vector,
      })),
    );
    signal.throwIfAborted();
    // Publish one destination atomically; other destinations retain their vectors.
    for (const [name, entry] of this.vectors) {
      if (entry.destination === destination) this.vectors.delete(name);
    }
    for (const entry of indexed) this.vectors.set(entry.name, entry);
  }
  toolNames(role: string): string[] {
    return this.available(role).map(([name]) => name);
  }
  describeWorkers(workers: WorkerProfileSummary[]): WorkerProfileSummary[] {
    return workers.map((worker) => {
      const tools = this.toolNames(worker.name);
      if (!tools.length) return worker;
      const names = tools.slice(0, 12).join(', ').slice(0, 600);
      return {
        ...worker,
        description: `${worker.description} Can search external documentation (${names}${tools.length > 12 || names.length === 600 ? ', ...' : ''}).`,
      };
    });
  }
  withToolsRag(rag: IRag, role: string): IRag {
    return new Proxy(rag, {
      get: (target, prop) => {
        if (prop === 'query')
          return async (...args: Parameters<IRag['query']>) => {
            const result = await target.query(...args);
            if (!result.ok) return result;
            const direct: RagResult[] = [];
            const ranked: RagResult[] = [];
            let vector: number[] | undefined;
            if (
              this.available(role).some(
                ([name, owner]) =>
                  this.mode(owner.destination) === 'rag' &&
                  this.vectors.has(name),
              )
            ) {
              try {
                // No artificial deadline: work stops only via the caller's abort.
                vector = (
                  await this.embedder?.()?.embedQuery(args[0].text, args[2])
                )?.vector;
                if (!vector?.length)
                  throw new Error('Missing docs query vector');
              } catch {
                vector = undefined;
                this.warn(
                  'External docs MCP query embedding unavailable; no RAG docs hits',
                );
              }
            }
            for (const [name, owner] of this.available(role)) {
              if (!profileToolAllowed(name)) continue;
              const record = {
                text: `Tool: ${name}`,
                metadata: { id: `tool:${name}`, name },
                score: 1,
              };
              if (this.mode(owner.destination) === 'direct')
                direct.push(record);
              else {
                const entry = this.vectors.get(name);
                if (!entry || !vector) continue;
                const dot = entry.vector.reduce(
                  (sum, value, i) => sum + value * (vector[i] ?? 0),
                  0,
                );
                const norm =
                  Math.hypot(...entry.vector) * Math.hypot(...vector);
                ranked.push({
                  ...record,
                  text: entry.text,
                  score: norm ? dot / norm : 0,
                });
              }
            }
            const hits = ranked
              .sort((a, b) => b.score - a.score)
              .slice(0, args[1]);
            return {
              ok: true as const,
              value: [...result.value, ...hits, ...direct],
            };
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  /** Start discovery without delaying profile reads. */
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
    await Promise.all(
      this.destinations().map((name) => {
        const cached = this.cached.get(name);
        const pending = this.connection(name);
        return cached && !cached.retired ? undefined : pending;
      }),
    );
    const clients: IMcpClient[] = [];
    for (const destination of this.config.roles[selected]) {
      const connection = this.cached.get(destination);
      if (!connection || connection.retired) continue;
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
