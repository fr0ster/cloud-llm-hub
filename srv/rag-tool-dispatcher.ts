/**
 * RAG external-tool dispatcher.
 *
 * Exposes `rag_add`, `rag_correct`, `rag_deprecate` to clients (UI) as tool
 * definitions in OpenAI body.tools shape, and dispatches tool calls back to
 * the local `CollectionRegistry`.
 *
 * Schemas (names/descriptions/zod shapes) are pulled directly from llm-agent
 * via `buildRagCollectionToolEntries` so the wire contract stays in sync with
 * the package. Handlers are local because our `CollectionRegistry` keeps a
 * documents map + on-disk persistence + per-collection metadata that the
 * llm-agent handlers (which call `IRagEditor.upsert` directly) bypass.
 *
 * Server does not auto-inject these into chat requests — the client decides
 * when to surface them (e.g. tutorial/skill-driven flows).
 */
import { randomUUID } from 'node:crypto';
import {
  buildRagCollectionToolEntries,
  type IRagEditor,
  type IRagRegistry,
  type RagToolEntry,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import type { CollectionRegistry } from './rag-collections';

const EXPOSED_TOOL_NAMES = ['rag_add', 'rag_correct', 'rag_deprecate'] as const;
export type RagToolName = (typeof EXPOSED_TOOL_NAMES)[number];

/**
 * Stub registry that satisfies `IRagRegistry` just enough for
 * `buildRagCollectionToolEntries` to produce tool definitions. We never
 * invoke the bundled handlers, so missing methods are not a problem.
 */
const stubRegistry: IRagRegistry = {
  register: () => undefined,
  unregister: () => false,
  get: () => undefined,
  getEditor: (): IRagEditor | undefined => undefined,
  list: () => [],
  createCollection: async () => ({
    ok: false,
    error: { code: 'RAG_NOT_SUPPORTED', message: 'stub' } as never,
  }),
  deleteCollection: async () => ({
    ok: false,
    error: { code: 'RAG_NOT_SUPPORTED', message: 'stub' } as never,
  }),
  closeSession: async () => ({
    ok: false,
    error: { code: 'RAG_NOT_SUPPORTED', message: 'stub' } as never,
  }),
};

const exposedEntries: RagToolEntry[] = buildRagCollectionToolEntries({
  registry: stubRegistry,
}).filter((e) =>
  (EXPOSED_TOOL_NAMES as readonly string[]).includes(e.toolDefinition.name),
);

const argSchemaByName: Record<RagToolName, z.ZodObject> = Object.fromEntries(
  exposedEntries.map((e) => [
    e.toolDefinition.name,
    z.object(e.toolDefinition.inputSchema),
  ]),
) as Record<RagToolName, z.ZodObject>;

export function getRagToolNames(): RagToolName[] {
  return [...EXPOSED_TOOL_NAMES];
}

/** Returns OpenAI-format tool definitions for body.tools. */
export function buildRagToolSchemas(): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return exposedEntries.map((e) => ({
    type: 'function' as const,
    function: {
      name: e.toolDefinition.name,
      description: e.toolDefinition.description,
      parameters: z.toJSONSchema(
        z.object(e.toolDefinition.inputSchema),
      ) as Record<string, unknown>,
    },
  }));
}

type DispatchResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

export async function dispatchRagTool(
  registry: CollectionRegistry,
  name: string,
  rawArgs: unknown,
): Promise<DispatchResult> {
  const schema = argSchemaByName[name as RagToolName];
  if (!schema) {
    return { ok: false, error: `Unknown RAG tool: ${name}` };
  }
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  const args = parsed.data as Record<string, unknown>;

  try {
    switch (name as RagToolName) {
      case 'rag_add': {
        const id = randomUUID();
        const tags = args.tags as string[] | undefined;
        await registry.addDocument(args.collection as string, {
          id,
          text: args.text as string,
          metadata: {
            canonicalKey: args.canonicalKey,
            ...(tags && tags.length > 0 ? { tags } : {}),
          },
        });
        return { ok: true, id };
      }
      case 'rag_correct': {
        const newId = randomUUID();
        await registry.addDocument(args.collection as string, {
          id: newId,
          text: args.newText as string,
          metadata: {
            canonicalKey: args.predecessorCanonicalKey,
            tags: ['correction'],
          },
        });
        const updated = await registry.updateDocument(
          args.collection as string,
          args.predecessorId as string,
          {
            metadata: {
              supersededBy: newId,
              deprecatedReason: args.reason,
              deprecatedAt: Math.floor(Date.now() / 1000),
              tags: ['superseded'],
            },
          },
        );
        if (!updated) {
          return {
            ok: false,
            error: `Predecessor "${args.predecessorId}" not found in collection "${args.collection}"`,
          };
        }
        return { ok: true, newId, predecessorId: args.predecessorId };
      }
      case 'rag_deprecate': {
        const updated = await registry.updateDocument(
          args.collection as string,
          args.id as string,
          {
            metadata: {
              canonicalKey: args.canonicalKey,
              deprecatedReason: args.reason,
              deprecatedAt: Math.floor(Date.now() / 1000),
              tags: ['deprecated'],
            },
          },
        );
        if (!updated) {
          return {
            ok: false,
            error: `Document "${args.id}" not found in collection "${args.collection}"`,
          };
        }
        return { ok: true, id: args.id };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
