import {
  type CallOptions,
  InMemoryRag,
  type IQueryEmbedding,
  type IRag,
  type IRagProvider,
  type RagCaller,
  type RagCollectionRecord,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { parseTurnOwner } from '../../../srv/lib/history-turn';
import { bindCaller } from '../../../srv/lib/rag-caller';
import {
  initSessionHistoryRouter,
  SessionHistoryRouter,
  type SessionHistoryRouterOptions,
} from '../../../srv/lib/session-history-collection';

/** Keep the older test vocabulary while exercising the per-session router and catalog. */
export class SessionHistoryFixture implements IRag {
  readonly router: SessionHistoryRouter;
  constructor(
    provider: IRagProvider,
    private readonly currentOwner: () => string | undefined,
    readonly maxTurns = 200,
    options: SessionHistoryRouterOptions = {},
  ) {
    this.router = new SessionHistoryRouter(provider, { ...options, maxTurns });
    initSessionHistoryRouter(this.router);
  }
  get storageBackend() {
    return this.router.storageBackend;
  }
  private async caller(
    owner: string | undefined,
  ): Promise<RagCaller | undefined> {
    const identity = owner === undefined ? undefined : parseTurnOwner(owner);
    if (!identity) return undefined;
    const bound = await bindCaller(identity.sessionId, identity.userId, false);
    if (!bound.ok) throw bound.error;
    return bound.value;
  }
  async query(embedding: IQueryEmbedding, k: number, options?: CallOptions) {
    const caller = await this.caller(this.currentOwner());
    return this.router.query(embedding, k, { ...options, caller });
  }
  async getById(id: string, options?: CallOptions) {
    const caller = await this.caller(this.currentOwner());
    return this.router.getById(id, { ...options, caller });
  }
  healthCheck() {
    return this.router.healthCheck();
  }
  writer() {
    return this.router.writer();
  }
  async recordTurn(input: {
    owner: string;
    userText: string;
    assistantText: string;
    id?: string;
  }) {
    const caller = await this.caller(input.owner);
    if (!caller) return false;
    return this.router.recordTurn({ ...input, caller });
  }
  async listTurns(owner: string) {
    const caller = await this.caller(owner);
    return caller ? this.router.listTurns(caller) : [];
  }
  async forgetOwner(owner: string): Promise<boolean> {
    const caller = await this.caller(owner);
    if (!caller) return false;
    try {
      await this.router.forgetSessionHistory(caller.sessionId);
      return true;
    } catch {
      return false;
    }
  }
  async turnCount(owner: string) {
    const turns = await this.listTurns(owner);
    const sessionId = parseTurnOwner(owner)?.sessionId;
    // Non-scanning stores track their actual retained ids in the router.
    // biome-ignore lint/complexity/useLiteralKeys: Inspect production retention state for stores without scan.
    const liveIds = this.router['liveIds'];
    const retained = sessionId ? (liveIds.get(sessionId)?.length ?? 0) : 0;
    return turns.length || retained;
  }
  storageBytes(ownerOrSession: string) {
    return this.router.storageBytes(
      parseTurnOwner(ownerOrSession)?.sessionId ?? ownerOrSession,
    );
  }
}

/** An observable in-memory provider; each collection has its own physical store. */
export function historyTestProvider(
  first: IRag = new InMemoryRag(),
): IRagProvider {
  const records = new Map<string, RagCollectionRecord>();
  const stores = new Map<string, IRag>();
  let initial = true;
  return {
    name: 'history-tests',
    kind: 'in-memory',
    editable: true,
    supportedScopes: ['session'],
    describeCollections: async () => ({
      ok: true,
      value: { records: [...records.values()], rejected: [] },
    }),
    createCollection: async (name, opts) => {
      if (opts.scope !== 'session')
        return { ok: false, error: new RagError('Session owner required') };
      if (records.has(name))
        return { ok: false, error: new RagError('Duplicate') };
      const rag = initial ? first : new InMemoryRag();
      initial = false;
      stores.set(name, rag);
      records.set(name, {
        scope: 'session',
        sessionId: opts.sessionId,
        name: opts.collectionName ?? name,
        storeName: name,
      });
      return { ok: true, value: handles(rag) };
    },
    openCollection: async (record) => {
      const rag = stores.get(record.storeName);
      return rag
        ? { ok: true, value: handles(rag) }
        : { ok: false, error: new RagError('Missing') };
    },
    deleteCollection: async (name) => {
      const rag = stores.get(name);
      if (rag?.writer?.()?.clearAll) {
        const result = await rag.writer?.()?.clearAll?.();
        if (result && !result.ok) return result;
      }
      records.delete(name);
      stores.delete(name);
      return { ok: true, value: undefined };
    },
  };
}
function handles(rag: IRag) {
  return {
    rag,
    editor: {
      upsert: async (): Promise<Result<{ id: string }, RagError>> => ({
        ok: false,
        error: new RagError('Use the router writer'),
      }),
      deleteById: async (): Promise<Result<boolean, RagError>> => ({
        ok: false,
        error: new RagError('Use the router writer'),
      }),
    },
  };
}
