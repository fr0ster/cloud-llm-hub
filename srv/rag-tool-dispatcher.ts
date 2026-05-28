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
import cds from '@sap/cds';
import { z } from 'zod';
import { normalizeLogicalId, resolveByName } from './collection-ids';
import type { CollectionRegistry } from './rag-collections';
import { SESSION_TTL_MS } from './rag-collections';
import { getRequestSessionId } from './request-session';

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
      'Replace the text of the active record with the given `id`. The same record stays addressable by the same `id` after the call; the previous text is overwritten. Use `rag_deprecate` if you want to retire the record entirely.',
    schema: ragCorrectSchema,
  },
  {
    name: 'rag_deprecate' as const,
    description:
      'Permanently delete the active record with the given `id` from the collection. After the call, the same `id` is free to be re-added via `rag_add`. Use when an artifact is no longer relevant.',
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

  const userId = () => cds.context?.user?.id ?? 'anonymous';
  const sessionId = () => getRequestSessionId();

  try {
    switch (name as RagToolName) {
      case 'rag_add': {
        const sid = sessionId();
        let physical: string | undefined;
        try {
          physical = resolveByName(
            registry,
            args.collection as string,
            userId(),
            sid,
            true,
          );
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
        if (!physical) {
          return {
            ok: false,
            error: 'Authenticated user required to add to a collection',
          };
        }
        // Auto-create the collection if it does not exist yet.
        if (!registry.getCollection(physical)) {
          const isSession = !!sid && physical.includes('__s_');
          registry.createCollection({
            id: physical,
            logicalId: normalizeLogicalId(args.collection as string),
            displayName: args.collection as string,
            description: '',
            scope: isSession ? 'session' : 'user',
            owner: userId(),
            ...(isSession
              ? { sessionId: sid, expiresAt: Date.now() + SESSION_TTL_MS }
              : {}),
          });
        } else {
          // Refresh expiry for existing session collections.
          if (sid) registry.refreshSessionExpiry(physical);
        }
        const requestedId = (args.id as string | undefined)?.trim();
        const id = requestedId || randomUUID();
        if (requestedId) {
          const existing = registry.findActiveByCanonicalKey(physical, id);
          if (existing) {
            return {
              ok: false,
              error: `Active record "${id}" already exists in collection "${args.collection as string}"`,
            };
          }
        }
        const tags = args.tags as string[] | undefined;
        await registry.addDocument(physical, {
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
        const physical = resolveByName(
          registry,
          args.collection as string,
          userId(),
          sessionId(),
          false,
        );
        if (!physical) {
          return {
            ok: false,
            error: `No active record found in collection "${args.collection as string}"`,
          };
        }
        const id = args.id as string;
        const active = registry.findActiveByCanonicalKey(physical, id);
        if (!active) {
          return {
            ok: false,
            error: `No active record with id "${id}" in collection "${args.collection as string}"`,
          };
        }
        // In-place text update. The same physical record stays in the
        // collection — addressable by the same `id` throughout its life.
        // No supersede chain in MANAGE.
        const updated = await registry.updateDocument(physical, active.id, {
          text: args.newText as string,
          metadata: {
            canonicalKey: id,
            lastCorrectedReason: args.reason,
            lastCorrectedAt: Math.floor(Date.now() / 1000),
          },
        });
        if (!updated) {
          return {
            ok: false,
            error: `Active record vanished mid-correction in "${args.collection as string}" (id "${id}")`,
          };
        }
        return { ok: true, id };
      }
      case 'rag_deprecate': {
        const physical = resolveByName(
          registry,
          args.collection as string,
          userId(),
          sessionId(),
          false,
        );
        if (!physical) {
          return {
            ok: false,
            error: `No active record found in collection "${args.collection as string}"`,
          };
        }
        const id = args.id as string;
        const active = registry.findActiveByCanonicalKey(physical, id);
        if (!active) {
          return {
            ok: false,
            error: `No active record with id "${id}" in collection "${args.collection as string}"`,
          };
        }
        const deleted = await registry.deleteDocument(physical, active.id);
        if (!deleted) {
          return {
            ok: false,
            error: `Active record vanished mid-delete in "${args.collection as string}" (id "${id}")`,
          };
        }
        return { ok: true, id, reason: args.reason };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
