import { randomUUID } from 'node:crypto';
import {
  type IMcpClient,
  McpError,
  type McpToolResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { z } from 'zod';
import {
  userMcpToolName,
  validUserMcpServer,
  validUserMcpTool,
} from './user-mcp-names';

export const userMcpTransport = z.enum(['browser', 'companion']);
type Transport = z.infer<typeof userMcpTransport>;
export const userMcpServerName = z
  .string()
  .refine(validUserMcpServer, 'Invalid or reserved server name');
const jsonObject = z.record(z.string(), z.json());
export const userMcpRoles = ['analyst', 'executor', 'checker'] as const;
const toolSchema = z.strictObject({
  name: z.string().refine(validUserMcpTool, 'Invalid or reserved tool name'),
  description: z.string(),
  inputSchema: z.object({ type: z.literal('object') }).catchall(z.json()),
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
    })
    .catchall(z.json())
    .optional(),
});
const serverSchema = z
  .strictObject({
    name: userMcpServerName,
    transport: userMcpTransport,
    roles: z
      .array(
        z.enum(
          userMcpRoles,
          'User MCP roles must be analyst, executor, or checker',
        ),
      )
      .default([...userMcpRoles]),
    writes: z.boolean().default(false),
    tools: z.array(toolSchema),
  })
  .refine(
    ({ tools }) =>
      new Set(tools.map((tool) => tool.name)).size === tools.length,
    {
      path: ['tools'],
      message: 'Duplicate tool names',
    },
  );
export const userMcpRegistration = z
  .strictObject({ servers: z.array(serverSchema).min(1) })
  .refine(
    ({ servers }) =>
      new Set(servers.map((server) => server.name)).size === servers.length,
    { path: ['servers'], message: 'Duplicate server names' },
  );
const mcpResult = z
  .object({
    content: z
      .union([
        z.string(),
        jsonObject,
        z.array(
          z
            .object({ type: z.string(), text: z.string().optional() })
            .catchall(z.json()),
        ),
      ])
      .optional(),
    structuredContent: jsonObject.optional(),
    isError: z.boolean().optional(),
  })
  .refine(
    ({ content, structuredContent }) =>
      content !== undefined || structuredContent !== undefined,
  );
export const userMcpReply = z.union([
  z.strictObject({ result: mcpResult }),
  z.strictObject({ outcome: z.literal('unknown') }),
  z.strictObject({
    error: z.union([
      z.string(),
      z.strictObject({
        message: z.string(),
        code: z.union([z.string(), z.number()]).optional(),
      }),
    ]),
  }),
]);

type Reply = z.infer<typeof userMcpReply>;
type Registration = z.infer<typeof serverSchema>;
type CallResult = Result<McpToolResult, McpError>;
export interface UserMcpTool {
  readonly server: Registration;
  readonly definition: z.infer<typeof toolSchema>;
  readonly name: string;
  readonly effect: 'read' | 'write';
  vector?: number[];
}

export interface UserMcpCall {
  callId: string;
  server: string;
  tool: string;
  arguments: Parameters<IMcpClient['callTool']>[1];
  replay?: true;
}
interface PendingCall {
  event: UserMcpCall;
  executor: string;
  generation: symbol;
  role?: string;
  effect: UserMcpTool['effect'];
  delivered: boolean;
  finish(result: CallResult, resultBytes?: number): void;
}
interface RegisteredServer {
  generation: symbol;
  tools: UserMcpTool[];
}
interface ExecutorStream {
  send(event: UserMcpCall): boolean;
  close(): void;
}

function executorKey(transport: Transport, server: string): string {
  return `user-mcp:${transport}:${server}`;
}

function failed(code: string, message: string): CallResult {
  return { ok: false, error: new McpError(`${code}: ${message}`, code) };
}

function outcomeUnknown(): CallResult {
  return failed(
    'USER_MCP_OUTCOME_UNKNOWN',
    'The write may or may not have been applied',
  );
}

/** Volatile state for one live LongSession object. */
export class UserMcpBridge {
  private readonly servers = new Map<string, RegisteredServer>();
  private readonly executors = new Map<string, ExecutorStream>();
  private readonly streams = new Set<ExecutorStream>();
  private readonly pending = new Map<string, PendingCall>();
  private closed = false;

  register(registrations: Registration[]): void {
    if (this.closed) return;
    for (const server of registrations) {
      const tools = server.tools.flatMap((definition): UserMcpTool[] => {
        const read =
          definition.annotations?.readOnlyHint === true &&
          definition.annotations.destructiveHint !== true;
        return read || server.writes
          ? [
              {
                server,
                definition,
                name: userMcpToolName(server.name, definition.name),
                effect: read ? 'read' : 'write',
              },
            ]
          : [];
      });
      this.servers.set(server.name, { generation: Symbol(), tools });
    }
    this.revokeDisallowedCalls();
  }

  unregister(server?: string): void {
    if (server === undefined) this.servers.clear();
    else this.servers.delete(server);
    this.revokeDisallowedCalls();
  }

