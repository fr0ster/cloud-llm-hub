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
 * Clients decide when to surface write tools in ordinary chat requests.
 * Dialogue workers dispatch them locally and also get `rag_list` for readback.
 */
import { randomUUID } from 'node:crypto';
import cds from '@sap/cds';
import { z } from 'zod';
import { normalizeLogicalId, resolveByName } from './collection-ids';
import { CollectionBackendError } from './lib/collection-persistence';
import { collectionEnabled } from './lib/collection-toggle';
import { recordPolicy } from './lib/record-policy';
import type { CollectionRegistry } from './rag-collections';
import { sessionCollectionTtlMs } from './rag-collections';
import { getRequestSessionId, getRequestUserId } from './request-session';

const ragAddSchema = z.object({
  collection: z.string(),
  text: z.string(),
  id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  scope: z.enum(['user', 'session']).optional(),
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
    name: 'rag_list' as const,
    description:
      'List record ids, titles, text lengths and tags from a hub RAG collection. Use offset and limit (default 50, maximum 200) to page. Pass id to read one record in full. Disabled records or collections expose only id, enabled and a reason.',
    schema: z.object({
      collection: z.string(),
      id: z.string().optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  },
  {
    name: 'rag_add' as const,
    description:
      'Add a new document to a RAG collection. Scope user is persistent across sessions; scope session is temporary scratch storage and requires a session. Dialogue workers default to user scope; client calls keep their existing session-aware default. Pass `id` to make the record addressable later (e.g. "business-requirements"); omit it to let the system assign a UUID. Errors if an active record with the given id already exists in the collection.',
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

/** OpenAI-format definitions. Readback is opt-in for server-side workers. */
export function buildRagToolSchemas(includeRead = false): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return TOOL_DEFS.filter((t) => includeRead || t.name !== 'rag_list').map(
    (t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
      },
    }),
  );
}

type DispatchResult =
  | { ok: true; [key: string]: unknown }
  /** `status`: set when a persistent backend refused (409 or 502). */
  | { ok: false; error: string; status?: number };

export async function dispatchRagTool(
  registry: CollectionRegistry,
  name: string,
  rawArgs: unknown,
  options?: { defaultScope: 'user' },
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

  const userId = () =>
    getRequestUserId() ?? cds.context?.user?.id ?? 'anonymous';
  const sessionId = () => getRequestSessionId();

  try {
    switch (name as RagToolName) {
      case 'rag_list': {
        const physical = await resolveByName(
          registry,
          args.collection as string,
          userId(),
          sessionId(),
          false,
          options?.defaultScope,
        );
        if (!physical) return { ok: false, error: 'Collection not found' };
        const meta = await registry.getCollection(physical);
        if (!meta) return { ok: false, error: 'Collection not found' };
        const enabled = collectionEnabled(
          registry,
          userId(),
          sessionId(),
          meta,
        );
        if (args.id !== undefined) {
          const doc =
            (await registry.findActiveByCanonicalKey(
              physical,
              args.id as string,
            )) ?? (await registry.getDocument(physical, args.id as string));
          if (!doc) return { ok: false, error: 'Record not found' };
          const visibility = recordPolicy(doc.metadata, enabled);
          return {
            ok: true,
            document: {
              id: doc.metadata?.canonicalKey ?? doc.id,
              enabled: doc.metadata.enabled !== false,
              ...(visibility.visible
                ? {
                    text: doc.text,
                    ...(doc.metadata.tags ? { tags: doc.metadata.tags } : {}),
                  }
                : { reason: visibility.reason }),
            },
          };
        }
        const result = await registry.listDocuments(physical, {
          offset: args.offset as number | undefined,
          limit: (args.limit as number | undefined) ?? 50,
        });
        return result
          ? {
              ok: true,
              total: result.total,
              documents: result.documents.map((doc) => {
                const visibility = recordPolicy(doc.metadata, enabled);
                if (!visibility.visible)
                  return {
                    id: doc.metadata.canonicalKey ?? doc.id,
                    enabled: doc.metadata.enabled !== false,
                    reason: visibility.reason,
                  };
                return {
                  id: doc.metadata?.canonicalKey ?? doc.id,
                  enabled: doc.metadata.enabled !== false,
                  title: doc.text.split(/\r?\n/, 1)[0].trim().slice(0, 120),
                  length: doc.text.length,
                  ...(doc.metadata?.tags ? { tags: doc.metadata.tags } : {}),
                };
              }),
            }
          : { ok: false, error: 'Collection not found' };
      }
      case 'rag_add': {
        const sid = sessionId();
        let physical: string | undefined;
        try {
          physical = await resolveByName(
            registry,
            args.collection as string,
            userId(),
            sid,
            true,
            (args.scope as 'user' | 'session' | undefined) ??
              options?.defaultScope,
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
        // Auto-create the collection if it does not exist yet — atomically,
        // so parallel rag_add calls on a new collection all land in one.
        const isSession = !!sid && physical.includes('__s_');
        const { created } = await registry.getOrCreateCollection({
          id: physical,
          logicalId: normalizeLogicalId(args.collection as string),
          displayName: args.collection as string,
          description: '',
          scope: isSession ? 'session' : 'user',
          owner: userId(),
          ...(isSession
            ? {
                sessionId: sid,
                expiresAt: Date.now() + sessionCollectionTtlMs(),
              }
            : {}),
        });
        // Refresh expiry for existing session collections.
        if (!created && sid) await registry.refreshSessionExpiry(physical);
        const requestedId = (args.id as string | undefined)?.trim();
        const id = requestedId || randomUUID();
        if (requestedId) {
          const existing = await registry.findActiveByCanonicalKey(
            physical,
            id,
          );
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
        const physical = await resolveByName(
          registry,
          args.collection as string,
          userId(),
          sessionId(),
          false,
          options?.defaultScope,
        );
        if (!physical) {
          return {
            ok: false,
            error: `No active record found in collection "${args.collection as string}"`,
          };
        }
        const id = args.id as string;
        const active = await registry.findActiveByCanonicalKey(physical, id);
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
        const physical = await resolveByName(
          registry,
          args.collection as string,
          userId(),
          sessionId(),
          false,
          options?.defaultScope,
        );
        if (!physical) {
          return {
            ok: false,
            error: `No active record found in collection "${args.collection as string}"`,
          };
        }
        const id = args.id as string;
        const active = await registry.findActiveByCanonicalKey(physical, id);
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
    return {
      ok: false,
      error: (err as Error).message,
      ...(err instanceof CollectionBackendError
        ? { status: err.httpStatus }
        : {}),
    };
  }
}
