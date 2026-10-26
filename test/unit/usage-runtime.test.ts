import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { constants, Script } from 'node:vm';
import type {
  IUsageControl,
  IUsageRecorder,
  IUsageSink,
  UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import type { IUsageReader, UsageQuery } from '@mcp-abap-adt/llm-usage';
import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import type {
  SqliteUsageSink,
  SqliteUsageSinkOptions,
} from '@mcp-abap-adt/llm-usage-sqlite';
import { readUsageConfig, type UsageConfig } from '../../srv/lib/usage/config';
import { MigratableBuffer } from '../../srv/lib/usage/migratable-buffer';
import {
  initUsage,
  type UsageDeps,
  type UsageRuntime,
} from '../../srv/lib/usage/runtime';

// Native import keeps the real ESM worker package outside Jest's CommonJS loader.
let mockSqliteModule:
  | typeof import('@mcp-abap-adt/llm-usage-sqlite')
  | undefined;
jest.mock('@mcp-abap-adt/llm-usage-sqlite', (): object => ({
  createSqliteUsageSink(options: SqliteUsageSinkOptions): SqliteUsageSink {
    if (!mockSqliteModule) throw new Error('Real SQLite module not loaded');
    return mockSqliteModule.createSqliteUsageSink(options);
  },
}));

const q = { from: 0, to: Number.MAX_SAFE_INTEGER };
const record = (id: string): UsageRecord => ({
  schema: 1,
  id,
  at: 100,
  kind: 'x.hub.session',
  context: { sessionId: 's' },
  outcome: 'ok',
  values: {},
});
const collect = async (reader: {
  read: (query: typeof q) => AsyncIterable<UsageRecord>;
}): Promise<UsageRecord[]> => {
  const rows: UsageRecord[] = [];
  for await (const r of reader.read(q)) rows.push(r);
  return rows;
};
const cfg = (
  sinks: string = 'memory',
  extra: NodeJS.ProcessEnv = {},
): UsageConfig =>
  readUsageConfig({
    LLM_AGENT_USAGE: 'on',
    LLM_AGENT_USAGE_SINKS: sinks,
    ...extra,
  });
function harness(extra: UsageDeps = {}) {
  const ticks: { fn: () => void; ms: number }[] = [];
  const deps: UsageDeps = {
    setInterval: (fn: () => void, ms: number): NodeJS.Timeout => {
      ticks.push({ fn, ms });
      const timer = setInterval((): void => {}, ms);
      clearInterval(timer);
      return timer;
    },
    clearInterval: jest.fn<
      ReturnType<typeof clearInterval>,
      Parameters<typeof clearInterval>
    >(),
    log: { warn: jest.fn<void, [message: string]>() },
    ...extra,
  };
  return { deps, ticks };
}
const mockBuffers: MigratableBuffer[] = [];
jest.mock('../../srv/lib/usage/migratable-buffer', (): object => {
  const actual = jest.requireActual<
    typeof import('../../srv/lib/usage/migratable-buffer')
  >('../../srv/lib/usage/migratable-buffer');
  return {
    MigratableBuffer: class extends actual.MigratableBuffer {
      constructor(
        ...args: ConstructorParameters<typeof actual.MigratableBuffer>
      ) {
        super(...args);
        mockBuffers.push(this);
      }
    },
  };
});
function bufferFor(): MigratableBuffer {
  const buffer = mockBuffers.at(-1);
  if (!buffer) throw new Error('Expected migration buffer');
  return buffer;
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
describe('usage runtime', (): void => {
  const runtimes: UsageRuntime[] = [];
  afterEach(async (): Promise<void> => {
    for (const r of runtimes.splice(0)) await r.close(1000);
  });
  async function start(...args: Parameters<typeof initUsage>) {
    const r = await initUsage(...args);
    if (!r) throw new Error('Expected enabled runtime');
    runtimes.push(r);
    return r;
  }
  it('off creates nothing', async (): Promise<void> => {
    const factory = jest.fn((): IUsageSink & IUsageReader =>
      memorySink({ limit: 20 }),
    );
    expect(
      await initUsage(readUsageConfig({}), { factories: { sqlite: factory } }),
    ).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['hana', 'pg'])(
    'rejects %s without backend',
    async (sink: string): Promise<void> => {
      await expect(initUsage(cfg(sink))).rejects.toThrow(/configuration/);
    },
  );
  it('sqlite capability failure is visible memory fallback', async (): Promise<void> => {
    const { deps } = harness({
      factories: {
        sqlite: (): never => {
          throw new Error('node:sqlite unavailable');
        },
      },
    });
    const r = await start(cfg('sqlite'), deps);
    expect(r.sqliteSnapshot).toBeUndefined();
    expect(r.status()).toMatchObject({
      fallback: ['sqlite-unavailable'],
      lastErrorCode: 'SQLITE_UNAVAILABLE',
    });
  });
  it('rejects HANA factory configuration errors', async (): Promise<void> => {
    const error = new Error('Invalid HANA configuration');
    const { deps, ticks } = harness({
      factories: {
        hana: (): never => {
          throw error;
        },
      },
    });
    await expect(initUsage(cfg('hana'), deps)).rejects.toBe(error);
    expect(ticks).toEqual([]);
  });
  it('buffers during a HANA connection outage and migrates after recovery', async (): Promise<void> => {
    let unavailable = true;
    const target = memorySink({ limit: 20 });
    const sink = {
      ...target,
      write: jest.fn(async (batch: readonly UsageRecord[]): Promise<void> => {
        if (unavailable)
          throw new Error('Connection failed: sensitive details');
        await target.write(batch);
      }),
    };
    const { deps, ticks } = harness({
      factories: {
        hana: (): {
          write: jest.Mock<
            Promise<void>,
            [batch: readonly UsageRecord[]],
            void
          >;
          close?(): Promise<void>;
          read(query: UsageQuery): AsyncIterable<UsageRecord>;
        } => sink,
      },
    });
    const r = await start(cfg('hana'), deps);
    expect(r.status()).toMatchObject({
      fallback: ['hana-unavailable'],
      lastErrorCode: 'HANA_UNAVAILABLE',
    });
    expect(deps.log?.warn).toHaveBeenCalledTimes(1);
    expect(deps.log?.warn).toHaveBeenCalledWith(
      'Usage runtime: HANA_UNAVAILABLE',
    );
    await bufferFor().write([record('a')]);
    expect(
      (await collect(bufferFor())).map((r: UsageRecord): string => r.id),
    ).toEqual(['a']);
    expect(await collect(target)).toEqual([]);
    unavailable = false;
    ticks
      .find((t: { fn: () => void; ms: number }): boolean => t.ms === 300000)
      ?.fn();
    await settle();
    expect(
      (await collect(target)).map((r: UsageRecord): string => r.id),
    ).toEqual(['a']);
    expect(bufferFor().size).toBe(0);
    expect(r.status()).toMatchObject({ fallback: [] });
  });
  it('retains only database sinks at startup and daily', async (): Promise<void> => {
    const pg = Object.assign(memorySink({ limit: 20 }), {
      deleteOlderThan: jest.fn(async (): Promise<number> => 0),
    });
    const memory = Object.assign(memorySink({ limit: 20 }), {
      deleteOlderThan: jest.fn(async (): Promise<number> => 0),
    });
    const { deps, ticks } = harness({
      now: (): number => 10000000000,
      factories: {
        pg: (): IUsageSink &
          IUsageReader & {
            deleteOlderThan: jest.Mock<Promise<number>, [], void>;
          } => pg,
        memory: (): IUsageSink &
          IUsageReader & {
            deleteOlderThan: jest.Mock<Promise<number>, [], void>;
          } => memory,
      },
    });
    await start(cfg('memory,pg'), deps);
    expect(pg.deleteOlderThan).toHaveBeenCalledWith(
      10000000000 - 90 * 86400000,
    );
    expect(memory.deleteOlderThan).not.toHaveBeenCalled();
    ticks
      .find((t: { fn: () => void; ms: number }): boolean => t.ms === 86400000)
      ?.fn();
    await settle();
    expect(pg.deleteOlderThan).toHaveBeenCalledTimes(2);
  });
  it('starts and closes while startup retention is stalled', async (): Promise<void> => {
    const pg = Object.assign(memorySink({ limit: 20 }), {
      deleteOlderThan: jest.fn(
        (): Promise<number> => new Promise<number>((): void => {}),
      ),
    });
    const { deps } = harness({
      factories: {
        pg: (): IUsageSink &
          IUsageReader & {
            deleteOlderThan: jest.Mock<Promise<number>, [], void>;
          } => pg,
      },
    });
    const r = await start(cfg('pg'), deps);
    expect(pg.deleteOlderThan).toHaveBeenCalledTimes(1);
    await expect(r.close(10)).resolves.toBeDefined();
  });
  it.each(['reject', 'missing'])(
    'reports retention %s without failing startup',
    async (mode: string): Promise<void> => {
      const pg = Object.assign(memorySink({ limit: 20 }), {
        deleteOlderThan: jest.fn(async (): Promise<undefined> => {
          if (mode === 'reject') throw new Error('retention failed');
          return undefined;
        }),
      });
      const r = await start(
        cfg('pg'),
        harness({
          factories: {
            pg: (): IUsageSink &
              IUsageReader & {
                deleteOlderThan: jest.Mock<Promise<undefined>, [], void>;
              } => pg,
          },
        }).deps,
      );
      await settle();
      expect(r.status().lastErrorCode).toBe('RETENTION_FAILED');
      expect(r.status().fallback).toEqual([]);
    },
  );
  it('bounds stalled HANA probes, prevents overlap, and migrates after recovery', async (): Promise<void> => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const stalled = new Promise<void>(
        (resolve: (value: void | PromiseLike<void>) => void): void => {
          release = resolve;
        },
      );
      const target = memorySink({ limit: 20 });
      const write = jest
        .fn(async (batch: readonly UsageRecord[]): Promise<void> => {
          await target.write(batch);
        })
        .mockImplementationOnce((): Promise<void> => stalled);
      const { deps, ticks } = harness({
        probeTimeoutMs: 25,
        factories: {
          hana: (): {
            write: jest.Mock<
              Promise<void>,
              [batch: readonly UsageRecord[]],
              void
            >;
            close?(): Promise<void>;
            read(query: UsageQuery): AsyncIterable<UsageRecord>;
          } => ({ ...target, write }),
        },
      });
      const starting = start(cfg('hana'), deps);
      await settle();
      await jest.advanceTimersByTimeAsync(25);
      const r = await starting;
      expect(r.status()).toMatchObject({
        fallback: ['hana-unavailable'],
      });
      const buffer = bufferFor();
      await buffer.write([record('buffered')]);
      const retry = ticks.find(
        (t: { fn: () => void; ms: number }): boolean => t.ms === 300000,
      )?.fn;
      retry?.();
      retry?.();
      await jest.advanceTimersByTimeAsync(25);
      expect(write).toHaveBeenCalledTimes(1);
      release();
      await settle();
      retry?.();
      await settle();
      expect(r.status()).toMatchObject({ fallback: [] });
      expect(
        (await collect(target)).map((row: UsageRecord): string => row.id),
      ).toEqual(['buffered']);
    } finally {
      jest.useRealTimers();
    }
  });
  it('writes both configured sinks', async (): Promise<void> => {
    const memory = memorySink({ limit: 20 });
    const pg = memorySink({ limit: 20 });
    const { deps } = harness({
      factories: {
        memory: (): IUsageSink & IUsageReader => memory,
        pg: (): IUsageSink & IUsageReader => pg,
      },
    });
    const r = await start(cfg('memory,pg'), deps);
    r.recorder.record(record('a'));
    await r.close(1000);
    expect(
      (await collect(memory)).map((r: UsageRecord): string => r.id),
    ).toEqual(['a']);
    expect((await collect(pg)).map((r: UsageRecord): string => r.id)).toEqual([
      'a',
    ]);
    expect(r.status().sinks).toEqual(['memory', 'pg']);
  });
  it('reports configured sinks in order after JSONL', async (): Promise<void> => {
    const jsonl = memorySink({ limit: 20 });
    const pg = memorySink({ limit: 20 });
    const sqlite = memorySink({ limit: 20 });
    const { deps } = harness({
      factories: {
        jsonl: (): IUsageSink & IUsageReader => jsonl,
        pg: (): IUsageSink & IUsageReader => pg,
        sqlite: (): IUsageSink & IUsageReader => sqlite,
      },
    });
    const r = await start(
      cfg('jsonl,pg,sqlite', { LLM_AGENT_USAGE_JSONL_PATH: 'unused' }),
      deps,
    );
    expect(r.status().sinks).toEqual(['jsonl', 'pg', 'sqlite']);
  });
  it('reports JSONL-only status without a reading sink or memory mirror', async (): Promise<void> => {
    const write = jest.fn<Promise<void>, [records: readonly UsageRecord[]]>(
      async (_records: readonly UsageRecord[]): Promise<void> => {},
    );
    const r = await start(
      cfg('jsonl', { LLM_AGENT_USAGE_JSONL_PATH: 'unused' }),
      harness({
        factories: {
          jsonl: (): {
            write: jest.Mock<
              Promise<void>,
              [records: readonly UsageRecord[]],
              void
            >;
          } => ({ write }),
        },
      }).deps,
    );
    r.recorder.record(record('jsonl-only'));
    await r.close(1000);
    expect(write).toHaveBeenCalled();
    expect(r.status()).toMatchObject({
      enabled: true,
      sinks: ['jsonl'],
      fallback: [],
      delivered: 1,
    });
    expect(r.status()).not.toHaveProperty('readingSink');
  });
  it('hashes user ids stably by default and supports plain', async (): Promise<void> => {
    for (const mode of ['hash', 'plain']) {
      const sink = memorySink({ limit: 20 });
      const r = await start(
        cfg('memory', { LLM_AGENT_USAGE_USER_ID: mode }),
        harness({
          factories: { memory: (): IUsageSink & IUsageReader => sink },
        }).deps,
      );
      for (const id of ['a', 'b'])
        r.forSession({ sessionId: id, userId: 'user' }).record(record(id));
      await r.close(1000);
      const rows = await collect(sink);
      expect(rows[0].context.userId).toBe(rows[1].context.userId);
      if (mode === 'hash')
        expect(rows[0].context.userId).toMatch(/^[a-f0-9]{64}$/);
      else expect(rows[0].context.userId).toBe('user');
    }
  });
  it('suppresses disabled records and measurement timers', async (): Promise<void> => {
    const sink = memorySink({ limit: 20 });
    const { deps, ticks } = harness({
      factories: { memory: (): IUsageSink & IUsageReader => sink },
    });
    const r = await start(
      cfg('memory', { LLM_AGENT_USAGE_MEASURE: 'request' }),
      deps,
    );
    r.recorder.record(record('a'));
    r.schedule('process', jest.fn<void, []>(), 30000);
    r.schedule('storage', jest.fn<void, []>(), 600000);
    await r.close(1000);
    expect(await collect(sink)).toEqual([]);
    expect(ticks).toEqual([]);
    expect(r.enabled('process')).toBe(false);
  });
  it('reports all recorder counters including unconfirmed', async (): Promise<void> => {
    const fake: IUsageRecorder & IUsageControl = {
      record: jest.fn<void, Parameters<IUsageRecorder['record']>>(),
      with: jest.fn<IUsageRecorder, Parameters<IUsageRecorder['with']>>(
        (): IUsageRecorder & IUsageControl => fake,
      ),
      close: jest.fn(
        async (): Promise<{
          delivered: number;
          lost: number;
          unconfirmed: number;
        }> => ({ delivered: 3, lost: 2, unconfirmed: 4 }),
      ),
      flush: jest.fn(async (): Promise<void> => {}),
      stats: (): {
        buffered: number;
        delivered: number;
        lost: { task: number };
        unconfirmed: number;
        lastErrorCode: string;
      } => ({
        buffered: 1,
        delivered: 3,
        lost: { task: 2 },
        unconfirmed: 4,
        lastErrorCode: 'AMBIGUOUS',
      }),
    };
    const r = await start(
      cfg(),
      harness({ recorderFactory: (): IUsageRecorder & IUsageControl => fake })
        .deps,
    );
    expect(r.status()).toMatchObject({
      buffered: 1,
      delivered: 3,
      lost: { task: 2 },
      unconfirmed: 4,
      lastErrorCode: 'AMBIGUOUS',
    });
  });
  it('HANA missing falls back, retries failed copy, then switches and empties buffer', async (): Promise<void> => {
    let missing = true;
    let failing = false;
    const target = memorySink({ limit: 20 });
    const sink = {
      ...target,
      write: jest.fn(async (batch: readonly UsageRecord[]): Promise<void> => {
        if (missing) throw new Error('USAGE_RECORDS is unavailable');
        if (failing && batch.length) throw new Error('copy failed');
        await target.write(batch);
      }),
    };
    const { deps, ticks } = harness({
      factories: {
        hana: (): {
          write: jest.Mock<
            Promise<void>,
            [batch: readonly UsageRecord[]],
            void
          >;
          close?(): Promise<void>;
          read(query: UsageQuery): AsyncIterable<UsageRecord>;
        } => sink,
      },
    });
    const r = await start(cfg('hana'), deps);
    const buffer = bufferFor();
    await buffer.write([record('a')]);
    expect(r.status().fallback).toEqual(['hana-table-missing']);
    missing = false;
    failing = true;
    ticks
      .find((t: { fn: () => void; ms: number }): boolean => t.ms === 300000)
      ?.fn();
    await settle();
    expect(buffer.size).toBe(1);
    expect(await collect(buffer)).toHaveLength(1);
    failing = false;
    ticks
      .find((t: { fn: () => void; ms: number }): boolean => t.ms === 300000)
      ?.fn();
    await settle();
    expect(buffer.size).toBe(0);
    expect(await collect(target)).toHaveLength(1);
    expect(r.status()).toMatchObject({ fallback: [] });
  });
  it('initializes usage before providers inside the existing failure chain', (): void => {
    const source = readFileSync('srv/server.ts', 'utf8');
    expect(source).toMatch(
      /initUsage\([\s\S]*?\.then\(\(runtime: UsageRuntime \| undefined\): Promise<Providers> => \{[\s\S]*?startStorageMeter\([\s\S]*?return startProviders/,
    );
    expect(source.indexOf('await closeUsageSessions(')).toBeLessThan(
      source.indexOf('if (runtime) stopStorageMeter(runtime)'),
    );
    expect(
      source.indexOf('if (runtime) stopStorageMeter(runtime)'),
    ).toBeLessThan(source.indexOf('await runtime?.close(remainingMs)'));
    expect(source.indexOf('await closing;')).toBeLessThan(
      source.indexOf('await runtime?.close(remainingMs)'),
    );
  });
});
describe('migration safety', (): void => {
  it('overflow is definite non-delivery and the library reports loss', async (): Promise<void> => {
    const buffer = new MigratableBuffer(1);
    await buffer.write([record('held')]);
    await expect(buffer.write([record('rejected')])).rejects.toMatchObject({
      possiblyDelivered: false,
    });
    const recorder = createUsageRecorder({
      transport: directTransport(buffer),
      retryWindowMs: 1,
      lossWindowMs: 1,
    });
    recorder.record(record('lost'));
    const result = await recorder.close(100);
    expect(result.lost).toBeGreaterThan(0);
    expect(
      (await collect(buffer)).map((r: UsageRecord): string => r.id),
    ).toEqual(['held']);
  });
  it('stores library loss evidence after buffer overflow and recovery', async (): Promise<void> => {
    let now = 0;
    const buffer = new MigratableBuffer(1);
    await buffer.write([record('held')]);
    const recorder = createUsageRecorder({
      transport: directTransport(buffer),
      now: (): number => now,
      retryWindowMs: 1,
      lossWindowMs: 1,
    });
    recorder.record(record('lost'));
    now = 2;
    await recorder.flush(10);
    expect(recorder.stats().lost.retryWindow).toBe(1);
    expect(
      (await collect(buffer)).map((r: UsageRecord): string => r.id),
    ).toEqual(['held']);
    const target = memorySink({ limit: 10 });
    await buffer.migrate(target);
    now = 4;
    await recorder.close(1000);
    const loss = (await collect(target)).find(
      (r: UsageRecord): boolean => r.kind === 'x.usage.lost',
    );
    expect(loss).toMatchObject({
      context: { sessionId: 's' },
      values: { affectedFrom: 100, affectedTo: 100, 'x.hub.session': 1 },
    });
  });
  it('queues concurrent writes behind migration without losses or duplicates', async (): Promise<void> => {
    const buffer = new MigratableBuffer(10);
    const target = memorySink({ limit: 10 });
    await buffer.write([record('a')]);
    let release!: () => void;
    const gate = new Promise<void>(
      (resolve: (value: void | PromiseLike<void>) => void): void => {
        release = resolve;
      },
    );
    const sink = {
      ...target,
      write: async (batch: readonly UsageRecord[]): Promise<void> => {
        await gate;
        await target.write(batch);
      },
    };
    const migrating = buffer.migrate(sink, 1);
    const writing = buffer.write([record('b'), record('a')]);
    release();
    await Promise.all([migrating, writing]);
    expect(buffer.size).toBe(0);
    expect(
      (await collect(buffer)).map((r: UsageRecord): string => r.id).sort(),
    ).toEqual(['a', 'b']);
  });
  it('intermediate failed batch preserves all buffered records until a successful retry', async (): Promise<void> => {
    const buffer = new MigratableBuffer(10);
    const target = memorySink({ limit: 10 });
    await buffer.write(['a', 'b', 'c'].map(record));
    let calls = 0;
    const sink = {
      ...target,
      write: async (batch: readonly UsageRecord[]): Promise<void> => {
        if (++calls === 2) throw new Error('failed');
        await target.write(batch);
      },
    };
    await expect(buffer.migrate(sink, 1)).rejects.toThrow('failed');
    expect(
      (await collect(buffer)).map((r: UsageRecord): string => r.id),
    ).toEqual(['a', 'b', 'c']);
    expect(await collect(target)).toHaveLength(1);
    await buffer.migrate(sink, 1);
    expect(buffer.size).toBe(0);
    expect(await collect(target)).toHaveLength(3);
  });
});

test.each(['request', 'llm'])(
  'retrieval belongs to the request measure (%s)',
  async (measure: string): Promise<void> => {
    const sink = memorySink({ limit: 20 });
    const runtime = await initUsage(
      cfg('memory', { LLM_AGENT_USAGE_MEASURE: measure }),
      { factories: { memory: (): IUsageSink & IUsageReader => sink } },
    );
    if (!runtime) throw new Error('Expected usage runtime');
    runtime.recorder.record({
      kind: 'x.hub.retrieval',
      context: {},
      outcome: 'ok',
      values: { collections: 2, chunks: 3, chars: 10, injected: true },
    });
    await runtime.close(1000);
    const records = await collect(sink);
    expect(
      records.filter((r: UsageRecord): boolean => r.kind === 'x.hub.retrieval'),
    ).toHaveLength(measure === 'request' ? 1 : 0);
  },
);

it('real SQLite runtime snapshots open locally and contain written records', async (): Promise<void> => {
  const moduleUrl = pathToFileURL(
    require.resolve('@mcp-abap-adt/llm-usage-sqlite'),
  ).href;
  const loading: Promise<typeof import('@mcp-abap-adt/llm-usage-sqlite')> =
    new Script(`import(${JSON.stringify(moduleUrl)})`, {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }).runInThisContext();
  mockSqliteModule = await loading;
  const directory = await mkdtemp(join(tmpdir(), 'hub-usage-snapshot-'));
  let active: UsageRuntime | undefined;
  try {
    active = await initUsage(
      cfg('sqlite', {
        LLM_AGENT_USAGE_SQLITE_PATH: join(directory, 'source.sqlite'),
      }),
    );
    if (!active?.sqliteSnapshot)
      throw new Error('Expected SQLite snapshot capability');
    active.recorder.record(record('snapshot-record'));
    // The recorder drains asynchronously; snapshot operations serialize with sink writes.
    for (
      let attempt = 0;
      active.status().delivered < 1 && attempt < 100;
      attempt++
    ) {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 10);
      });
    }
    expect(active.status().delivered).toBe(1);
    const stream = await active.sqliteSnapshot();
    const bytes = await new Response(stream).arrayBuffer();
    const downloaded = join(directory, 'download.sqlite');
    await writeFile(downloaded, new Uint8Array(bytes));
    const database = new DatabaseSync(downloaded);
    try {
      expect(database.prepare('SELECT id FROM USAGE_RECORDS').all()).toEqual([
        { id: 'snapshot-record' },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await active?.close(1000);
    await rm(directory, { recursive: true, force: true });
  }
});
