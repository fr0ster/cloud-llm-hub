import { createHash } from 'node:crypto';
import type {
  IRagBackendWriter,
  IRagProvider,
  IRagScanner,
  IRunRecordStore,
  RunRecord,
} from '@mcp-abap-adt/llm-agent';
import { isRagScanner } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { z } from 'zod';
import type { RagConfig } from '../agent-config';
import { getRequestSessionId, getRequestUserId } from '../request-session';
import { ensureRunRecordStore } from './collection-persistence';
import {
  createCollectionProvider,
  defaultCtors,
  PROVIDER_DEFAULT_DIMENSION,
  type RagCtors,
} from './rag-provider-factory';
import { type SessionConfig, sessionConfig } from './session-config';

export const RUN_OUTPUT_CHAR_LIMIT = 4000;
export type DeletableRunRecordStore = IRunRecordStore & {
  hasRunRecord(userId: string, sessionId: string): boolean;
  delete(userId: string, sessionId: string): Promise<void>;
};
const str = z.string();
const num = z.number().finite();
const kind = z.enum(['work', 'check', 'ask', 'revise', 'answer']);
const context = z
  .object({
    spec: z.boolean().optional(),
    history: z.enum(['none', 'last-turn', 'all']).optional(),
    results: z.array(str).optional(),
    note: str.optional(),
  })
  .optional();
