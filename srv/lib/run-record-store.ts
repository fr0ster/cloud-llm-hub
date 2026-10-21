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
  delete(sessionId: string): Promise<void>;
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
export class MemoryRunRecordStore implements DeletableRunRecordStore {
  private readonly records = new Map<string, RunRecord>();
  constructor(
    private readonly maxSessions: number = sessionConfig().maxSessions,
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1)
      throw new Error('maxSessions must be a positive integer');
  }
  async load(sessionId: string): Promise<RunRecord | undefined> {
    const r = this.records.get(sessionId);
    return r && stored(r);
  }
  async save(sessionId: string, record: RunRecord): Promise<void> {
    const copy = stored(record);
    this.records.delete(sessionId);
    this.records.set(sessionId, copy);
    while (this.records.size > this.maxSessions) {
      const oldest = this.records.keys().next();
      if (!oldest.done) this.records.delete(oldest.value);
    }
  }
  async delete(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
  }
}
type Opened = {
  scanner: IRagScanner;
  writer: IRagBackendWriter &
    Required<Pick<IRagBackendWriter, 'upsertPrecomputedRaw'>>;
};
export class ProviderRunRecordStore implements DeletableRunRecordStore {
  private opening?: Promise<Opened>;
  private readonly zeroVector: number[];
  private readonly log: { warn(message: string, detail?: unknown): void };
  constructor(
    private readonly provider: IRagProvider,
    opts: {
      dimension: number;
      log?: { warn(message: string, detail?: unknown): void };
    },
  ) {
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
    const text = JSON.stringify(stored(record));
    const { writer } = await this.store();
    const r = await writer.upsertPrecomputedRaw(
      `run:${sessionId}`,
      text,
      this.zeroVector,
      { sessionId },
    );
    if (!r.ok) throw r.error;
  }
  async load(sessionId: string): Promise<RunRecord | undefined> {
    const { scanner } = await this.store();
    let cursor: string | undefined;
    do {
      const page = await scanner.scan({
        filter: { sessionId },
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (!page.ok) throw page.error;
      for (const row of page.value.records) {
        if (row.id !== `run:${sessionId}`) continue;
        try {
          return stored(schema.parse(JSON.parse(row.text)));
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
  async delete(sessionId: string): Promise<void> {
    const { writer } = await this.store();
    const r = await writer.deleteByIdRaw(`run:${sessionId}`);
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
    return new MemoryRunRecordStore(cfg.maxSessions);
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
