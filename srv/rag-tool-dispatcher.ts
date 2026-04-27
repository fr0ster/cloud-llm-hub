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
import { z } from 'zod';
import type { CollectionRegistry } from './rag-collections';

// NOTE: schemas are inlined (not pulled from llm-agent's
// `buildRagCollectionToolEntries`) because llm-agent ships its own zod 3.x,
// while we run zod 4.x. Cross-version ZodRawShape objects do not survive
// `z.toJSONSchema` — internals (`_def`/`def`) differ. Mirror the names,
// descriptions, and field shapes; bump them when the upstream package
// changes them. Drift here is a tutorial/UI concern only — handlers below
// are independent and stay authoritative for our CollectionRegistry.

const ragAddSchema = z.object({
  collection: z.string(),
  text: z.string(),
  canonicalKey: z.string(),
  tags: z.array(z.string()).optional(),
});

const ragCorrectSchema = z.object({
  collection: z.string(),
  predecessorId: z.string(),
  predecessorCanonicalKey: z.string(),
  newText: z.string(),
  reason: z.string(),
});

const ragDeprecateSchema = z.object({
  collection: z.string(),
  id: z.string(),
  canonicalKey: z.string(),
  reason: z.string(),
});

const TOOL_DEFS = [
  {
    name: 'rag_add' as const,
    description: 'Add a new document to a RAG collection.',
    schema: ragAddSchema,
  },
  {
    name: 'rag_correct' as const,
    description:
      'Supersede a document with a new corrected version. Marks the predecessor as superseded.',
    schema: ragCorrectSchema,
  },
  {
    name: 'rag_deprecate' as const,
    description: 'Mark a document as deprecated (idempotent).',
    schema: ragDeprecateSchema,
  },
];

export type RagToolName = (typeof TOOL_DEFS)[number]['name'];

const argSchemaByName: Record<string, z.ZodType> = Object.fromEntries(
  TOOL_DEFS.map((t) => [t.name, t.schema]),
);

export function getRagToolNames(): RagToolName[] {
  return TOOL_DEFS.map((t) => t.name);
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
  return TOOL_DEFS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
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