const step = z.discriminatedUnion('kind', [
  z.object({
    id: str,
    kind: z.literal('work'),
    goal: str,
    worker: str,
    context,
    maxRuns: num.optional(),
  }),
  z.object({
    id: str,
    kind: z.literal('check'),
    goal: str,
    worker: str,
    targets: z.array(str),
    context,
    onPass: str,
    onFail: str,
    onPartial: str.optional(),
    maxRuns: num.optional(),
  }),
  z.object({ id: str, kind: z.literal('ask'), question: str }),
  z.object({
    id: str,
    kind: z.literal('revise'),
    reason: str,
    maxRuns: num.optional(),
  }),
  z.object({
    id: str,
    kind: z.literal('answer'),
    from: str.optional(),
    text: str.optional(),
  }),
]);
const schema = z.object({
  runId: str,
  request: str,
  plan: z.object({
    spec: z
      .object({
        objective: str,
        raw: str,
        scope: str.optional(),
        constraints: z.array(str).optional(),
        deliverable: str.optional(),
      })
      .optional(),
    steps: z.array(step),
    createdAt: num,
  }),
  steps: z.array(
    z.object({
      stepId: str,
      kind,
      run: num,
      status: z.enum(['done', 'failed']),
      output: str,
      verdict: z
        .object({ verdict: z.enum(['pass', 'fail', 'partial']), reason: str })
        .optional(),
      error: str.optional(),
      durationMs: num,
    }),
  ),
  outcome: z.enum(['answered', 'asked', 'stopped', 'awaiting-external']),
  stopReason: str.optional(),
  finishedAt: num,
});
function stored(record: RunRecord): RunRecord {
  const copy = schema.parse(record);
  for (const s of copy.steps)
    s.output = s.output.slice(0, RUN_OUTPUT_CHAR_LIMIT);
  return copy;
}
function owner(sessionId: string): string | undefined {
  const userId = getRequestUserId();
  if (
    !userId ||
    !getRequestSessionId() ||
    getRequestSessionId() !== sessionId
  ) {
    cds
      .log('run-store')
      .debug(
        'Run record skipped: missing identity/session or mismatched session',
      );
    return undefined;
  }
  return userId;
}
export function runRecordId(userId: string, sessionId: string): string {
  return `run:${createHash('sha256')
    .update(JSON.stringify([userId, sessionId]))
    .digest('hex')}`;
}
export class MemoryRunRecordStore implements DeletableRunRecordStore {
  hasRunRecord(userId: string, sessionId: string): boolean {
    const key = runRecordId(userId, sessionId);
    const r = this.records.get(key);
    if (r && Date.now() - r.savedAt > this.ttlMs) this.records.delete(key);
    return this.records.has(key);
  }
  private readonly records = new Map<
    string,
    { record: RunRecord; savedAt: number }
  >();
  constructor(
    private readonly maxSessions: number = sessionConfig().maxSessions,
    private readonly ttlMs: number = sessionConfig().ttlMs,
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1)
      throw new Error('maxSessions must be a positive integer');
  }
  async load(sessionId: string): Promise<RunRecord | undefined> {
    const userId = owner(sessionId);
    if (!userId) return undefined;
    const key = runRecordId(userId, sessionId);
    const r = this.records.get(key);
    if (r && Date.now() - r.savedAt > this.ttlMs) {
      this.records.delete(key);
      return undefined;
    }
    return r && stored(r.record);
  }
  async save(sessionId: string, record: RunRecord): Promise<void> {
    const userId = owner(sessionId);
    if (!userId) return;
    const copy = stored(record);
    for (const [key, value] of this.records)
      if (Date.now() - value.savedAt > this.ttlMs) this.records.delete(key);
    const key = runRecordId(userId, sessionId);
    this.records.delete(key);
    this.records.set(key, { record: copy, savedAt: Date.now() });
    while (this.records.size > this.maxSessions) {
      const oldest = this.records.keys().next();
      if (!oldest.done) this.records.delete(oldest.value);
    }
  }
  async delete(userId: string, sessionId: string): Promise<void> {
    this.records.delete(runRecordId(userId, sessionId));
  }
}
type Opened = {
  scanner: IRagScanner;
  writer: IRagBackendWriter &
    Required<Pick<IRagBackendWriter, 'upsertPrecomputedRaw'>>;
};
export class ProviderRunRecordStore implements DeletableRunRecordStore {
  private readonly index = new Map<string, number>();
  hasRunRecord(userId: string, sessionId: string): boolean {
    for (const [key, savedAt] of this.index)
      if (Date.now() - savedAt > this.ttlMs) this.index.delete(key);
    return this.index.has(runRecordId(userId, sessionId));
  }
  private opening?: Promise<Opened>;
  private readonly zeroVector: number[];
  private readonly ttlMs: number;
  private readonly log: { warn(message: string, detail?: unknown): void };
  constructor(
    private readonly provider: IRagProvider,
    opts: {
      dimension: number;
      ttlMs?: number;
      log?: { warn(message: string, detail?: unknown): void };
    },
  ) {
    this.ttlMs = opts.ttlMs ?? sessionConfig().ttlMs;
    this.zeroVector = new Array<number>(opts.dimension).fill(0);
    this.log = opts.log ?? cds.log('run-store');
  }
  private store(): Promise<Opened> {
    if (!this.opening) {
      const run = this.open().catch((err) => {
        if (this.opening === run) this.opening = undefined;
        throw err;
      });
      this.opening = run;
    }
    return this.opening;
  }
  private async open(): Promise<Opened> {
    const r = await ensureRunRecordStore(this.provider);
    if (!r.ok) throw r.error;
    const writer = r.value.writer?.();
    if (!writer?.upsertPrecomputedRaw)
      throw new Error(
        'run record store requires upsertPrecomputedRaw; records are never embedded',
      );
    if (!isRagScanner(r.value))
      throw new Error('run record store cannot be scanned');
    return { scanner: r.value, writer: writer as Opened['writer'] };
  }
  async save(sessionId: string, record: RunRecord): Promise<void> {
    const userId = owner(sessionId);
    if (!userId) return;
    const text = JSON.stringify(stored(record));
    const savedAt = Date.now();
    const { writer } = await this.store();
    const r = await writer.upsertPrecomputedRaw(
      runRecordId(userId, sessionId),
      text,
      this.zeroVector,
      { userId, sessionId, savedAt },
    );
    if (!r.ok) throw r.error;
    this.hasRunRecord(userId, sessionId);
    this.index.set(runRecordId(userId, sessionId), savedAt);
  }
  async load(sessionId: string): Promise<RunRecord | undefined> {
    const userId = owner(sessionId);
    if (!userId) return undefined;
    const { scanner } = await this.store();
    let cursor: string | undefined;
    do {
      const page = await scanner.scan({
        filter: { userId, sessionId },
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (!page.ok) throw page.error;
      for (const row of page.value.records) {
        if (row.id !== runRecordId(userId, sessionId)) continue;
        if (
          row.metadata.userId !== userId ||
          row.metadata.sessionId !== sessionId
        )
          continue;
        if (
          typeof row.metadata.savedAt !== 'number' ||
          Date.now() - row.metadata.savedAt > this.ttlMs
        ) {
          await this.delete(userId, sessionId);
          return undefined;
        }
        try {
          const record = stored(schema.parse(JSON.parse(row.text)));
          this.index.set(row.id, row.metadata.savedAt);
          return record;
        } catch {
          this.log.warn('Skipped a malformed run record', { id: row.id });
        }
      }
      if (page.value.cursor !== undefined && page.value.cursor === cursor)
        throw new Error('run record store scan did not advance');
      cursor = page.value.cursor;
    } while (cursor !== undefined);
    return undefined;
  }
  async delete(userId: string, sessionId: string): Promise<void> {
    this.index.delete(runRecordId(userId, sessionId));
    const { writer } = await this.store();
    const r = await writer.deleteByIdRaw(runRecordId(userId, sessionId));
    if (!r.ok) throw r.error;
  }
}
const neverEmbedded = async (): Promise<never> => {
  throw new Error('run records are never embedded');
};
export function createRunRecordStore(
  cfg: SessionConfig,
  rag?: RagConfig,
  env: Record<string, string | undefined> = process.env,
  ctors: RagCtors = defaultCtors,
): DeletableRunRecordStore {
  if (cfg.store !== 'hana-vector' && cfg.store !== 'pg-vector')
    return new MemoryRunRecordStore(cfg.maxSessions, cfg.ttlMs);
  if (!rag)
    throw new Error('RAG configuration required for persistent run records');
  const provider = createCollectionProvider(
    rag,
    { retrieval: { embedDocument: neverEmbedded, embedQuery: neverEmbedded } },
    env,
    ctors,
    cfg.store,
  );
  if (!provider)
    throw new Error(`no provider for run record store "${cfg.store}"`);
  return new ProviderRunRecordStore(provider, {
    dimension: PROVIDER_DEFAULT_DIMENSION,
    ttlMs: cfg.ttlMs,
  });
}
let singleton: DeletableRunRecordStore | undefined;
/** Startup initializes this alongside the session record store. */
export function initializeRunRecordStore(
  cfg: SessionConfig,
  rag?: RagConfig,
): void {
  singleton = createRunRecordStore(cfg, rag);
}
export function getRunRecordStore(): DeletableRunRecordStore {
  if (!singleton) singleton = new MemoryRunRecordStore();
  return singleton;
}

/** Synchronous retention probe; provider records are indexed on save and load. */
export function hasRunRecord(userId: string, sessionId: string): boolean {
  return singleton?.hasRunRecord(userId, sessionId) ?? false;
}