  private revokeDisallowedCalls(): void {
    for (const call of this.pending.values()) {
      const { server, tool } = call.event;
      const current = this.servers.get(server);
      if (current?.generation === call.generation) continue;
      // A compatible replacement keeps the call and its dispatch generation.
      if (
        current?.tools.some(
          (entry) =>
            entry.definition.name === tool &&
            entry.effect === call.effect &&
            (call.role === undefined ||
              entry.server.roles.some((role) => role === call.role)) &&
            executorKey(entry.server.transport, server) === call.executor,
        )
      )
        continue;
      call.finish(
        call.effect === 'write' && call.delivered
          ? outcomeUnknown()
          : failed(
              'USER_MCP_REVOKED',
              `Registration revoked for ${server}/${tool}`,
            ),
      );
    }
  }

  catalogue(role?: string): UserMcpTool[] {
    return [...this.servers.values()]
      .flatMap(({ tools }) => tools)
      .filter(
        ({ server }) =>
          role === undefined ||
          server.roles.some((allowed) => allowed === role),
      );
  }

  hasTool(tool: UserMcpTool): boolean {
    return this.servers.get(tool.server.name)?.tools.includes(tool) ?? false;
  }

  subscribe(
    transport: Transport,
    servers: string[],
    stream: ExecutorStream,
  ): () => void {
    if (this.closed) {
      stream.close();
      return () => {};
    }
    this.streams.add(stream);
    const keys = new Set(
      servers.map((server) => executorKey(transport, server)),
    );
    for (const key of keys) this.executors.set(key, stream);
    const detach = () => {
      this.streams.delete(stream);
      for (const key of keys)
        if (this.executors.get(key) === stream) this.executors.delete(key);
    };
    // Outstanding calls are the outbox. Replaying them leaves the dialogue's
    // Last-Event-ID cursor intact and covers a disconnect before acknowledgment.
    for (const call of this.pending.values()) {
      if (!keys.has(call.executor)) continue;
      if (stream.send({ ...call.event, replay: true })) call.delivered = true;
      else {
        detach();
        break;
      }
    }
    return detach;
  }

  async call(
    tool: UserMcpTool,
    args: UserMcpCall['arguments'],
    signal?: AbortSignal,
    role?: string,
  ): Promise<CallResult> {
    const started = Date.now();
    const argumentBytes = Buffer.byteLength(JSON.stringify(args));
    let resultBytes = 0;
    const cancelled = () => failed('USER_MCP_ABORTED', 'Tool call cancelled');
    const unavailable = () =>
      failed('USER_MCP_UNAVAILABLE', 'No executor connected for this server');
    try {
      if (signal?.aborted) return cancelled();
      if (this.closed) return failed('SESSION_CLOSED', 'Session closed');
      const registration = this.servers.get(tool.server.name);
      if (!registration?.tools.includes(tool))
        return failed('TOOL_FORBIDDEN', 'Tool registration changed');
      const executor = executorKey(tool.server.transport, tool.server.name);
      const stream = this.executors.get(executor);
      if (!stream) return unavailable();
      const callId = randomUUID();
      return await new Promise<CallResult>((resolve) => {
        const aborted = () => finish(cancelled());
        const finish = (result: CallResult, bytes = 0) => {
          if (!this.pending.delete(callId)) return;
          signal?.removeEventListener('abort', aborted);
          resultBytes = bytes;
          resolve(result);
        };
        const event = {
          callId,
          server: tool.server.name,
          tool: tool.definition.name,
          arguments: args,
        };
        const call: PendingCall = {
          event,
          executor,
          generation: registration.generation,
          role,
          effect: tool.effect,
          delivered: false,
          finish,
        };
        this.pending.set(callId, call);
        signal?.addEventListener('abort', aborted, { once: true });
        if (stream.send(event)) call.delivered = true;
        else finish(unavailable());
      });
    } finally {
      cds.log('user-mcp').info('User MCP call', {
        tool: tool.name,
        argumentBytes,
        resultBytes,
        durationMs: Date.now() - started,
      });
    }
  }

  answer(callId: string, reply: Reply): boolean {
    const call = this.pending.get(callId);
    if (!call) return false;
    const bytes = Buffer.byteLength(JSON.stringify(reply));
    if ('outcome' in reply) {
      call.finish(outcomeUnknown(), bytes);
      return true;
    }
    let value: McpToolResult;
    if ('result' in reply) {
      const { content, structuredContent, isError } = reply.result;
      value = {
        content:
          content !== undefined && structuredContent !== undefined
            ? { content, structuredContent }
            : (content ?? structuredContent ?? {}),
        isError,
      };
    } else {
      value = { content: reply.error, isError: true };
    }
    call.finish({ ok: true, value }, bytes);
    return true;
  }

  close(): void {
    this.closed = true;
    this.servers.clear();
    for (const call of this.pending.values())
      call.finish(failed('SESSION_CLOSED', 'Session closed'));
    this.executors.clear();
    for (const stream of this.streams) stream.close();
    this.streams.clear();
  }
}
