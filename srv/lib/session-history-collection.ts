import { createHash, randomUUID } from 'node:crypto';
import {
  type CallOptions,
  DuplicateCollectionError,
  type IQueryEmbedding,
  type IRag,
  type IRagBackendWriter,
  type IRagEditor,
  type IRagProvider,
  isRagScanner,
  matchesRagIdentity,
  OrphanStoreError,
  type RagCaller,
  RagError,
  type RagMetadata,
  type RagResult,
  type RagScanRecord,
  type Result,
  ragIdentityFilter,
  stampRagOwner,
} from '@mcp-abap-adt/llm-agent';
import {
  HISTORY_OPEN_COOL_DOWN_MS,
  WRITTEN_BY,
} from './collection-persistence';
import {
  parseTurn,
  parseTurnOwner,
  renderTurn,
  type StoredTurn,
} from './history-turn';
import { getHubRagAccess } from './rag-access';
import { resolverFor, type TrustResolver } from './trust-resolver';
import { storageSnapshots } from './usage/storage-snapshot';
import { storageEnabled } from './usage/storage-values';

export function historyCollectionName(sessionId: string): string {
  if (!sessionId.trim()) throw new Error('History requires a sessionId');
  return `h_hist_${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}

type Handles = { rag: IRag; editor: IRagEditor };

/** History uses the session collection owner in the same provider catalog as other collections. */
async function openHistory(
  provider: IRagProvider,
  sessionId: string,
  create: boolean,
  prefix?: string,
): Promise<Result<Handles | undefined, RagError>> {
  const name = historyCollectionName(sessionId);
  const store = prefix ? `${prefix}_${name}` : name;
  if (!provider.describeCollections || !provider.openCollection)
    return {
      ok: false,
      error: new RagError('History requires a provider catalog'),
    };
  const catalog = await provider.describeCollections();
  if (!catalog.ok) return catalog;
  const record = catalog.value.records.find((r) => r.storeName === store);
  if (record) {
    if (
      record.scope !== 'session' ||
      record.sessionId !== sessionId ||
      record.name !== name
    )
      return {
        ok: false,
        error: new RagError(`Conflicting history owner: ${store}`),
      };
    return provider.openCollection(record);
  }
  if (!create) return { ok: true, value: undefined };
  const opts = {
    scope: 'session' as const,
    sessionId,
    collectionName: name,
    attributes: { writtenBy: WRITTEN_BY, source: 'session-history' },
  };
  let created = await provider.createCollection(store, opts);
  if (!created.ok && created.error instanceof OrphanStoreError)
    created = await provider.createCollection(store, {
      ...opts,
      adoptExisting: true,
    });
  if (
    !created.ok &&
    (created.error instanceof DuplicateCollectionError ||
      created.error.code === 'RAG_DUPLICATE_COLLECTION')
  )
    return openHistory(provider, sessionId, false, prefix);
  return created;
}

export interface SessionHistoryRouterOptions {
  storageBackend?: string;
  storePrefix?: string;
  maxTurns?: number;
  now?: () => Date;
  clock?: () => number;
  trustResolver?: () => TrustResolver;
  log?: { warn(message: string, data?: { error: string }): void };
}

/** A single builder hook; every operation routes from the bound CallOptions.caller. */
export class SessionHistoryRouter implements IRag, IRagEditor {
  private readonly pending = new Map<
    string,
    Set<Promise<Result<void, RagError>>>
  >();
  private readonly failedOpens = new Map<
    string,
    { at: number; error: RagError }
  >();

  private async open(
    sessionId: string,
    create: boolean,
  ): Promise<Result<Handles | undefined, RagError>> {
    const now = this.options.clock?.() ?? Date.now();
    const failed = this.failedOpens.get(sessionId);
    if (failed && now - failed.at < HISTORY_OPEN_COOL_DOWN_MS)
      return { ok: false, error: failed.error };
    const result = await openHistory(
      this.provider,
      sessionId,
      create,
      this.options.storePrefix,
    );
    if (!result.ok) {
      this.failedOpens.set(sessionId, { at: now, error: result.error });
      this.options.log?.warn('Session history open failed', {
        error: result.error.message,
      });
    } else this.failedOpens.delete(sessionId);
    return result;
  }

  private readonly liveIds = new Map<string, string[]>();
  private cleared?: Set<string>;
  private measured?: Map<string, Map<string, number>>;

  constructor(
    private readonly provider: IRagProvider,
    private readonly options: SessionHistoryRouterOptions = {},
  ) {}

  get storageBackend(): string | undefined {
    return this.options.storageBackend;
  }

  private async caller(options?: CallOptions): Promise<RagCaller | undefined> {
    const caller = options?.caller;
    if (!caller?.sessionId.trim() || !caller.userId.trim()) return undefined;
    if (
      options?.sessionId !== undefined &&
      options.sessionId !== caller.sessionId
    )
      return undefined;
    const filter = options?.ragFilter;
    if (
      filter?.sessionId !== undefined &&
      filter.sessionId !== caller.sessionId
    )
      return undefined;
    if (
      filter?.owner &&
      (filter.owner.scope !== 'session' ||
        filter.owner.sessionId !== caller.sessionId)
    )
      return undefined;
    const binding = await getHubRagAccess().access.bindings.getUserId(
      caller.sessionId,
    );
    return binding.ok && binding.value === caller.userId ? caller : undefined;
  }

  private scoped(caller: RagCaller, options?: CallOptions): CallOptions {
    return {
      ...options,
      caller,
      sessionId: caller.sessionId,
      ragFilter: {
        owner: { scope: 'session', sessionId: caller.sessionId },
        sessionId: caller.sessionId,
      },
    };
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const caller = await this.caller(options);
    if (!caller) return { ok: true, value: [] };
    const opened = await this.open(caller.sessionId, false);
    if (!opened.ok) return opened;
    if (!opened.value) return { ok: true, value: [] };
    const result = await opened.value.rag.query(
      embedding,
      k,
      this.scoped(caller, options),
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: result.value
        .filter((row) =>
          matchesRagIdentity(
            row.metadata,
            ragIdentityFilter(this.scoped(caller, options)),
          ),
        )
        .map((row) => this.trustedRow(row)),
    };
  }

  private trustedRow(row: RagResult): RagResult {
    return {
      ...row,
      metadata: {
        ...row.metadata,
        source: 'session',
        trust: (
          this.options.trustResolver?.() ??
          resolverFor({ currentMeta: () => undefined })
        ).classDefault('session'),
      },
    };
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    const caller = await this.caller(options);
    if (!caller) return { ok: true, value: null };
    const opened = await this.open(caller.sessionId, false);
    if (!opened.ok) return opened;
    if (!opened.value) return { ok: true, value: null };
    const result = await opened.value.rag.getById(
      id,
      this.scoped(caller, options),
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value:
        result.value &&
        matchesRagIdentity(
          result.value.metadata,
          ragIdentityFilter(this.scoped(caller, options)),
        )
          ? this.trustedRow(result.value)
          : null,
    };
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    return { ok: true, value: undefined };
  }

  writer(): IRagBackendWriter {
    return {
      upsertRaw: (id, text, metadata, options) =>
        this.write(id, text, metadata, options),
      deleteByIdRaw: (id, options) => this.deleteById(id, options),
    };
  }

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>> {
    const id = typeof metadata.id === 'string' ? metadata.id : randomUUID();
    const result = await this.write(id, text, metadata, options);
    return result.ok ? { ok: true, value: { id } } : result;
  }

  private async write(
    id: string,
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    const sessionId = options?.caller?.sessionId;
    if (!sessionId?.trim()) return { ok: true, value: undefined };
    // Register before binding/catalog I/O so session cleanup also waits for a late write.
    const work = this.writeValidated(id, text, metadata, options);
    const pending =
      this.pending.get(sessionId) ?? new Set<Promise<Result<void, RagError>>>();
    this.pending.set(sessionId, pending);
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
      if (!pending.size) this.pending.delete(sessionId);
    }
  }

  private async writeValidated(
    id: string,
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    const caller = await this.caller(options);
    return caller
      ? this.writeBound(caller, id, text, metadata, options)
      : { ok: false, error: new RagError('History requires a bound caller') };
  }

  private async writeBound(
    caller: RagCaller,
    id: string,
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    const opened = await this.open(caller.sessionId, true);
    if (!opened.ok) return opened;
    const rag = opened.value?.rag;
    const writer = rag?.writer?.();
    if (!rag || !writer)
      return { ok: false, error: new RagError('History writer unavailable') };
    const {
      owner: _owner,
      userId: _userId,
      roleId: _roleId,
      sessionId: _sessionId,
      ...rest
    } = metadata;
    const result = await writer.upsertRaw(
      id,
      text,
      stampRagOwner(
        {
          ...rest,
          authorUserId: caller.userId,
          createdAt:
            metadata.createdAt ??
            (this.options.now?.() ?? new Date()).toISOString(),
        },
        { scope: 'session', sessionId: caller.sessionId },
      ),
      this.scoped(caller, options),
    );
    if (!result.ok) return result;
    if (isRagScanner(rag)) {
      try {
        const rows = await this.rows(caller.sessionId, rag);
        const overflow = rows.slice(
          0,
          Math.max(0, rows.length - (this.options.maxTurns ?? 200)),
        );
        const removedIds = new Set<string>();
        for (const row of overflow) {
          const removed = await writer.deleteByIdRaw(row.id);
          if (!removed.ok) throw removed.error;
          removedIds.add(row.id);
        }
        this.measure(
          caller,
          rows.filter((row) => !removedIds.has(row.id)),
        );
      } catch (error) {
        this.options.log?.warn('Session history cap: delete failed', {
          error: String(error),
        });
        this.measured?.delete(caller.sessionId);
      }
    } else {
      const ids = this.liveIds.get(caller.sessionId) ?? [];
      if (!ids.includes(id)) ids.push(id);
      this.liveIds.set(caller.sessionId, ids);
      if (storageEnabled()) {
        this.measured ??= new Map();
        const measured =
          this.measured.get(caller.sessionId) ?? new Map<string, number>();
        measured.set(id, Buffer.byteLength(text, 'utf8'));
        this.measured.set(caller.sessionId, measured);
        this.cleared?.delete(caller.sessionId);
      }
      const overflow = ids.splice(
        0,
        Math.max(0, ids.length - (this.options.maxTurns ?? 200)),
      );
      for (const old of overflow) {
        const removed = await writer.deleteByIdRaw(old);
        if (removed.ok && removed.value)
          this.measured?.get(caller.sessionId)?.delete(old);
      }
      const historyBytes = this.storageBytes(caller.sessionId);
      if (storageEnabled() && historyBytes !== undefined)
        storageSnapshots().update?.(caller, { historyBytes });
    }

    return result;
  }

  async deleteById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<boolean, RagError>> {
    const caller = await this.caller(options);
    if (!caller) return { ok: true, value: false };
    const opened = await this.open(caller.sessionId, false);
    if (!opened.ok) return opened;
    const writer = opened.value?.rag.writer?.();
    return writer
      ? writer.deleteByIdRaw(id, this.scoped(caller, options))
      : { ok: true, value: false };
  }

  async recordTurn(input: {
    caller: RagCaller;
    userText: string;
    assistantText: string;
    id?: string;
  }): Promise<boolean> {
    try {
      if (!input.caller.sessionId.trim()) return false;
      const result = await this.write(
        input.id ?? `turn:${randomUUID()}`,
        renderTurn(input.userText, input.assistantText),
        {},
        { caller: input.caller, sessionId: input.caller.sessionId },
      );
      if (!result.ok && !this.failedOpens.has(input.caller.sessionId))
        this.options.log?.warn('Session history write failed', {
          error: result.error.message,
        });
      return result.ok;
    } catch (error) {
      this.options.log?.warn('Session history write failed', {
        error: String(error),
      });
      return false;
    }
  }

  private async rows(sessionId: string, rag: IRag) {
    if (!isRagScanner(rag)) throw new RagError('History cannot scan');
    const rows: { id: string; text: string; metadata: RagMetadata }[] = [];
    let cursor: string | undefined;
    do {
      const page = await rag.scan({
        filter: { sessionId },
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!page.ok) throw page.error;
      rows.push(...page.value.records);
      if (page.value.cursor !== undefined && page.value.cursor === cursor)
        throw new RagError('History scan did not advance');
      cursor = page.value.cursor;
    } while (cursor !== undefined);
    return rows.sort(
      (a, b) =>
        String(a.metadata.createdAt ?? '').localeCompare(
          String(b.metadata.createdAt ?? ''),
        ) || a.id.localeCompare(b.id),
    );
  }

  private measure(
    caller: RagCaller,
    rows: { id: string; text: string }[],
  ): void {
    if (!storageEnabled()) return;
    this.cleared?.delete(caller.sessionId);
    this.measured ??= new Map();
    this.measured.set(
      caller.sessionId,
      new Map(rows.map((row) => [row.id, Buffer.byteLength(row.text, 'utf8')])),
    );
    storageSnapshots().update?.(caller, {
      historyBytes: rows.reduce(
        (sum, row) => sum + Buffer.byteLength(row.text, 'utf8'),
        0,
      ),
    });
  }

  storageBytes(sessionId: string): number | undefined {
    const rows = this.measured?.get(sessionId);
    return rows
      ? [...rows.values()].reduce((sum, bytes) => sum + bytes, 0)
      : this.cleared?.has(sessionId)
        ? 0
        : undefined;
  }

  async listTurns(caller: RagCaller): Promise<StoredTurn[]> {
    if (!(await this.caller({ caller }))) return [];
    const opened = await this.open(caller.sessionId, false);
    if (!opened.ok) throw opened.error;
    if (opened.value && !isRagScanner(opened.value.rag)) return [];
    const rows = opened.value
      ? await this.rows(caller.sessionId, opened.value.rag)
      : [];
    this.measure(caller, rows);
    return rows.flatMap((row) => {
      const parsed = parseTurn(row.text);
      return parsed
        ? [
            {
              id: row.id,
              ...parsed,
              createdAt: String(row.metadata.createdAt ?? ''),
            },
          ]
        : [];
    });
  }

  async forgetSessionHistory(sessionId: string): Promise<void> {
    await Promise.allSettled(this.pending.get(sessionId) ?? []);
    try {
      const name = historyCollectionName(sessionId);
      const store = this.options.storePrefix
        ? `${this.options.storePrefix}_${name}`
        : name;
      const opened = await openHistory(
        this.provider,
        sessionId,
        false,
        this.options.storePrefix,
      );
      if (!opened.ok) throw opened.error;
      if (opened.value) {
        if (!this.provider.deleteCollection)
          throw new RagError('History cannot delete collections');
        const removed = await this.provider.deleteCollection(store);
        if (!removed.ok) throw removed.error;
      }
      if (storageEnabled()) {
        this.cleared ??= new Set();
        this.cleared.add(sessionId);
        while (this.cleared.size > 256) {
          const oldest = this.cleared.values().next();
          if (!oldest.done) this.cleared?.delete(oldest.value);
        }
        const binding =
          await getHubRagAccess().access.bindings.getUserId(sessionId);
        if (binding.ok && binding.value)
          storageSnapshots().update?.(
            { sessionId, userId: binding.value },
            { historyBytes: 0 },
          );
      }
    } catch (error) {
      this.cleared?.delete(sessionId);
      this.options.log?.warn('Session history forget failed', {
        error: String(error),
      });
      throw error;
    } finally {
      this.failedOpens.delete(sessionId);
      this.measured?.delete(sessionId);
      this.liveIds.delete(sessionId);
    }
  }
}

/** Installed alongside the singleton builder history hook. */
let activeRouter: SessionHistoryRouter | undefined;
export function initSessionHistoryRouter(router: SessionHistoryRouter): void {
  activeRouter = router;
}
export async function forgetSessionHistory(sessionId: string): Promise<void> {
  await activeRouter?.forgetSessionHistory(sessionId);
}

/** Copy completely before deleting the shared store; stable ids make retries safe. */
export async function migrateSharedHistory(
  provider: IRagProvider,
): Promise<Result<{ moved: number }, RagError>> {
  try {
    if (
      !provider.describeCollections ||
      !provider.openCollection ||
      !provider.deleteCollection
    )
      return {
        ok: false,
        error: new RagError('History migration requires catalog/open/delete'),
      };
    const catalog = await provider.describeCollections();
    if (!catalog.ok) return catalog;
    let moved = 0;
    const batches: {
      storeName: string;
      prefix?: string;
      groups: Map<string, { userId: string; rows: RagScanRecord[] }>;
    }[] = [];
    for (const record of catalog.value.records.filter(
      (r) => r.name === 'h_history',
    )) {
      const opened = await provider.openCollection(record);
      if (!opened.ok) return opened;
      const rag = opened.value.rag;
      if (!isRagScanner(rag))
        return { ok: false, error: new RagError('Shared history cannot scan') };
      const prefix =
        record.storeName === 'h_history'
          ? undefined
          : record.storeName.slice(0, -'_h_history'.length);
      const rows: RagScanRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await rag.scan(cursor === undefined ? {} : { cursor });
        if (!page.ok) return page;
        rows.push(...page.value.records);
        if (page.value.cursor !== undefined && page.value.cursor === cursor)
          return {
            ok: false,
            error: new RagError('Shared history scan did not advance'),
          };
        cursor = page.value.cursor;
      } while (cursor !== undefined);
      const invalid = rows.filter((row) => {
        const { owner, userId, sessionId } = row.metadata;
        const tuple =
          typeof owner === 'string' ? parseTurnOwner(owner) : undefined;
        return (
          typeof userId !== 'string' ||
          !userId.trim() ||
          typeof sessionId !== 'string' ||
          !sessionId.trim() ||
          !tuple ||
          tuple.userId !== userId ||
          tuple.sessionId !== sessionId
        );
      });
      if (invalid.length)
        return {
          ok: false,
          error: new RagError(
            `Invalid shared history identities: ${invalid.map((row) => `${record.storeName}/${row.id}`).join(', ')}`,
          ),
        };
      // A legacy session used by multiple users cannot become a single-owner collection.
      const groups = new Map<
        string,
        { userId: string; rows: RagScanRecord[] }
      >();
      for (const row of rows) {
        const { sessionId, userId } = row.metadata;
        if (
          typeof sessionId !== 'string' ||
          !sessionId.trim() ||
          typeof userId !== 'string' ||
          !userId.trim()
        )
          return {
            ok: false,
            error: new RagError(
              `Unresolved shared history identity: ${record.storeName}/${row.id}`,
            ),
          };
        const group = groups.get(sessionId);
        if (group !== undefined && group.userId !== userId)
          return {
            ok: false,
            error: new RagError(
              `Conflicting shared history users: ${[...group.rows, row].map((item) => `${record.storeName}/${item.id}`).join(', ')}`,
            ),
          };
        if (group) group.rows.push(row);
        else groups.set(sessionId, { userId, rows: [row] });
      }
      batches.push({ storeName: record.storeName, prefix, groups });
    }
    // Every source row has passed validation before the first target is created.
    for (const { storeName, prefix, groups } of batches) {
      for (const [sessionId, group] of groups) {
        const target = await openHistory(provider, sessionId, true, prefix);
        if (!target.ok) return target;
        const writer = target.value?.rag.writer?.();
        if (!writer)
          return {
            ok: false,
            error: new RagError('Migration history writer unavailable'),
          };
        for (const row of group.rows) {
          const {
            sessionId: _sessionId,
            userId: _userId,
            owner: _owner,
            roleId: _roleId,
            ...metadata
          } = row.metadata;
          const written = await writer.upsertRaw(
            row.id,
            row.text,
            stampRagOwner(
              { ...metadata, authorUserId: group.userId },
              { scope: 'session', sessionId },
            ),
          );
          if (!written.ok) return written;
          moved++;
        }
      }
      const deleted = await provider.deleteCollection(storeName);
      if (!deleted.ok) return deleted;
    }
    return { ok: true, value: { moved } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof RagError ? error : new RagError(String(error)),
    };
  }
}
