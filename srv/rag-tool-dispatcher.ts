/**
 * RAG external-tool dispatcher.
 *
 * Exposes `rag_add`, `rag_correct`, `rag_deprecate` to clients (UI) as tool
 * definitions in OpenAI body.tools shape, and dispatches tool calls back to
 * the local `CollectionRegistry`.
 *
 * Design choice: addressing is by a stable, caller-supplied `id` (used as
 * canonicalKey internally). This diverges from llm-agent's upstream schemas
 * (rag_correct there requires a `predecessorId` UUID) so that prompts in
 * skills and tutorials stay human-readable — `id: "business-requirements"`
 * instead of UUIDs the caller would have to track.
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
  id: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const ragCorrectSchema = z.object({
  collection: z.string(),
  id: z.string(),
  newText: z.string(),
  reason: z.string(),
});

const ragDeprecateSchema = z.object({
  collection: z.string(),
  id: z.string(),
  reason: z.string(),
});

const TOOL_DEFS = [
  {
    name: 'rag_add' as const,
    description:
      'Add a new document to a RAG collection. Pass `id` to make the record addressable later (e.g. "business-requirements"); omit it to let the system assign a UUID. Errors if an active record with the given id already exists in the collection.',
    schema: ragAddSchema,
  },
  {
    name: 'rag_correct' as const,
    description:
      'Supersede the active record with the given `id` by a new corrected version. The previous record is kept in the store as audit history (tagged superseded) and dropped from retrieval. The new record stays addressable by the same `id`.',
    schema: ragCorrectSchema,
  },
  {
    name: 'rag_deprecate' as const,
    description:
      'Mark the active record with the given `id` as deprecated. The record stays in the store as audit history but is dropped from retrieval. Idempotent.',
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
  const schema = argSchemaByName[name];
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
        const collection = args.collection as string;
        const requestedId = (args.id as string | undefined)?.trim();
        const id = requestedId || randomUUID();
        if (requestedId) {
          const existing = registry.findActiveByCanonicalKey(collection, id);
          if (existing) {
            return {
              ok: false,
              error: `Active record "${id}" already exists in collection "${collection}"`,
            };
          }
        }
        const tags = args.tags as string[] | undefined;
        await registry.addDocument(collection, {
          id,
          text: args.text as string,
          metadata: {
            canonicalKey: id,
            ...(tags && tags.length > 0 ? { tags } : {}),
          },
        });
        return { ok: true, id };
      }
      case 'rag_correct': {
        const collection = args.collection as string;
        const id = args.id as string;
        const active = registry.findActiveByCanonicalKey(collection, id);
        if (!active) {
          return {
            ok: false,
            error: `No active record with id "${id}" in collection "${collection}"`,
          };
        }
        const newPhysicalId = randomUUID();
        await registry.addDocument(collection, {
          id: newPhysicalId,
          text: args.newText as string,
          metadata: {
            canonicalKey: id,
            tags: ['correction'],
          },
        });
        const updated = await registry.updateDocument(collection, active.id, {
          metadata: {
            supersededBy: newPhysicalId,
            deprecatedReason: args.reason,
            deprecatedAt: Math.floor(Date.now() / 1000),
            tags: ['superseded'],
          },
        });
        if (!updated) {
          return {
            ok: false,
            error: `Predecessor record vanished mid-correction in "${collection}" (id "${id}")`,
          };
        }
        return { ok: true, id };
      }
      case 'rag_deprecate': {
        const collection = args.collection as string;
        const id = args.id as string;
        const active = registry.findActiveByCanonicalKey(collection, id);
        if (!active) {
          return {
            ok: false,
            error: `No active record with id "${id}" in collection "${collection}"`,
          };
        }
        const updated = await registry.updateDocument(collection, active.id, {
          metadata: {
            canonicalKey: id,
            deprecatedReason: args.reason,
            deprecatedAt: Math.floor(Date.now() / 1000),
            tags: ['deprecated'],
          },
        });
        if (!updated) {
          return {
            ok: false,
            error: `Active record vanished mid-deprecate in "${collection}" (id "${id}")`,
          };
        }
        return { ok: true, id };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
