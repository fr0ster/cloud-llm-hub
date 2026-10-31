import type {
  CallOptions,
  IMcpClient,
  IRag,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { executeRagTool } from '../agent-mcp-rag';
import type { CollectionRegistry } from '../rag-collections';
import {
  currentProfileTools,
  getRagCallerIdentity,
  getRequestSessionId,
  getRequestUserId,
  isReadOnlyTools,
} from '../request-session';
import { currentAdmission } from './admission-scope';
import { currentContextTaskId } from './context-capture';
import {
  buildRagToolSchemas,
  isRagTool,
  ragToolEffect,
} from './rag-tool-catalogue';
import { usageRuntime } from './usage/runtime';

export function runWithDialogueRagTools<T>(fn: () => T): T {
  return fn();
}

const removedNames = new Set([
  'rag_list',
  'rag_add',
  'rag_correct',
  'rag_deprecate',
]);
export function localRagTools(): McpTool[] {
  return buildRagToolSchemas().map(({ function: tool }) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations: { readOnlyHint: ragToolEffect(tool.name) === 'read' },
  }));
}

/** Inside recording and result caps so local calls retain the same evidence. */
export class LocalRagMcpClient implements IMcpClient {
  readonly healthCheck?: IMcpClient['healthCheck'];
  constructor(
    private readonly inner: IMcpClient,
    private readonly registry?: () => CollectionRegistry,
  ) {
    this.healthCheck = inner.healthCheck?.bind(inner);
  }
  async listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
    const result = await this.inner.listTools(options);
    if (!result.ok) return result;
    const imported = new Map(
      result.value
        .filter((tool) => !isRagTool(tool.name) && !removedNames.has(tool.name))
        .map((tool) => [tool.name, tool]),
    );
    return { ok: true, value: [...imported.values(), ...localRagTools()] };
  }
  async callTool(
    name: string,
    args: Parameters<IMcpClient['callTool']>[1],
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
    if (removedNames.has(name))
      return {
        ok: true,
        value: {
          isError: true,
          content:
            'Unknown RAG tool. Use the canonical RAG catalogue; legacy names have been removed.',
        },
      };
    if (!isRagTool(name)) return this.inner.callTool(name, args, options);
    const identity = getRagCallerIdentity();
    const userId = getRequestUserId() ?? '';
    const sessionKey = getRequestSessionId();
    const permissions = currentProfileTools() ?? { allows: () => true };
    const value = await executeRagTool(
      {
        registry: this.registry?.(),
        userId,
        admin: identity.admin,
        sessionKey,
        internal: true,
        trustedAdmission: currentAdmission() !== undefined,
        permissions,
        readOnly: isReadOnlyTools(),
        traceId: options?.trace?.traceId,
        channel: identity.channel,
        taskId: currentContextTaskId(),
        measurement:
          options?.usage ??
          usageRuntime()
            ?.forSession({ userId, sessionId: sessionKey ?? '' })
            .with({ traceId: options?.trace?.traceId }),
      },
      name,
      args,
    );
    return { ok: true, value };
  }
}
export { LocalRagMcpClient as DialogueRagMcpClient };

/** Local candidates are reserved independently of SAP exposition. */
export function withDialogueRagTools(rag: IRag): IRag {
  return new Proxy(rag, {
    get(target, prop) {
      if (prop === 'query')
        return async (...args: Parameters<IRag['query']>) => {
          const result = await target.query(...args);
          if (!result.ok) return result;
          const candidates = new Map(
            result.value
              .filter((record) => {
                const name = String(
                  record.metadata.name ??
                    String(record.metadata.id).replace(/^tool:/, ''),
                );
                const id = String(record.metadata.id).replace(/^tool:/, '');
                return (
                  !isRagTool(name) &&
                  !removedNames.has(name) &&
                  !isRagTool(id) &&
                  !removedNames.has(id)
                );
              })
              .map((record) => [
                String(
                  record.metadata.name ??
                    String(record.metadata.id).replace(/^tool:/, ''),
                ),
                record,
              ]),
          );
          return {
            ok: true as const,
            value: [
              ...localRagTools().map((tool) => ({
                text: `Tool: ${tool.name}\nDescription: ${tool.description}`,
                metadata: { id: `tool:${tool.name}`, name: tool.name },
                score: 1,
              })),
              ...candidates.values(),
            ],
          };
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
