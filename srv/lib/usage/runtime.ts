import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type {
  IUsageControl,
  IUsageRecorder,
  IUsageSink,
  UsageContext,
} from '@mcp-abap-adt/llm-agent';
import {
  combineSinks,
  createUsageRecorder,
  directTransport,
  type IUsageReader,
  jsonlFileSink,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import { createHanaUsageSink } from '@mcp-abap-adt/llm-usage-hana';
import { createPgUsageSink } from '@mcp-abap-adt/llm-usage-pg';
import type { SqliteUsageSink } from '@mcp-abap-adt/llm-usage-sqlite';
import type { RagConfig } from '../../agent-config';
import { hanaConnection, pgConnection } from '../rag-provider-factory';
import {
  isMeasure,
  type Measure,
  type SinkName,
  type UsageConfig,
} from './config';
import { setUsageRuntimeForTest, usageRuntime } from './runtime-state';

export { setUsageRuntimeForTest, usageRuntime } from './runtime-state';

import { MigratableBuffer } from './migratable-buffer';
import { configureStorageAggregates } from './storage-aggregates';

type Sink = IUsageSink &
  Partial<IUsageReader> & {
    deleteOlderThan?(ms: number): Promise<number | undefined>;
  };
export interface UsageDeps {
  rag?: RagConfig;
  env?: NodeJS.ProcessEnv;
  factories?: Partial<Record<SinkName, () => Sink | Promise<Sink>>>;
  now?: () => number;
  setInterval?: (
    tick: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  clearInterval?: typeof clearInterval;
  log?: { warn(message: string): void };
  recorderFactory?: typeof createUsageRecorder;
  probeTimeoutMs?: number;
}
const BACKEND_TIMEOUT_MS = 10000;
export interface UsageStatus {
  enabled: true;
  sinks: SinkName[];
  fallback: string[];
  buffered: number;
  delivered: number;
  lost: Record<string, number>;
  unconfirmed: number;
  lastErrorCode?: string;
  sqliteFileSize?: number;
}
export interface UsageRuntime {
  sqliteSnapshot?(): Promise<ReadableStream<Uint8Array>>;
  recorder: IUsageRecorder;
  forSession(s: {
    sessionId: string;
    userId: string;
    destination?: string;
  }): IUsageRecorder;
  status(): UsageStatus;
  enabled(kind: Measure): boolean;
  /** Future storage/process meters register only when their measure is enabled. */
  schedule(kind: Measure, tick: () => void, intervalMs: number): void;
  onClose(stop: () => void): void;
  close(timeoutMs: number): ReturnType<IUsageControl['close']>;
}
const readable = (s: Sink): s is Sink & IUsageReader =>
  typeof s.read === 'function';

export async function initUsage(
  cfg: UsageConfig,
  deps: UsageDeps = {},
): Promise<UsageRuntime | undefined> {
  if (!cfg.enabled) return undefined;
  const now = deps.now ?? Date.now;
  const timers: ReturnType<typeof setInterval>[] = [];
  const every: NonNullable<UsageDeps['setInterval']> =
    deps.setInterval ?? setInterval;
  const cancel = deps.clearInterval ?? clearInterval;
  const log = deps.log ?? console;
  const sinks: Sink[] = [];
  let sqliteSink: SqliteUsageSink | undefined;
  const fallback: string[] = [];
  let lastErrorCode: string | undefined;
  let closed = false;
  const closeHooks = new Set<() => void>();
  const warn = (code: string) => {
    lastErrorCode = code;
    log.warn(`Usage runtime: ${code}`);
  };
  const schedule = (tick: () => void, ms: number) => {
    const timer = every(tick, ms);
    timer.unref?.();
    timers.push(timer);
  };
  // Resolve backend configuration before opening any resources.
  const factories = { ...deps.factories };
  for (const name of cfg.sinks) {
    if (factories[name]) continue;
    if (name === 'hana') {
      if (!deps.rag)
        throw new Error('Usage hana sink requires HANA backend configuration');
      const options = hanaConnection(deps.rag, deps.env);
      factories.hana = () =>
        createHanaUsageSink({ ...options, autoCreateSchema: false });
    } else if (name === 'pg') {
      if (!deps.rag?.pg?.url)
        throw new Error(
          'Usage pg sink requires PostgreSQL backend configuration',
        );
      const options = pgConnection(deps.rag);
      const credential = options.credential;
      const password = credential ? await credential.secret() : undefined;
      const pgOptions = {
        connectionString: options.connectionString,
        schema: options.schema,
        user: credential?.principal,
        password,
        // Connect is bounded; statements are not: a timed-out retention DELETE
        // rolls back whole and would never make progress on a large backlog.
        connectionTimeoutMillis: BACKEND_TIMEOUT_MS,
      };
      factories.pg = () => createPgUsageSink(pgOptions);
    } else if (name === 'sqlite') {
      factories.sqlite = async () => {
        // Load lazily: an unavailable node:sqlite must not prevent hub startup.
        try {
          await import('node:sqlite');
        } catch {
          throw new Error('SQLITE_UNAVAILABLE');
        }
        const { createSqliteUsageSink } = await import(
          '@mcp-abap-adt/llm-usage-sqlite'
        );
        sqliteSink = createSqliteUsageSink({ path: cfg.sqlitePath });
        return sqliteSink;
      };
    } else if (name === 'jsonl') {
      if (!cfg.jsonlPath)
        throw new Error('LLM_AGENT_USAGE_JSONL_PATH is required for jsonl');
      const jsonlPath = cfg.jsonlPath;
      factories.jsonl = () =>
        jsonlFileSink({
          path: jsonlPath,
          rotateBytes: cfg.jsonlRotateBytes,
        });
    } else factories.memory = () => memorySink({ limit: cfg.memoryLimit });
  }
  const retention = async (sink: Sink) => {
    try {
      const result = await sink.deleteOlderThan?.(
        now() - cfg.retentionDays * 86400000,
      );
      if (result === undefined) warn('RETENTION_FAILED');
    } catch {
      warn('RETENTION_FAILED');
    }
  };
  try {
    for (const name of cfg.sinks) {
      let sink: Sink;
      try {
        const factory = factories[name];
        if (!factory) throw new Error('Missing usage sink factory');
        sink = await factory();
      } catch (error) {
        if (
          name !== 'sqlite' ||
          !(error instanceof Error) ||
          !/node:sqlite|SQLITE_UNAVAILABLE/.test(error.message)
        )
          throw error;
        sink = memorySink({ limit: cfg.memoryLimit });
        fallback.push('sqlite-unavailable');
        warn('SQLITE_UNAVAILABLE');
      }
      sinks.push(sink);
      let buffer: MigratableBuffer | undefined;
      if (name === 'hana') {
        // A deadline cannot cancel a backend request. Reuse any outstanding
        // request so retries never open overlapping probes after a timeout.
        let probing: Promise<void> | undefined;
        const probe = async () => {
          if (!probing) {
            probing = Promise.resolve().then(() => sink.write([]));
            const active = probing;
            void active.then(
              () => {
                if (probing === active) probing = undefined;
              },
              () => {
                if (probing === active) probing = undefined;
              },
            );
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              probing,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('HANA probe timed out')),
                  deps.probeTimeoutMs ?? BACKEND_TIMEOUT_MS,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        try {
          await probe();
        } catch (error) {
          const tableMissing =
            error instanceof Error &&
            /USAGE_RECORDS is unavailable/.test(error.message);
          const reason = tableMissing
            ? 'hana-table-missing'
            : 'hana-unavailable';
          if (!readable(sink)) throw new Error('HANA sink requires a reader');
          const target = sink;
          buffer = new MigratableBuffer(cfg.memoryLimit, target);
          const pending = buffer;
          sinks[sinks.length - 1] = pending;
          fallback.push(reason);
          warn(tableMissing ? 'HANA_TABLE_MISSING' : 'HANA_UNAVAILABLE');
          let checking = false;
          schedule(() => {
            if (checking || closed || pending.migrated) return;
            checking = true;
            void (async () => {
              try {
                await probe();
                if (closed) return;
                await pending.migrate(target);
                fallback.splice(fallback.indexOf(reason), 1);
                void retention(target);
              } catch {
                warn('HANA_MIGRATION_FAILED');
              } finally {
                checking = false;
              }
            })();
          }, 300000);
          // Own target resources even while writes use the buffer.
        }
      }
      if (['hana', 'pg', 'sqlite'].includes(name) && sink.deleteOlderThan) {
        if (!buffer) void retention(sink);
        schedule(() => {
          if (!buffer || buffer.migrated) void retention(sink);
        }, 86400000);
      }
    }
    const control = (deps.recorderFactory ?? createUsageRecorder)({
      transport: directTransport(combineSinks(...sinks)),
      now,
    });
    const wrap = (recorder: IUsageRecorder): IUsageRecorder => ({
      record(input: Parameters<IUsageRecorder['record']>[0]) {
        const kind =
          input.kind === 'x.hub.retrieval'
            ? 'request'
            : input.kind.startsWith('x.hub.')
              ? input.kind.slice(6).split('.')[0]
              : input.kind.split('.')[0];
        if (
          input.kind === 'x.usage.lost' ||
          (isMeasure(kind) && cfg.measure.includes(kind))
        )
          recorder.record(input);
      },
      with(context: UsageContext) {
        return wrap(recorder.with(context));
      },
    });
    const recorder = wrap(control);
    const activeSqlite = sqliteSink;
    const runtime: UsageRuntime = {
      ...(activeSqlite
        ? { sqliteSnapshot: () => activeSqlite.snapshot() }
        : {}),
      recorder,
      forSession(s) {
        return recorder.with({
          sessionId: s.sessionId,
          userId:
            cfg.userId === 'hash'
              ? createHash('sha256').update(s.userId).digest('hex')
              : s.userId,
          ...(s.destination ? { destination: s.destination } : {}),
        });
      },
      enabled: (kind) => cfg.measure.includes(kind),
      schedule(kind, tick, intervalMs) {
        if (cfg.measure.includes(kind) && !closed) schedule(tick, intervalMs);
      },
      onClose(stop: () => void): void {
        if (closed) stop();
        else closeHooks.add(stop);
      },
      status() {
        let sqliteFileSize: number | undefined;
        if (
          cfg.sinks.includes('sqlite') &&
          !fallback.includes('sqlite-unavailable')
        ) {
          try {
            sqliteFileSize = statSync(cfg.sqlitePath).size;
          } catch {}
        }
        const stats = control.stats();
        return {
          enabled: true,
          sinks: cfg.sinks,
          fallback: [...fallback],
          ...stats,
          unconfirmed: stats.unconfirmed ?? 0,
          lastErrorCode: stats.lastErrorCode ?? lastErrorCode,
          sqliteFileSize,
        };
      },
      async close(timeoutMs) {
        closed = true;
        for (const timer of timers) cancel(timer);
        for (const stop of closeHooks) stop();
        closeHooks.clear();
        const result = await control.close(timeoutMs);
        if (usageRuntime() === runtime) setUsageRuntimeForTest(undefined);
        return result;
      },
    };
    setUsageRuntimeForTest(runtime);
    if (runtime.enabled('storage')) configureStorageAggregates(deps.rag);
    return runtime;
  } catch (error) {
    for (const timer of timers) cancel(timer);
    await Promise.allSettled(sinks.map((s) => s.close?.()));
    throw error;
  }
}
