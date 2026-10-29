import { createHash } from 'node:crypto';
import type {
  DialogueState,
  IDialogueStateStore,
  IRagBackendWriter,
  IRagProvider,
  IRagScanner,
} from '@mcp-abap-adt/llm-agent';
import { isRagScanner } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { z } from 'zod';
import type { RagConfig } from '../agent-config';
import { dialogueMaxTasks } from '../agent-config';
import { ensureDialogueStore } from './collection-persistence';
import type { OutboxEntry } from './dialogue-outbox';
import { guardedTask } from './guarded-task';
import {
  createCollectionProvider,
  defaultCtors,
  PROVIDER_DEFAULT_DIMENSION,
  type RagCtors,
} from './rag-provider-factory';
import { type SessionConfig, sessionConfig } from './session-config';
import { storageSnapshots } from './usage/storage-snapshot';
import { type DialogueBytes, storageEnabled } from './usage/storage-values';

type Plan = Exclude<DialogueState['plan'], string | undefined>;
type PlanStep = Plan['steps'][number];
type TaskRecord = DialogueState['tasks'][number];

export type HubDialogueState = DialogueState & {
  outbox?: OutboxEntry[];
  ackMode?: boolean;
};

export const DIALOGUE_BYTE_LIMIT = 2 * 1024 * 1024;
export interface DialogueStoreBackend {
  storageBytes?(userId: string, sessionId: string): DialogueBytes | undefined;
  load(
    userId: string,
    sessionId: string,
  ): Promise<HubDialogueState | undefined>;
  save(
    userId: string,
    sessionId: string,
    state: HubDialogueState,
  ): Promise<void>;
  delete(userId: string, sessionId: string): Promise<void>;
  hasDialogueState(userId: string, sessionId: string): boolean;
  sweepExpired(now: number): Promise<void>;
}
const str = z.string();
const num = z.number().finite();
const tokenUsage = z.object({
  promptTokens: num,
  completionTokens: num,
  totalTokens: num,
  models: z
    .record(
      str,
      z.object({
        promptTokens: num,
        completionTokens: num,
        totalTokens: num,
        requests: num,
      }),
    )
    .optional(),
});
const plannerUsage = z.object({
  planner: tokenUsage.optional(),
  plannerMs: num.optional(),
  tasks: z
    .array(
      z.object({
        id: str,
        worker: str,
        usage: tokenUsage,
        durationMs: num.optional(),
      }),
    )
    .optional(),
});
const message = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: str.max(20000).nullable(),
  tool_call_id: str.optional(),
  tool_calls: z
    .array(
      z.object({
        id: str,
        type: z.literal('function'),
        function: z.object({ name: str, arguments: str }),
      }),
    )
    .optional(),
});
// Require every exported field (including optional ones) and its exact type.
// Library additions or changes must be reflected here at compile time.
type Shape<T> = { [K in keyof T]-?: z.ZodType<T[K]> };
function planSchema<S extends z.ZodType<Plan>>(
  schema: S & (Plan extends z.output<S> ? unknown : never),
): S {
  return schema;
}
const boundedText = str.max(20000);
const id = str.max(1000);
const ids = z.array(id).max(1000);
const check = z.object({
  by: z.enum(['planner', 'checker']),
  goal: boundedText,
  verdict: z.enum(['pass', 'fail']).optional(),
  taskId: id.optional(),
} satisfies Shape<NonNullable<PlanStep['check']>>);
const planStep = z.object({
  id,
  goal: boundedText,
  items: z.array(boundedText).max(1000).optional(),
  dependsOn: ids.optional(),
  worker: id.optional(),
  state: z.enum([
    'pending',
    'running',
    'checking',
    'done',
    'failed',
    'skipped',
    'blocked',
  ]),
  check: check.optional(),
  workTaskId: id.optional(),
  successfulWorkTaskId: id.optional(),
  taskIds: ids,
  note: boundedText.optional(),
} satisfies Shape<PlanStep>);
const structuredPlan = planSchema(
  z.object({
    scopeConsent: z.boolean().optional(),
    version: z.literal(1),
    steps: z.array(planStep).max(1000),
    status: z.enum(['active', 'waiting_user', 'done']),
    question: boundedText.optional(),
    // Restored legacy text plans become this note; use the overall byte limit.
    note: str.optional(),
  } satisfies Shape<Plan>),
);
const schema = z.object({
  conversation: z.array(message).max(200),
  // Legacy text plans are bounded by the overall state byte limit only.
  plan: z.union([str, structuredPlan]).optional(),
  planStatus: z.enum(['active', 'waiting_user', 'done']).optional(),
  taskSteps: z
    .record(id, id)
    .superRefine((value, ctx) => {
      if (Object.keys(value).length > 1000)
        ctx.addIssue({
          code: 'custom',
          message: 'Dialogue task step limit exceeded',
        });
    })
    .optional(),
  tasks: z
    .array(
      z.object({
        id: str,
        worker: str,
        goal: str,
        state: z.enum([
          'queued',
          'running',
          'done',
          'failed',
          'stopped',
          'interrupted',
        ]),
        usage: tokenUsage.optional(),
        budgetExhausted: z.boolean().optional(),
        toolsSelected: num.optional(),
        toolsAvailable: num.optional(),
        toolCalls: num.optional(),
        maxToolCalls: num.optional(),
        output: str.optional(),
        error: str.optional(),
        createdAt: num,
        startedAt: num.optional(),
        finishedAt: num.optional(),
      } satisfies Shape<TaskRecord>),
    )
    .superRefine((tasks, ctx) => {
      if (tasks.length > dialogueMaxTasks())
        ctx.addIssue({
          code: 'custom',
          message: 'Dialogue task limit exceeded',
        });
    }),
  pending: z.array(
    z.object({
      id: str,
      text: str,
      createdAt: num,
      trigger: z.enum(['user', 'event']),
      usage: plannerUsage.optional(),
    }),
  ),
  savedAt: num,
});
function stored(record: HubDialogueState): HubDialogueState {
  const text = JSON.stringify(record);
  if (Buffer.byteLength(text, 'utf8') > DIALOGUE_BYTE_LIMIT)
    throw new Error('Dialogue state exceeds 2 MB');
  const raw = JSON.parse(text);
  const state = schema.parse(raw.state ?? raw);
  const outbox = raw.outbox;
  const ackMode = z
    .boolean()
    .optional()
    .parse(raw.ackMode ?? raw.state?.ackMode);
  const parsed =
    outbox === undefined
      ? undefined
      : z
          .array(
            schema.shape.pending.element.extend({
              confirmed: z.boolean().optional(),
            }),
          )
          .parse(outbox);
  return {
    ...state,
    ...(parsed?.length ? { outbox: parsed } : {}),
    ...(ackMode !== undefined ? { ackMode } : {}),
  };
}
function encode(
  record: HubDialogueState,
  log: { warn(message: string): void },
): HubDialogueState | undefined {
  try {
    return stored(record);
  } catch {
    log.warn('Skipped malformed or oversized dialogue state');
    return undefined;
  }
}
export function dialogueId(userId: string, sessionId: string): string {
  return `dialogue:${createHash('sha256')
    .update(JSON.stringify([userId, sessionId]))
    .digest('hex')}`;
}
function dialogueBytes(
  record: HubDialogueState,
  envelope: boolean = false,
): DialogueBytes {
  const { outbox, ...state } = record;
  const { ackMode, ...body } = state;
  return {
    stateBytes: Buffer.byteLength(
      JSON.stringify(envelope ? { state: body, ackMode } : state),
      'utf8',
    ),
    outboxBytes: Buffer.byteLength(JSON.stringify(outbox ?? []), 'utf8'),
  };
}
function invalidateDialogueBytes(id: string): void {
  if (storageEnabled()) storageSnapshots().invalidateDialogue?.(id);
}
export class MemoryDialogueStore implements DialogueStoreBackend {
  private removeRecord(id: string): void {
    if (this.records.delete(id)) invalidateDialogueBytes(id);
  }
  storageBytes(userId: string, sessionId: string): DialogueBytes | undefined {
    const entry = this.records.get(dialogueId(userId, sessionId));
    if (!entry || Date.now() - entry.savedAt > this.ttlMs)
      return { stateBytes: 0, outboxBytes: 0 };
    return entry.bytes;
  }
  hasDialogueState(userId: string, sessionId: string): boolean {
    const key = dialogueId(userId, sessionId);
    const r = this.records.get(key);
    if (r && Date.now() - r.savedAt > this.ttlMs) this.removeRecord(key);
    return this.records.has(key);
  }
  private readonly records = new Map<
    string,
    { record: HubDialogueState; savedAt: number; bytes?: DialogueBytes }
  >();
  constructor(
    private readonly maxSessions: number = sessionConfig().maxSessions,
    private readonly ttlMs: number = sessionConfig().ttlMs,
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1)
      throw new Error('maxSessions must be a positive integer');
  }
  async sweepExpired(now: number): Promise<void> {
    for (const [key, value] of this.records)
      if (now - value.savedAt > this.ttlMs) this.removeRecord(key);
  }
  async load(
    userId: string,
    sessionId: string,
  ): Promise<HubDialogueState | undefined> {
    const key = dialogueId(userId, sessionId);
    const r = this.records.get(key);
    if (r && Date.now() - r.savedAt > this.ttlMs) {
      this.removeRecord(key);
      return undefined;
    }
    return r && stored(r.record);
  }
  async save(
    userId: string,
    sessionId: string,
    record: HubDialogueState,
  ): Promise<void> {
    const copy = encode(record, cds.log('dialogue-store'));
    if (!copy) return;
    for (const [key, value] of this.records)
      if (Date.now() - value.savedAt > this.ttlMs) this.removeRecord(key);
    const key = dialogueId(userId, sessionId);
    this.removeRecord(key);
    const entry: {
      record: HubDialogueState;
      savedAt: number;
      bytes?: DialogueBytes;
    } = { record: copy, savedAt: Date.now() };
    this.records.set(key, entry);
    if (storageEnabled()) {
      const bytes = dialogueBytes(copy);
      entry.bytes = bytes;
      storageSnapshots().update?.({ userId, sessionId }, { ...bytes });
    }
    while (this.records.size > this.maxSessions) {
      const oldest = this.records.keys().next();
      if (!oldest.done) this.removeRecord(oldest.value);
    }
  }
  async delete(userId: string, sessionId: string): Promise<void> {
    this.removeRecord(dialogueId(userId, sessionId));
  }
}
type Opened = {
  scanner: IRagScanner;
  writer: IRagBackendWriter &
    Required<Pick<IRagBackendWriter, 'upsertPrecomputedRaw'>>;
};
export class ProviderDialogueStore implements DialogueStoreBackend {
  private byteCounters?: Map<string, DialogueBytes>;
  storageBytes(userId: string, sessionId: string): DialogueBytes | undefined {
    const id = dialogueId(userId, sessionId);
    const savedAt = this.index.get(id);
    if (savedAt !== undefined && Date.now() - savedAt > this.ttlMs)
      return { stateBytes: 0, outboxBytes: 0 };
    return this.byteCounters?.get(id);
  }
  async sweepExpired(now: number): Promise<void> {
    const { scanner, writer } = await this.store();
    let cursor: string | undefined;
    do {
      const page = await scanner.scan({
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (!page.ok) throw page.error;
      for (const row of page.value.records) {
        const { userId, sessionId, savedAt } = row.metadata;
        try {
          if (
            typeof userId !== 'string' ||
            typeof sessionId !== 'string' ||
            typeof savedAt !== 'number' ||
            !Number.isFinite(savedAt) ||
            row.id !== dialogueId(userId, sessionId)
          )
            throw new Error('Malformed metadata');
          if (Buffer.byteLength(row.text, 'utf8') > DIALOGUE_BYTE_LIMIT)
            throw new Error('Dialogue state exceeds 2 MB');
          stored(JSON.parse(row.text));
        } catch {
          this.index.delete(row.id);
          this.byteCounters?.delete(row.id);
          this.log.warn('Skipped a malformed dialogue state', { id: row.id });
          continue;
        }
        if (now - (savedAt as number) > this.ttlMs) {
          const result = await writer.deleteByIdRaw(row.id);
          if (!result.ok) throw result.error;
          this.index.delete(row.id);
          this.byteCounters?.delete(row.id);
          invalidateDialogueBytes(row.id);
        }
      }
      if (page.value.cursor !== undefined && page.value.cursor === cursor)
        throw new Error('dialogue state store scan did not advance');
      cursor = page.value.cursor;
    } while (cursor !== undefined);
  }
  private readonly index = new Map<string, number>();
  hasDialogueState(userId: string, sessionId: string): boolean {
    for (const [key, savedAt] of this.index)
      if (Date.now() - savedAt > this.ttlMs) {
        this.index.delete(key);
        this.byteCounters?.delete(key);
        invalidateDialogueBytes(key);
      }
    return this.index.has(dialogueId(userId, sessionId));
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
    this.log = opts.log ?? cds.log('dialogue-store');
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
    const r = await ensureDialogueStore(this.provider);
    if (!r.ok) throw r.error;
    const writer = r.value.writer?.();
    if (!writer?.upsertPrecomputedRaw)
      throw new Error(
        'dialogue state store requires upsertPrecomputedRaw; records are never embedded',
      );
    if (!isRagScanner(r.value))
      throw new Error('dialogue state store cannot be scanned');
    return { scanner: r.value, writer: writer as Opened['writer'] };
  }
  async save(
    userId: string,
    sessionId: string,
    record: HubDialogueState,
  ): Promise<void> {
    const copy = encode(record, this.log);
    if (!copy) return;
    const { outbox, ackMode, ...state } = copy;
    const text = JSON.stringify({ state, outbox: outbox ?? [], ackMode });
    const savedAt = Date.now();
    const { writer } = await this.store();
    const r = await writer.upsertPrecomputedRaw(
      dialogueId(userId, sessionId),
      text,
      this.zeroVector,
      { userId, sessionId, savedAt },
    );
    if (!r.ok) throw r.error;
    this.hasDialogueState(userId, sessionId);
    this.index.set(dialogueId(userId, sessionId), savedAt);
    if (storageEnabled()) {
      this.byteCounters ??= new Map<string, DialogueBytes>();
      const bytes = dialogueBytes(copy, true);
      this.byteCounters.set(dialogueId(userId, sessionId), bytes);
      storageSnapshots().update?.({ userId, sessionId }, { ...bytes });
    }
  }
  async load(
    userId: string,
    sessionId: string,
  ): Promise<HubDialogueState | undefined> {
    const { scanner } = await this.store();
    let cursor: string | undefined;
    do {
      const page = await scanner.scan({
        filter: { userId, sessionId },
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (!page.ok) throw page.error;
      for (const row of page.value.records) {
        if (row.id !== dialogueId(userId, sessionId)) continue;
        if (
          row.metadata.userId !== userId ||
          row.metadata.sessionId !== sessionId
        )
          continue;
        if (
          typeof row.metadata.savedAt !== 'number' ||
          !Number.isFinite(row.metadata.savedAt)
        ) {
          this.log.warn('Skipped a malformed dialogue state', { id: row.id });
          this.index.delete(row.id);
          this.byteCounters?.delete(row.id);
          return undefined;
        }
        if (Date.now() - row.metadata.savedAt > this.ttlMs) {
          await this.delete(userId, sessionId);
          return undefined;
        }
        try {
          if (Buffer.byteLength(row.text, 'utf8') > DIALOGUE_BYTE_LIMIT)
            throw new Error('Dialogue state exceeds 2 MB');
          const record = stored(JSON.parse(row.text));
          this.index.set(row.id, row.metadata.savedAt);
          if (storageEnabled()) {
            this.byteCounters ??= new Map<string, DialogueBytes>();
            this.byteCounters.set(row.id, dialogueBytes(record, true));
          }
          return record;
        } catch {
          this.index.delete(row.id);
          this.byteCounters?.delete(row.id);
          this.log.warn('Skipped a malformed dialogue state', { id: row.id });
        }
      }
      if (page.value.cursor !== undefined && page.value.cursor === cursor)
        throw new Error('dialogue state store scan did not advance');
      cursor = page.value.cursor;
    } while (cursor !== undefined);
    return undefined;
  }
  async delete(userId: string, sessionId: string): Promise<void> {
    this.index.delete(dialogueId(userId, sessionId));
    this.byteCounters?.delete(dialogueId(userId, sessionId));
    const { writer } = await this.store();
    const r = await writer.deleteByIdRaw(dialogueId(userId, sessionId));
    if (!r.ok) throw r.error;
    invalidateDialogueBytes(dialogueId(userId, sessionId));
  }
}
const neverEmbedded = async (): Promise<never> => {
  throw new Error('dialogue states are never embedded');
};
export function createDialogueStoreBackend(
  cfg: SessionConfig,
  rag?: RagConfig,
  env: Record<string, string | undefined> = process.env,
  ctors: RagCtors = defaultCtors,
): DialogueStoreBackend {
  if (cfg.store !== 'hana-vector' && cfg.store !== 'pg-vector')
    return new MemoryDialogueStore(cfg.maxSessions, cfg.ttlMs);
  if (!rag)
    throw new Error(
      'RAG configuration required for persistent dialogue states',
    );
  const provider = createCollectionProvider(
    rag,
    { retrieval: { embedDocument: neverEmbedded, embedQuery: neverEmbedded } },
    env,
    ctors,
    cfg.store,
  );
  if (!provider)
    throw new Error(`no provider for dialogue state store "${cfg.store}"`);
  return new ProviderDialogueStore(provider, {
    dimension: PROVIDER_DEFAULT_DIMENSION,
    ttlMs: cfg.ttlMs,
  });
}
let singleton: DialogueStoreBackend | undefined;
/** Startup initializes this alongside the session record store. */
export function initializeDialogueStore(
  cfg: SessionConfig,
  rag?: RagConfig,
): void {
  touches.clear();
  singleton = createDialogueStoreBackend(cfg, rag);
  guardedTask(
    'Dialogue-state expiry sweep',
    cds.log('dialogue-store'),
    () => sweepDialogueStates(),
    { errorTypeOnly: true },
  )();
}
let sweeping = false;
/** Shared by startup and the existing session sweep; skip overlapping passes. */
export async function sweepDialogueStates(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await singleton?.sweepExpired?.(Date.now());
  } finally {
    sweeping = false;
  }
}
export function getDialogueStoreBackend(): DialogueStoreBackend {
  if (!singleton) singleton = new MemoryDialogueStore();
  return singleton;
}

/** Synchronous retention probe; provider records are indexed on save and load. */
export function hasDialogueState(userId: string, sessionId: string): boolean {
  return singleton?.hasDialogueState(userId, sessionId) ?? false;
}

/** Bind identity once; library ids cannot select another session. */
export function createDialogueStateStore(
  userId: string,
  key: string,
): IDialogueStateStore {
  const matches = (id: string): boolean => {
    if (id === key) return true;
    cds
      .log('dialogue-store')
      .debug('Dialogue state skipped: mismatched session');
    return false;
  };
  return {
    load: async (id) =>
      matches(id) ? getDialogueStoreBackend().load(userId, key) : undefined,
    save: async (id, state) => {
      if (matches(id)) await getDialogueStoreBackend().save(userId, key, state);
    },
    delete: async (id) => {
      if (matches(id)) await deleteDialogueState(userId, key);
    },
  };
}
export async function deleteDialogueState(
  userId: string,
  key: string,
): Promise<void> {
  touches.delete(dialogueId(userId, key));
  await getDialogueStoreBackend().delete(userId, key);
}

const touches = new Map<string, number>();
export async function touchDialogueState(
  userId: string,
  key: string,
  refresh?: () => Promise<void>,
): Promise<void> {
  const id = dialogueId(userId, key);
  const now = Date.now();
  if (now - (touches.get(id) ?? -Infinity) < 60_000) return;
  touches.set(id, now);
  try {
    if (refresh) {
      await refresh();
      return;
    }
    const backend = getDialogueStoreBackend();
    const state = await backend.load(userId, key);
    if (state) await backend.save(userId, key, state);
  } catch (error) {
    touches.delete(id);
    throw error;
  }
}
