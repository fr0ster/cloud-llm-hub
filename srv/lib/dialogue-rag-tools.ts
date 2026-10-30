import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  CallOptions,
  IMcpClient,
  IRag,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { CollectionRegistry } from '../rag-collections';
import { buildRagToolSchemas, dispatchRagTool } from '../rag-tool-dispatcher';
import {
  getRequestSessionId,
  getRequestUserId,
  isReadOnlyTools,
  profileToolAllowed,
} from '../request-session';
import { externalRagWriteNames } from './external-rag-write-names';

const scope = new AsyncLocalStorage<boolean>();
export function runWithDialogueRagTools<T>(fn: () => T): T {
  return scope.run(true, fn);
}

function tools(): McpTool[] {
  return buildRagToolSchemas(true)
    .filter(
      (t) =>
        profileToolAllowed(t.function.name) &&
        (!isReadOnlyTools() || t.function.name === 'rag_list'),
    )
    .map(({ function: f }) => ({
      name: f.name,
      description: f.description,
      inputSchema: f.parameters,
      annotations: { readOnlyHint: f.name === 'rag_list' },
    }));
}

/** Inside RecordingMcpClient: local calls and their results are recorded too. */
export class DialogueRagMcpClient implements IMcpClient {
  readonly healthCheck?: IMcpClient['healthCheck'];
  constructor(
    private readonly inner: IMcpClient,
    private readonly registry: () => CollectionRegistry,
  ) {
    this.healthCheck = inner.healthCheck?.bind(inner);
  }
  async listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
    const result = await this.inner.listTools(options);
    return result.ok
      ? {
          ok: true,
          value: [
            ...result.value.filter(
              (t) =>
                !t.name.startsWith('rag_') &&
                !externalRagWriteNames.has(t.name),
            ),
            ...tools(),
          ],
        }
      : result;
  }
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
    if (externalRagWriteNames.has(name))
      return {
        ok: true,
        value: {
          isError: true,
          content: 'TOOL_FORBIDDEN: external agent write tool',
        },
      };
    if (!name.startsWith('rag_'))
      return this.inner.callTool(name, args, options);
    if (
      !scope.getStore() ||
      !getRequestSessionId() ||
      !getRequestUserId() ||
      !tools().some((t) => t.name === name)
    ) {
      return {
        ok: true,
        value: {
          isError: true,
          content:
            'RAG tool unavailable in this worker scope (checker tools are read-only).',
        },
      };
    }
    // The background task already holds session admission and binds session/user ALS.
    const result = await dispatchRagTool(this.registry(), name, args, {
      defaultScope: 'user',
    });
    return {
      ok: true,
      value: { content: JSON.stringify(result), isError: !result.ok },
    };
  }
}

/** Hub storage is independent of SAP exposition and the SAP tool gate. */
export function withDialogueRagTools(rag: IRag): IRag {
  return new Proxy(rag, {
    get(target, prop) {
      if (prop === 'query')
        return async (...args: Parameters<IRag['query']>) => {
          const result = await target.query(...args);
          if (!result.ok) return result;
          const candidates = result.value.filter(
            (record) =>
              !externalRagWriteNames.has(
                String(record.metadata.id).replace(/^tool:/, ''),
              ) &&
              !externalRagWriteNames.has(String(record.metadata.name ?? '')),
          );
          if (!scope.getStore()) return { ...result, value: candidates };
          return {
            ok: true,
            value: [
              ...tools().map((t) => ({
                text: `Tool: ${t.name}\nDescription: ${t.description}`,
                metadata: { id: `tool:${t.name}`, name: t.name },
                score: 1,
              })),
              ...candidates.filter(
                (r) =>
                  !String(r.metadata.id).startsWith('tool:rag_') &&
                  !externalRagWriteNames.has(
                    String(r.metadata.id).replace(/^tool:/, ''),
                  ) &&
                  !externalRagWriteNames.has(String(r.metadata.name ?? '')),
              ),
            ],
          };
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
