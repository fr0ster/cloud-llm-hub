/**
 * RAG external-tool dispatcher.
 *
 * Exposes `rag_add`, `rag_correct`, `rag_deprecate` to clients (UI) as tool
 * definitions in OpenAI body.tools shape, and dispatches tool calls back to
 * the local `CollectionRegistry`. Schemas mirror llm-agent's
 * `buildRagCollectionToolEntries` so a client switch is a drop-in.
 *
 * Server does not auto-inject these into chat requests — the client decides
 * when to surface them (e.g. tutorial/skill-driven flows).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CollectionRegistry } from './rag-collections';

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
    name: 'rag_add',
    description: 'Add a new document to a RAG collection.',
    schema: ragAddSchema,
  },
  {
    name: 'rag_correct',
    description:
      'Supersede a document with a new corrected version. Marks the predecessor as superseded.',
    schema: ragCorrectSchema,
  },
  {
    name: 'rag_deprecate',
    description: 'Mark a document as deprecated (idempotent).',
    schema: ragDeprecateSchema,
  },
] as const;

export type RagToolName = (typeof TOOL_DEFS)[number]['name'];

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
  switch (name) {
    case 'rag_add': {
      const parsed = ragAddSchema.safeParse(rawArgs);
      if (!parsed.success) return { ok: false, error: parsed.error.message };
      const { collection, text, canonicalKey, tags } = parsed.data;
      try {
        const id = randomUUID();
        await registry.addDocument(collection, {
          id,
          text,
          metadata: {
            canonicalKey,
            ...(tags && tags.length > 0 ? { tags } : {}),
          },
        });
        return { ok: true, id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'rag_correct': {
      const parsed = ragCorrectSchema.safeParse(rawArgs);
      if (!parsed.success) return { ok: false, error: parsed.error.message };
      const {
        collection,
        predecessorId,
        predecessorCanonicalKey,
        newText,
        reason,
      } = parsed.data;
      try {
        const newId = randomUUID();
        await registry.addDocument(collection, {
          id: newId,
          text: newText,
          metadata: {
            canonicalKey: predecessorCanonicalKey,
            tags: ['correction'],
          },
        });
        const supersededAt = Math.floor(Date.now() / 1000);
        const updated = await registry.updateDocument(
          collection,
          predecessorId,
          {
            metadata: {
              supersededBy: newId,
              deprecatedReason: reason,
              deprecatedAt: supersededAt,
              tags: ['superseded'],
            },
          },
        );
        if (!updated) {
          return {
            ok: false,
            error: `Predecessor "${predecessorId}" not found in collection "${collection}"`,
          };
        }
        return { ok: true, newId, predecessorId };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'rag_deprecate': {
      const parsed = ragDeprecateSchema.safeParse(rawArgs);
      if (!parsed.success) return { ok: false, error: parsed.error.message };
      const { collection, id, canonicalKey, reason } = parsed.data;
      try {
        const updated = await registry.updateDocument(collection, id, {
          metadata: {
            canonicalKey,
            deprecatedReason: reason,
            deprecatedAt: Math.floor(Date.now() / 1000),
            tags: ['deprecated'],
          },
        });
        if (!updated) {
          return {
            ok: false,
            error: `Document "${id}" not found in collection "${collection}"`,
          };
        }
        return { ok: true, id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    default:
      return { ok: false, error: `Unknown RAG tool: ${name}` };
  }
}
