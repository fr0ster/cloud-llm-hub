import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  type CallOptions,
  DuplicateCollectionError,
  FallbackQueryEmbedding,
  httpStatusOf,
  type IQueryEmbedder,
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
  retryAfterSecondsOf,
  runWithThrottleRetry,
  stampRagOwner,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import {
  HISTORY_OPEN_COOL_DOWN_MS,
  WRITTEN_BY,
} from './collection-persistence';
import {
  chunkTurn,
  parseTurn,
  parseTurnOwner,
  renderTurn,
  type StoredTurn,
} from './history-turn';
import { runWithoutLlmSpend } from './llm-failure';
import { getHubRagAccess } from './rag-access';
import {
  sessionHistoryRepair,
  sessionHistoryWrite,
  withHistoryStoreTransport,
} from './session-history-write-scope';
import {
  trackHubBackendRepair,
  waitForBackendWork,
} from './tool-search-health';
import { resolverFor, type TrustResolver } from './trust-resolver';
import { storageSnapshots } from './usage/storage-snapshot';
import { storageEnabled } from './usage/storage-values';

export function historyCollectionName(sessionId: string): string {
  if (!sessionId.trim()) throw new Error('History requires a sessionId');
  return `h_hist_${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}

/** `created`: this call made the collection, so it starts empty. */
type Handles = { rag: IRag; editor: IRagEditor; created?: true };

interface QueuedTurn {
  caller: RagCaller;
  userText: string;
  assistantText: string;
  id: string;
  createdAt: string;
  clientToolCallIds?: string[];
  onStored?: () => Promise<void>;
}

interface TurnQueue {
  turns: QueuedTurn[];
  running?: Promise<boolean>;
  repair?: Promise<void>;
}

function turnChunkId(turnId: string, index: number): string {
  return `${turnId}:chunk:${index.toString().padStart(8, '0')}`;
}

function storedClientToolCalls(metadata: RagMetadata): string[] {
  const ids = metadata.clientToolCallIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string')
    : [];
}

/** Probe cadence after non-429 failures. Retained writes have no retry deadline. */
export const SESSION_HISTORY_RETRY_INTERVAL_MS = 2000;
// Repair keeps the explicitly bound caller, independent of the request context.
const historyRepairScope = new AsyncResource('SessionHistoryRepair');

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
  if (created.ok)
    return { ok: true, value: { ...created.value, created: true } };
  if (created.error instanceof OrphanStoreError)
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
  storeUrl?: string;
  queryEmbedder?: IQueryEmbedder;
  storageBackend?: string;
  storePrefix?: string;
  maxTurns?: number;
  now?: () => Date;
  clock?: () => number;
  trustResolver?: () => TrustResolver;
  log?: {
    warn(
      message: string,
      data?: { error: string; sessionHash?: string; turnId?: string },
    ): void;
  };
}

/** A single builder hook; every operation routes from the bound CallOptions.caller. */
export class SessionHistoryRouter implements IRag, IRagEditor {
  private readonly turnQueues = new Map<string, TurnQueue>();
  private readonly writeShutdown = new AbortController();
  private acceptingWrites = true;

  async drainWrites(): Promise<void> {
    this.acceptingWrites = false;
    await Promise.allSettled([
      ...[...this.turnQueues.values()].map(async (queue) => {
        await queue.running;
        await queue.repair;
      }),
      ...[...this.pending.values()].flatMap((writes) => [...writes]),
    ]);
  }

  /** Abort outstanding work when shutdown cannot wait for the queue. */
  async stopWrites(): Promise<void> {
    this.acceptingWrites = false;
    this.writeShutdown.abort();
    await Promise.allSettled([
      ...[...this.turnQueues.values()].flatMap((queue) => [
        queue.running,
        queue.repair,
      ]),
      ...[...this.pending.values()].flatMap((writes) => [...writes]),
    ]);
    this.turnQueues.clear();
  }

  /** A disconnect cancels only admission's wait, never an already owed write. */
  async waitForTurns(sessionId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const queue = this.turnQueues.get(sessionId);
    if (!queue) return;
    const shutdown = this.writeShutdown.signal;
    const waiting = signal ? AbortSignal.any([signal, shutdown]) : shutdown;
    if (queue.running && !queue.repair)
      await waitForBackendWork(
        queue.running.then(() => {}),
        waiting,
      );
    if (queue.repair) await waitForBackendWork(queue.repair, waiting);
    waiting.throwIfAborted();
  }

  private drainTurns(sessionId: string, queue: TurnQueue): Promise<boolean> {
    if (queue.running) return queue.running;
    const signal = this.writeShutdown.signal;
    queue.running = (async () => {
      while (queue.turns.length) {
        if (signal.aborted) return false;
        const turn = queue.turns[0];
        if (
          !(await sessionHistoryWrite.run(true, () =>
            withHistoryStoreTransport(this.options.storeUrl, signal, () =>
              this.storeTurn(turn, signal, () =>
                this.startRepair(sessionId, queue, signal),
              ),
            ),
          ))
        )
          return false;
        queue.turns.shift();
        await turn.onStored?.();
      }
      this.turnQueues.delete(sessionId);
      return true;
    })().finally(() => {
      queue.running = undefined;
    });
    return queue.running;
  }

  private startRepair(
    sessionId: string,
    queue: TurnQueue,
    signal: AbortSignal,
  ): void {
    if (queue.repair || signal.aborted) return;
    queue.repair = historyRepairScope.runInAsyncScope(() =>
      this.repairTurns(sessionId, queue, signal),
    );
    trackHubBackendRepair(
      queue,
      'Session history unavailable: backend or embedder failed',
      queue.repair,
    );
  }

  private async repairTurns(
    sessionId: string,
    queue: TurnQueue,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cadence = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_HISTORY_RETRY_INTERVAL_MS);
        timer.unref();
      });
      try {
        await waitForBackendWork(cadence, signal);
      } catch {
        return; // The router is shutting down.
      } finally {
        clearTimeout(timer);
      }
      // Replay the retained payloads and IDs with the breaker bypassed.
      // A sibling chunk may still be waiting on Retry-After in the current run.
      if (
        await sessionHistoryRepair.run(true, () =>
          this.drainTurns(sessionId, queue),
        )
      )
        return;
    }
  }
  private readonly writeContext = new AsyncLocalStorage<ReadonlySet<string>>();
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
    signal?: AbortSignal,
  ): Promise<Result<Handles | undefined, RagError>> {
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    if (!result.ok) {
      this.failedOpens.set(sessionId, { at: now, error: result.error });
      this.options.log?.warn('Session history open failed', {
        error: result.error.constructor.name,
      });
    } else {
      this.failedOpens.delete(sessionId);
      // A collection made by this call is empty: a known zero baseline.
      if (
        result.value?.created &&
        storageEnabled() &&
        !this.measured?.has(sessionId)
      ) {
        this.measured ??= new Map();
        this.measured.set(sessionId, new Map());
        this.measuredTotals.set(sessionId, 0);
      }
    }
    return result;
  }

  private readonly liveIds = new Map<string, string[]>();
  private cleared?: Set<string>;
  private readonly measuredTotals = new Map<string, number>();
  private readonly baselines = new Map<string, Promise<void>>();
  /** Sessions with a delete that landed while their baseline scan ran. */
  private readonly staleBaselines = new Set<string>();
  private measured?: Map<string, Map<string, number>>;

  constructor(
    private readonly provider: IRagProvider,
    private readonly options: SessionHistoryRouterOptions = {},
  ) {}

  setQueryEmbedder(embedder: IQueryEmbedder | undefined): void {
    this.options.queryEmbedder = embedder;
  }

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
    if (!this.writeContext.getStore()?.has(caller.sessionId)) {
      await this.waitForTurns(caller.sessionId, options?.signal);
      await Promise.allSettled(this.pending.get(caller.sessionId) ?? []);
    }
    const opened = await this.open(caller.sessionId, false);
    if (!opened.ok) return opened;
    if (!opened.value) return { ok: true, value: [] };
    const scoped = this.scoped(caller, options);
    const queryEmbedding = this.options.queryEmbedder
      ? new FallbackQueryEmbedding(
          embedding,
          this.options.queryEmbedder,
          scoped,
        )
      : embedding;
    const identity = ragIdentityFilter(scoped);
    const turns = new Map<string, RagResult>();
    let size = k;
    if (k <= 0) return { ok: true, value: [] };
    while (true) {
      const result = await opened.value.rag.query(queryEmbedding, size, scoped);
      if (!result.ok) return result;
      for (const row of result.value) {
        if (!matchesRagIdentity(row.metadata, identity)) continue;
        const id = row.metadata.turnId ?? row.metadata.id;
        if (typeof id !== 'string') continue;
        const previous = turns.get(id);
        if (!previous || row.score > previous.score) turns.set(id, row);
      }
      if (turns.size >= k || result.value.length < size) break;
      size *= 2;
    }
    const value: RagResult[] = [];
    for (const [turnId, best] of [...turns]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, k)) {
      const count =
        typeof best.metadata.chunkCount === 'number'
          ? best.metadata.chunkCount
          : 1;
      const rows: { id: string; text: string; metadata: RagMetadata }[] = [];
      for (let index = 0; index < count; index++) {
        const id =
          count === 1
            ? turnId
            : `${turnId}:chunk:${index.toString().padStart(8, '0')}`;
        const result = await opened.value.rag.getById(id, scoped);
        if (
          result.ok &&
          result.value &&
          matchesRagIdentity(result.value.metadata, identity)
        )
          rows.push({ id, ...result.value });
      }
      if (rows.length !== count)
        this.options.log?.warn('Session history chunks missing', {
          sessionHash: historyCollectionName(caller.sessionId),
          turnId,
          error: 'IncompleteTurn',
        });
      const turn = assembleTurns(rows)[0];
      if (!turn) value.push(this.trustedRow(best));
      if (turn)
        value.push(
          this.trustedRow({
            text: renderTurn(turn.userText, turn.assistantText),
            metadata: { ...best.metadata, turnId, createdAt: turn.createdAt },
            score: best.score,
          }),
        );
    }
    return { ok: true, value };
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
        this.writeExternal(id, text, metadata, options),
      deleteByIdRaw: (id, options) => this.deleteById(id, options),
    };
  }

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>> {
    const id = typeof metadata.id === 'string' ? metadata.id : randomUUID();
    const result = await this.writeExternal(id, text, metadata, options);
    return result.ok ? { ok: true, value: { id } } : result;
  }

  private async writeExternal(
    id: string,
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (!this.acceptingWrites)
      return {
        ok: false,
        error: new RagError('History writer is shutting down', 'ABORTED'),
      };
    const shutdown = this.writeShutdown.signal;
    const signal = options?.signal
      ? AbortSignal.any([options.signal, shutdown])
      : shutdown;
    return this.write(id, text, metadata, { ...options, signal });
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
    const context = new Set(this.writeContext.getStore());
    context.add(sessionId);
    const work = this.writeContext.run(context, () =>
      this.writeValidated(id, text, metadata, options),
    );
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
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
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
    if (isRagScanner(rag) && Number.isFinite(this.options.maxTurns)) {
      try {
        const rows = await this.rows(caller.sessionId, rag);
        const overflow = rows.slice(
          0,
          Math.max(
            0,
            rows.length - (this.options.maxTurns ?? Number.POSITIVE_INFINITY),
          ),
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
      if (Number.isFinite(this.options.maxTurns) && !ids.includes(id))
        ids.push(id);
      this.liveIds.set(caller.sessionId, ids);
      // A running total needs a known baseline: rows written before this
      // process (or after a failed revive read) are not in the map, so adding
      // to an empty map would publish a partial size as the whole one.
      if (
        storageEnabled() &&
        isRagScanner(rag) &&
        !this.measured?.has(caller.sessionId) &&
        !this.cleared?.has(caller.sessionId)
      ) {
        const scan =
          this.baselines.get(caller.sessionId) ??
          this.rows(caller.sessionId, rag)
            .then((rows) => {
              // A delete during the scan may still be in these rows.
              if (!this.staleBaselines.has(caller.sessionId))
                this.measure(caller, rows);
            })
            .catch((error) =>
              this.options.log?.warn('Session history size: scan failed', {
                error: String(error),
              }),
            )
            .finally(() => {
              this.baselines.delete(caller.sessionId);
              this.staleBaselines.delete(caller.sessionId);
            });
        this.baselines.set(caller.sessionId, scan);
        await scan;
      }
      if (
        storageEnabled() &&
        (this.measured?.has(caller.sessionId) ||
          this.cleared?.has(caller.sessionId))
      ) {
        this.measured ??= new Map();
        const measured =
          this.measured.get(caller.sessionId) ?? new Map<string, number>();
        const bytes = Buffer.byteLength(text, 'utf8');
        this.measuredTotals.set(
          caller.sessionId,
          (this.measuredTotals.get(caller.sessionId) ?? 0) +
            bytes -
            (measured.get(id) ?? 0),
        );
        measured.set(id, bytes);
        this.measured.set(caller.sessionId, measured);
        this.cleared?.delete(caller.sessionId);
      }
      const overflow = ids.splice(
        0,
        Math.max(
          0,
          ids.length - (this.options.maxTurns ?? Number.POSITIVE_INFINITY),
        ),
      );
      for (const old of overflow) {
        const removed = await writer.deleteByIdRaw(old);
        if (removed.ok && removed.value) {
          this.markDeleted(caller.sessionId);
          const measured = this.measured?.get(caller.sessionId);
          this.measuredTotals.set(
            caller.sessionId,
            (this.measuredTotals.get(caller.sessionId) ?? 0) -
              (measured?.get(old) ?? 0),
          );
          measured?.delete(old);
        }
      }
      const historyBytes = this.storageBytes(caller.sessionId);
      if (storageEnabled() && historyBytes !== undefined)
        storageSnapshots().update?.(caller, { historyBytes });
    }

    return result;
  }

  private markDeleted(sessionId: string): void {
    if (this.baselines.has(sessionId)) this.staleBaselines.add(sessionId);
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
    if (!writer) return { ok: true, value: false };
    const result = await writer.deleteByIdRaw(id, this.scoped(caller, options));
    if (result.ok && result.value) {
      this.markDeleted(caller.sessionId);
      const measured = this.measured?.get(caller.sessionId);
      this.measuredTotals.set(
        caller.sessionId,
        (this.measuredTotals.get(caller.sessionId) ?? 0) -
          (measured?.get(id) ?? 0),
      );
      measured?.delete(id);
      const ids = this.liveIds.get(caller.sessionId);
      if (ids)
        this.liveIds.set(
          caller.sessionId,
          ids.filter((entry) => entry !== id),
        );
      const historyBytes = this.storageBytes(caller.sessionId);
      if (storageEnabled() && historyBytes !== undefined)
        storageSnapshots().update?.(caller, { historyBytes });
    }
    return result;
  }

  async recordTurn(input: {
    caller: RagCaller;
    userText: string;
    assistantText: string;
    id?: string;
    clientToolCallIds?: string[];
    onStored?: () => Promise<void>;
  }): Promise<boolean> {
    if (!input.caller.sessionId.trim() || !this.acceptingWrites) return false;
    const sessionId = input.caller.sessionId;
    const queue = this.turnQueues.get(sessionId) ?? {
      turns: [],
    };
    this.turnQueues.set(sessionId, queue);
    queue.turns.push({
      ...input,
      id: input.id ?? `turn:${randomUUID()}`,
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
    });
    // The retained history queue drains independently of response delivery.
    return queue.repair
      ? false
      : runWithoutLlmSpend(() => this.drainTurns(sessionId, queue));
  }

  private async storeTurn(
    input: QueuedTurn,
    signal: AbortSignal,
    failed: () => void,
  ): Promise<boolean> {
    const turnId = input.id;
    const chunks = chunkTurn(input.userText, input.assistantText);
    // Start every write before awaiting: session deletion waits for all chunks.
    const outcomes = await Promise.all(
      chunks.map(async (chunk, chunkIndex) => {
        try {
          await runWithThrottleRetry(
            async () => {
              // Retry the catalog too: it may throttle before an upsert is reached.
              this.failedOpens.delete(input.caller.sessionId);
              const result = await this.write(
                chunks.length === 1 ? turnId : turnChunkId(turnId, chunkIndex),
                renderTurn(chunk.userText, chunk.assistantText),
                {
                  turnId,
                  chunkIndex,
                  chunkCount: chunks.length,
                  userContinuation: chunk.userContinuation,
                  createdAt: input.createdAt,
                  userTextLength: chunk.userText.length,
                  ...(chunkIndex === 0 && input.clientToolCallIds?.length
                    ? { clientToolCallIds: input.clientToolCallIds }
                    : {}),
                },
                {
                  caller: input.caller,
                  sessionId: input.caller.sessionId,
                  signal,
                },
              );
              if (!result.ok) throw result.error;
            },
            {
              key: `session-history-store:${this.options.storageBackend ?? 'local'}`,
              strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }),
              signal,
              isThrottled: (error) =>
                error instanceof Error && httpStatusOf(error) === 429,
              retryAfterSeconds: (error) =>
                error instanceof Error ? retryAfterSecondsOf(error) : undefined,
            },
          );
          return true;
        } catch (error) {
          if (!signal.aborted) {
            failed();
            this.options.log?.warn('Session history write failed', {
              sessionHash: historyCollectionName(input.caller.sessionId),
              turnId,
              error:
                error instanceof Error ? error.constructor.name : typeof error,
            });
          }
          return false;
        }
      }),
    );
    return outcomes.every(Boolean);
  }

  private async rows(sessionId: string, rag: IRag, options?: CallOptions) {
    if (!isRagScanner(rag)) throw new RagError('History cannot scan');
    const rows: { id: string; text: string; metadata: RagMetadata }[] = [];
    let cursor: string | undefined;
    do {
      const page = await rag.scan(
        {
          filter: { sessionId },
          ...(cursor === undefined ? {} : { cursor }),
        },
        options,
      );
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
    this.measuredTotals.set(
      caller.sessionId,
      rows.reduce((sum, row) => sum + Buffer.byteLength(row.text, 'utf8'), 0),
    );
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
      ? this.measuredTotals.get(sessionId)
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
    return assembleTurns(rows);
  }

  /** Find a completed turn by ID or by one of the calls it issued. */
  async findClientToolTurn(
    caller: RagCaller,
    id: string,
    signal: AbortSignal,
    callIds: readonly string[] = [],
  ): Promise<{ id: string; callIds: string[] } | undefined> {
    signal.throwIfAborted();
    const options: CallOptions = { signal };
    // The binding store and provider catalog do not accept call options.
    const opened = await withHistoryStoreTransport(
      this.options.storeUrl,
      signal,
      async () => {
        if (!(await this.caller({ caller }))) return undefined;
        return this.open(caller.sessionId, false, signal);
      },
    );
    if (!opened) return undefined;
    if (!opened.ok) throw opened.error;
    const rag = opened.value?.rag;
    if (!rag) return undefined;
    const single = await rag.getById(id, options);
    if (!single.ok) throw single.error;
    if (single.value?.metadata.turnId === id)
      return { id, callIds: storedClientToolCalls(single.value.metadata) };
    const first = await rag.getById(turnChunkId(id, 0), options);
    if (!first.ok) throw first.error;
    const count = first.value?.metadata.chunkCount;
    if (first.value && typeof count === 'number' && count > 1) {
      let index = 1;
      for (; index < count; index++) {
        const part = await rag.getById(turnChunkId(id, index), options);
        if (!part.ok) throw part.error;
        if (part.value?.metadata.chunkCount !== count) break;
      }
      if (index === count)
        return { id, callIds: storedClientToolCalls(first.value.metadata) };
    }
    if (!callIds.length || !isRagScanner(rag)) return undefined;

    const rows = await this.rows(caller.sessionId, rag, options);
    const requested = new Set(callIds);
    for (const { metadata } of rows) {
      const { turnId, chunkCount } = metadata;
      const storedIds = storedClientToolCalls(metadata);
      if (
        typeof turnId === 'string' &&
        storedIds.some((callId) => requested.has(callId)) &&
        rows.filter((row) => row.metadata.turnId === turnId).length ===
          chunkCount
      )
        return { id: turnId, callIds: storedIds };
    }
    return undefined;
  }

  async forgetSessionHistory(sessionId: string): Promise<void> {
    await this.waitForTurns(sessionId);
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
      this.measuredTotals.delete(sessionId);
      this.liveIds.delete(sessionId);
    }
  }
}

/** Installed alongside the singleton builder history hook. */
let activeRouter: SessionHistoryRouter | undefined;
export function initSessionHistoryRouter(router: SessionHistoryRouter): void {
  activeRouter = router;
}
export async function drainSessionHistoryWrites(): Promise<void> {
  await activeRouter?.drainWrites();
}
export async function stopSessionHistoryWrites(): Promise<void> {
  await activeRouter?.stopWrites();
}
export async function forgetSessionHistory(sessionId: string): Promise<void> {
  await activeRouter?.forgetSessionHistory(sessionId);
}

/** Waiting does not create a provider when this process has never owed a turn. */
export async function waitForSessionHistoryTurns(
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await activeRouter?.waitForTurns(sessionId, signal);
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
    const refused = new Set<string>();
    const bindings = getHubRagAccess().access.bindings;
    for (const { groups } of batches) {
      for (const [sessionId, group] of groups) {
        try {
          const binding = await bindings.getUserId(sessionId);
          if (!binding.ok) {
            refused.add(sessionId);
          } else if (binding.value === null || binding.value === undefined) {
            const bound = await bindings.bind(sessionId, group.userId);
            if (!bound.ok) refused.add(sessionId);
          } else if (binding.value !== group.userId) {
            refused.add(sessionId);
          }
        } catch {
          refused.add(sessionId);
        }
      }
    }
    if (refused.size > 0)
      return {
        ok: false,
        error: new RagError(
          `Shared history session binding refused: ${[...refused].sort().join(', ')}`,
        ),
      };
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

function assembleTurns(
  rows: { id: string; text: string; metadata: RagMetadata }[],
): StoredTurn[] {
  const turns = new Map<string, StoredTurn>();
  for (const row of rows) {
    const parsed = parseTurn(
      row.text,
      typeof row.metadata.userTextLength === 'number'
        ? row.metadata.userTextLength
        : undefined,
    );
    if (!parsed) continue;
    const turnId =
      typeof row.metadata.turnId === 'string' ? row.metadata.turnId : row.id;
    const turn = turns.get(turnId) ?? {
      id: turnId,
      userText: '',
      assistantText: '',
      createdAt: String(row.metadata.createdAt ?? ''),
    };
    if (row.metadata.userContinuation === true)
      turn.userText += parsed.userText;
    else {
      if (!turn.userText) turn.userText = parsed.userText;
      turn.assistantText += parsed.assistantText;
    }
    turns.set(turnId, turn);
  }
  return [...turns.values()];
}
