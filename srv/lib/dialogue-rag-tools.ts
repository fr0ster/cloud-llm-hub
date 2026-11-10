import type {
  CallOptions,
  IMcpClient,
  IRag,
  IToolSelectionStrategy,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { DEFAULT_TOOL_SELECTION } from '@mcp-abap-adt/llm-agent-libs';
import { executeRagTool } from '../agent-mcp-rag';
import type { CollectionRegistry } from '../rag-collections';
import {
  currentProfileTools,
  getRagCallerIdentity,
  getRequestSessionId,
  getRequestUserId,
  isReadOnlyTools,
  isStatelessKnowledge,
} from '../request-session';
import { currentAdmission } from './admission-scope';
import {
  submitVerdict,
  submitVerdictTool,
  verdictToolsEnabled,
} from './checker-verdict-tool';
import { currentContextTaskId } from './context-capture';
import { isDialogueRagWorker } from './dialogue-rag-scope';
import {
  buildRagToolSchemas,
  isRagTool,
  ragToolEffect,
} from './rag-tool-catalogue';
import { usageRuntime } from './usage/runtime';

export { runWithDialogueRagTools } from './dialogue-rag-scope';

/** LLM-only read tools are available independently of retrieval relevance. */
export const llmOnlyReadToolSelection: IToolSelectionStrategy = {
  name: 'llm-only-read-tools',
  select() {
    return localRagTools(false, true).map(({ name }) => ({
      text: `Tool: ${name}`,
      metadata: { id: `tool:${name}`, name },
      score: 1,
    }));
  },
};

/** References must remain readable even when relevance selection drops them. */
export const dialogueResultToolSelection: IToolSelectionStrategy = {
  name: 'dialogue-result-readers',
  select(results) {
    const selected = DEFAULT_TOOL_SELECTION.select(results);
    if (!isDialogueRagWorker()) return selected;
    return [
      ...selected,
      ...['rag_read', 'collection_records'].map((name) => ({
        text: `Tool: ${name}`,
        metadata: { id: `tool:${name}`, name },
        score: 1,
      })),
    ];
  },
};

const removedNames = new Set([
  'rag_list',
  'rag_add',
  'rag_correct',
  'rag_deprecate',
]);
export function localRagTools(
  coordinator = false,
  readOnly = false,
): McpTool[] {
  return buildRagToolSchemas(coordinator)
    .filter(
      ({ function: tool }) => !readOnly || ragToolEffect(tool.name) === 'read',
    )
    .map(({ function: tool }) => ({
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
    private readonly coordinator = false,
    private readonly readOnly = false,
  ) {
    this.healthCheck = inner.healthCheck?.bind(inner);
  }
  async listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
    if (this.readOnly) return { ok: true, value: localRagTools(false, true) };
    const result = await this.inner.listTools(options);
    if (!result.ok) return result;
    const imported = new Map(
      result.value
        .filter(
          (tool) =>
            tool.name !== submitVerdictTool.name &&
            !isRagTool(tool.name) &&
            !removedNames.has(tool.name),
        )
        .map((tool) => [tool.name, tool]),
    );
    return {
      ok: true,
      value: [
        ...imported.values(),
        ...(!this.coordinator && verdictToolsEnabled()
          ? [submitVerdictTool]
          : []),
        ...localRagTools(this.coordinator).filter(
          (tool) =>
            !this.coordinator ||
            (isRagTool(tool.name) &&
              (ragToolEffect(tool.name) === 'read' ||
                tool.name === 'rag_persist')),
        ),
      ],
    };
  }
  async callTool(
    name: string,
    args: Parameters<IMcpClient['callTool']>[1],
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
    if (this.readOnly && (!isRagTool(name) || ragToolEffect(name) !== 'read'))
      return {
        ok: true,
        value: {
          isError: true,
          content: 'Tool unavailable in a session without SAP tools.',
        },
      };
    if (name === submitVerdictTool.name)
      return {
        ok: true,
        value: this.coordinator
          ? { isError: true, content: 'Tool unavailable to coordinator.' }
          : submitVerdict(args, options),
      };
    if (
      this.coordinator &&
      isRagTool(name) &&
      ragToolEffect(name) !== 'read' &&
      name !== 'rag_persist'
    )
      return {
        ok: true,
        value: {
          isError: true,
          content:
            'Tool unavailable to coordinator. Delegate collection and record changes to executor.',
        },
      };
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
    const userId = getRequestUserId();
    if (!userId)
      return {
        ok: true,
        value: { isError: true, content: 'Authenticated user required.' },
      };
    const sessionKey = getRequestSessionId();
    const permissions = currentProfileTools() ?? { allows: () => true };
    const value = await executeRagTool(
      {
        registry: this.registry?.(),
        dialogueRole: this.coordinator
          ? 'coordinator'
          : isDialogueRagWorker()
            ? 'worker'
            : undefined,
        userId,
        admin: identity.admin,
        sessionKey,
        internal: true,
        statelessRead: isStatelessKnowledge(),
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
    return {
      ok: true,
      value: {
        ...value,
        content: value.structuredContent
          ? JSON.stringify(value.structuredContent)
          : value.content.map((part) => part.text).join('\n'),
      },
    };
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
                  name !== submitVerdictTool.name &&
                  id !== submitVerdictTool.name &&
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
              ...[
                ...localRagTools(),
                ...(verdictToolsEnabled() ? [submitVerdictTool] : []),
              ].map((tool) => ({
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
