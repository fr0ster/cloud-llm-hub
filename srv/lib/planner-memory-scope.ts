import { createHash } from 'node:crypto';
import {
  type IRag,
  type IRagBackendWriter,
  isRagFilteredDeleter,
  type RagMetadata,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const originalId = '_hubPlannerId';
const written = new WeakMap<IRag, Map<string, Set<string>>>();

/** Keep the library's session identity at the boundary, and the hub owner in storage. */
export function scopedPlannerMemory(
  rag: IRag,
  owner: string,
  key: string,
): IRag {
  const prefix = `${hash(owner).slice(0, 32)}:`;
  // HANA NVARCHAR(255) and PG VARCHAR(255). Preserve long logical ids in metadata.
  const storageId = (id: string) =>
    prefix + (prefix.length + id.length <= 255 ? id : hash(id));
  const metadata = (id: string, meta: RagMetadata): RagMetadata => ({
    ...meta,
    id: storageId(id),
    sessionId: owner,
    [originalId]: id,
  });
  const restore = (row: RagResult): RagResult => {
    const { [originalId]: id, ...meta } = row.metadata;
    return {
      ...row,
      metadata: {
        ...meta,
        id: typeof id === 'string' ? id : meta.id?.slice(prefix.length),
        sessionId: key,
      },
    };
  };
  const remember = (id: string) => {
    if (isRagFilteredDeleter(rag)) return;
    let owners = written.get(rag);
    if (!owners) {
      owners = new Map();
      written.set(rag, owners);
    }
    let ids = owners.get(owner);
    if (!ids) {
      ids = new Set();
      owners.set(owner, ids);
    }
    ids.add(storageId(id));
  };
  return {
    async query(embedding, k, options) {
      const result = await rag.query(embedding, k, {
        ...options,
        ragFilter: { ...options?.ragFilter, sessionId: owner },
      });
      return result.ok
        ? {
            ok: true,
            value: result.value
              .filter((r) => r.metadata.sessionId === owner)
              .map(restore),
          }
        : result;
    },
    async getById(id, options) {
      const result = await rag.getById(storageId(id), options);
      return result.ok
        ? {
            ok: true,
            value:
              result.value?.metadata.sessionId === owner
                ? restore(result.value)
                : null,
          }
        : result;
    },
    healthCheck: (options) => rag.healthCheck(options),
    writer() {
      const inner = rag.writer?.();
      if (!inner) return undefined;
      const writer: IRagBackendWriter = {
        upsertRaw(id, text, meta, options) {
          remember(id);
          return inner.upsertRaw(
            storageId(id),
            text,
            metadata(id, meta),
            options,
          );
        },
        deleteByIdRaw: (id, options) =>
          inner.deleteByIdRaw(storageId(id), options),
      };
      const precomputed = inner.upsertPrecomputedRaw?.bind(inner);
      if (precomputed)
        writer.upsertPrecomputedRaw = (id, text, vector, meta, options) => {
          remember(id);
          return precomputed(
            storageId(id),
            text,
            vector,
            metadata(id, meta),
            options,
          );
        };
      const many = inner.upsertManyPrecomputedRaw?.bind(inner);
      if (many)
        writer.upsertManyPrecomputedRaw = (items, options) => {
          for (const item of items) remember(item.id);
          return many(
            items.map((item) => ({
              ...item,
              id: storageId(item.id),
              metadata: metadata(item.id, item.metadata),
            })),
            options,
          );
        };
      return writer;
    },
  };
}

export async function forgetScopedPlannerMemory(
  rag: IRag,
  owner: string,
): Promise<boolean> {
  if (isRagFilteredDeleter(rag)) {
    const result = await rag.deleteWhere({ sessionId: owner });
    if (!result.ok) throw result.error;
    return true;
  }
  // Like executor history, stores without filtered delete use process-local ids.
  // Records from a previous process cannot be enumerated and remain in that store.
  const ids = written.get(rag)?.get(owner);
  if (!ids) return true;
  const writer = rag.writer?.();
  if (!writer) return false;
  for (const id of ids) {
    const result = await writer.deleteByIdRaw(id);
    if (!result.ok) throw result.error;
    ids.delete(id);
  }
  written.get(rag)?.delete(owner);
  return true;
}
