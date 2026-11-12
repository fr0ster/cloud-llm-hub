import {
  DuplicateCollectionError,
  type IRag,
  type IRagEditor,
  type IRagProvider,
  type RagCollectionRecord,
  RagError,
} from '@mcp-abap-adt/llm-agent';

/** A catalog for the configured process-local backend, with one store per session. */
export function volatileHistoryProvider(
  create: (name: string) => IRag,
): IRagProvider {
  const records = new Map<string, RagCollectionRecord>();
  const handles = new Map<string, { rag: IRag; editor: IRagEditor }>();
  return {
    name: 'hub-session-history',
    kind: 'volatile',
    editable: true,
    supportedScopes: ['session'],
    describeCollections: async () => ({
      ok: true,
      value: { records: [...records.values()], rejected: [] },
    }),
    createCollection: async (name, opts) => {
      if (opts.scope !== 'session')
        return {
          ok: false,
          error: new RagError('History requires a session owner'),
        };
      if (records.has(name))
        return {
          ok: false,
          error: new DuplicateCollectionError(name, 'History already exists'),
        };
      const rag = create(name);
      const editor: IRagEditor = {
        upsert: async () => ({
          ok: false,
          error: new RagError('Use the session history router'),
        }),
        deleteById: async () => ({
          ok: false,
          error: new RagError('Use the session history router'),
        }),
      };
      const value = { rag, editor };
      records.set(name, {
        name: opts.collectionName ?? name,
        storeName: name,
        scope: 'session',
        sessionId: opts.sessionId,
        ...(opts.attributes ? { attributes: opts.attributes } : {}),
      });
      handles.set(name, value);
      return { ok: true, value };
    },
    openCollection: async (record) => {
      const value = handles.get(record.storeName);
      const current = records.get(record.storeName);
      return value &&
        current?.scope === 'session' &&
        record.scope === 'session' &&
        current.sessionId === record.sessionId
        ? { ok: true, value }
        : {
            ok: false,
            error: new RagError(
              'History collection does not exist for this owner',
            ),
          };
    },
    deleteCollection: async (name) => {
      const value = handles.get(name);
      const cleared = await value?.rag.writer?.()?.clearAll?.();
      if (cleared && !cleared.ok) return cleared;
      records.delete(name);
      handles.delete(name);
      return { ok: true, value: undefined };
    },
  };
}
