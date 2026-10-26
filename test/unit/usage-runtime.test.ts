import { readFileSync } from 'node:fs';
import type {
  IUsageControl,
  IUsageRecorder,
  UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import { readUsageConfig } from '../../srv/lib/usage/config';
import { MigratableBuffer } from '../../srv/lib/usage/migratable-buffer';
import {
  initUsage,
  type UsageDeps,
  type UsageRuntime,
} from '../../srv/lib/usage/runtime';

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
}) => {
  const rows: UsageRecord[] = [];
  for await (const r of reader.read(q)) rows.push(r);
  return rows;
};
const cfg = (sinks: string = 'memory', extra: NodeJS.ProcessEnv = {}) =>
  readUsageConfig({
    LLM_AGENT_USAGE: 'on',
    LLM_AGENT_USAGE_SINKS: sinks,
    ...extra,
  });
function harness(extra: UsageDeps = {}) {
  const ticks: { fn: () => void; ms: number }[] = [];
  const deps: UsageDeps = {
    setInterval: (fn: () => void, ms: number) => {
      ticks.push({ fn, ms });
      const timer = setInterval(() => {}, ms);
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
jest.mock('../../srv/lib/usage/migratable-buffer', () => {
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
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
describe('usage runtime', () => {
  const runtimes: UsageRuntime[] = [];
  afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.close(1000);
  });
  async function start(...args: Parameters<typeof initUsage>) {
    const r = await initUsage(...args);
    if (!r) throw new Error('Expected enabled runtime');
    runtimes.push(r);
    return r;
  }
  it('off creates nothing', async () => {
    const factory = jest.fn(() => memorySink({ limit: 20 }));
    expect(
      await initUsage(readUsageConfig({}), { factories: { sqlite: factory } }),
    ).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['hana', 'pg'])('rejects %s without backend', async (sink) => {
    await expect(initUsage(cfg(sink))).rejects.toThrow(/configuration/);
  });
  it('sqlite capability failure is visible memory fallback', async () => {
    const { deps } = harness({
      factories: {
        sqlite: () => {
          throw new Error('node:sqlite unavailable');
        },
      },
    });
    const r = await start(cfg('sqlite'), deps);
    expect(r.status()).toMatchObject({
      fallback: ['sqlite-unavailable'],
      lastErrorCode: 'SQLITE_UNAVAILABLE',
    });
  });
  it('rejects HANA factory configuration errors', async () => {
    const error = new Error('Invalid HANA configuration');
    const { deps, ticks } = harness({
      factories: {
        hana: () => {
          throw error;
        },
      },
    });
    await expect(initUsage(cfg('hana'), deps)).rejects.toBe(error);
    expect(ticks).toEqual([]);
  });
  it('buffers during a HANA connection outage and migrates after recovery', async () => {
    let unavailable = true;
    const target = memorySink({ limit: 20 });
    const sink = {
      ...target,
      write: jest.fn(async (batch: readonly UsageRecord[]) => {
        if (unavailable)
          throw new Error('Connection failed: sensitive details');
        await target.write(batch);
      }),
    };
    const { deps, ticks } = harness({ factories: { hana: () => sink } });
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
    expect((await collect(bufferFor())).map((r) => r.id)).toEqual(['a']);
    expect(await collect(target)).toEqual([]);
    unavailable = false;
    ticks.find((t) => t.ms === 300000)?.fn();
    await settle();
    expect((await collect(target)).map((r) => r.id)).toEqual(['a']);
    expect(bufferFor().size).toBe(0);
    expect(r.status()).toMatchObject({ fallback: [] });
  });
  it('retains only database sinks at startup and daily', async () => {
    const pg = Object.assign(memorySink({ limit: 20 }), {
      deleteOlderThan: jest.fn(async () => 0),
    });
    const memory = Object.assign(memorySink({ limit: 20 }), {
      deleteOlderThan: jest.fn(async () => 0),
    });
    const { deps, ticks } = harness({
      now: () => 10000000000,
      factories: { pg: () => pg, memory: () => memory },
    });
    await start(cfg('memory,pg'), deps);
    expect(pg.deleteOlderThan).toHaveBeenCalledWith(
      10000000000 - 90 * 86400000,
    );
    expect(memory.deleteOlderThan).not.toHaveBeenCalled();
    ticks.find((t) => t.ms === 86400000)?.fn();
    await settle();
    expect(pg.deleteOlderThan).toHaveBeenCalledTimes(2);
  });
  it('starts and closes while startup retention is stalled', async () => {
    const pg = Object.assign(memorySink({ limit: 20 }), {
      deleteOlderThan: jest.fn(() => new Promise<number>(() => {})),
    });
    const { deps } = harness({ factories: { pg: () => pg } });
    const r = await start(cfg('pg'), deps);
    expect(pg.deleteOlderThan).toHaveBeenCalledTimes(1);
    await expect(r.close(10)).resolves.toBeDefined();
  });
  it.each(['reject', 'missing'])(
    'reports retention %s without failing startup',
    async (mode) => {
      const pg = Object.assign(memorySink({ limit: 20 }), {
        deleteOlderThan: jest.fn(async () => {
          if (mode === 'reject') throw new Error('retention failed');
          return undefined;
        }),
      });
      const r = await start(
        cfg('pg'),
        harness({ factories: { pg: () => pg } }).deps,
      );
      await settle();
      expect(r.status().lastErrorCode).toBe('RETENTION_FAILED');
      expect(r.status().fallback).toEqual([]);
    },
  );
  it('bounds stalled HANA probes, prevents overlap, and migrates after recovery', async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      const target = memorySink({ limit: 20 });
      const write = jest
        .fn(async (batch: readonly UsageRecord[]) => {
          await target.write(batch);
        })
        .mockImplementationOnce(() => stalled);
      const { deps, ticks } = harness({
        probeTimeoutMs: 25,
        factories: { hana: () => ({ ...target, write }) },
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
      const retry = ticks.find((t) => t.ms === 300000)?.fn;
      retry?.();
      retry?.();
      await jest.advanceTimersByTimeAsync(25);
      expect(write).toHaveBeenCalledTimes(1);
      release();
      await settle();
      retry?.();
      await settle();
      expect(r.status()).toMatchObject({ fallback: [] });
      expect((await collect(target)).map((row) => row.id)).toEqual([
        'buffered',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
  it('writes both configured sinks', async () => {
    const memory = memorySink({ limit: 20 });
    const pg = memorySink({ limit: 20 });
    const { deps } = harness({
      factories: { memory: () => memory, pg: () => pg },
    });
    const r = await start(cfg('memory,pg'), deps);
    r.recorder.record(record('a'));
    await r.close(1000);
    expect((await collect(memory)).map((r) => r.id)).toEqual(['a']);
    expect((await collect(pg)).map((r) => r.id)).toEqual(['a']);
    expect(r.status().sinks).toEqual(['memory', 'pg']);
  });
  it('reports configured sinks in order after JSONL', async () => {
    const jsonl = memorySink({ limit: 20 });
    const pg = memorySink({ limit: 20 });
    const sqlite = memorySink({ limit: 20 });
    const { deps } = harness({
      factories: { jsonl: () => jsonl, pg: () => pg, sqlite: () => sqlite },
    });
    const r = await start(
      cfg('jsonl,pg,sqlite', { LLM_AGENT_USAGE_JSONL_PATH: 'unused' }),
      deps,
    );
    expect(r.status().sinks).toEqual(['jsonl', 'pg', 'sqlite']);
  });
  it('reports JSONL-only status without a reading sink or memory mirror', async () => {
    const write = jest.fn<Promise<void>, [records: readonly UsageRecord[]]>(
      async (_records: readonly UsageRecord[]): Promise<void> => {},
    );
    const r = await start(
      cfg('jsonl', { LLM_AGENT_USAGE_JSONL_PATH: 'unused' }),
      harness({ factories: { jsonl: () => ({ write }) } }).deps,
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
  it('hashes user ids stably by default and supports plain', async () => {
    for (const mode of ['hash', 'plain']) {
      const sink = memorySink({ limit: 20 });
      const r = await start(
        cfg('memory', { LLM_AGENT_USAGE_USER_ID: mode }),
        harness({ factories: { memory: () => sink } }).deps,
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
  it('suppresses disabled records and measurement timers', async () => {
    const sink = memorySink({ limit: 20 });
    const { deps, ticks } = harness({ factories: { memory: () => sink } });
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
  it('reports all recorder counters including unconfirmed', async () => {
    const fake: IUsageRecorder & IUsageControl = {
      record: jest.fn<void, Parameters<IUsageRecorder['record']>>(),
      with: jest.fn<IUsageRecorder, Parameters<IUsageRecorder['with']>>(
        () => fake,
      ),
      close: jest.fn(async () => ({ delivered: 3, lost: 2, unconfirmed: 4 })),
      flush: jest.fn(async () => {}),
      stats: () => ({
        buffered: 1,
        delivered: 3,
        lost: { task: 2 },
        unconfirmed: 4,
        lastErrorCode: 'AMBIGUOUS',
      }),
    };
    const r = await start(cfg(), harness({ recorderFactory: () => fake }).deps);
    expect(r.status()).toMatchObject({
      buffered: 1,
      delivered: 3,
      lost: { task: 2 },
      unconfirmed: 4,
      lastErrorCode: 'AMBIGUOUS',
    });
  });
  it('HANA missing falls back, retries failed copy, then switches and empties buffer', async () => {
    let missing = true;
    let failing = false;
    const target = memorySink({ limit: 20 });
    const sink = {
      ...target,
      write: jest.fn(async (batch: readonly UsageRecord[]) => {
        if (missing) throw new Error('USAGE_RECORDS is unavailable');
        if (failing && batch.length) throw new Error('copy failed');
        await target.write(batch);
      }),
    };
    const { deps, ticks } = harness({ factories: { hana: () => sink } });
    const r = await start(cfg('hana'), deps);
    const buffer = bufferFor();
    await buffer.write([record('a')]);
    expect(r.status().fallback).toEqual(['hana-table-missing']);
    missing = false;
    failing = true;
    ticks.find((t) => t.ms === 300000)?.fn();
    await settle();
    expect(buffer.size).toBe(1);
    expect(await collect(buffer)).toHaveLength(1);
    failing = false;
    ticks.find((t) => t.ms === 300000)?.fn();
    await settle();
    expect(buffer.size).toBe(0);
    expect(await collect(target)).toHaveLength(1);
    expect(r.status()).toMatchObject({ fallback: [] });
  });
  it('initializes usage before providers inside the existing failure chain', () => {
    const source = readFileSync('srv/server.ts', 'utf8');
    expect(source).toMatch(
      /initUsage\([\s\S]*?\.then\(\(runtime: UsageRuntime \| undefined\) => \{[\s\S]*?startStorageMeter\([\s\S]*?return startProviders/,
    );
    expect(source.indexOf('await closeUsageSessions(')).toBeLessThan(
      source.indexOf('if (runtime) stopStorageMeter(runtime)'),
    );
    expect(
      source.indexOf('if (runtime) stopStorageMeter(runtime)'),
    ).toBeLessThan(source.indexOf('await usageRuntime()?.close'));
    expect(source.indexOf('await closing;')).toBeLessThan(
      source.indexOf('await usageRuntime()?.close'),
    );
  });
});
describe('migration safety', () => {
  it('overflow is definite non-delivery and the library reports loss', async () => {
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
    expect((await collect(buffer)).map((r) => r.id)).toEqual(['held']);
  });
  it('stores library loss evidence after buffer overflow and recovery', async () => {
    let now = 0;
    const buffer = new MigratableBuffer(1);
    await buffer.write([record('held')]);
    const recorder = createUsageRecorder({
      transport: directTransport(buffer),
      now: () => now,
      retryWindowMs: 1,
      lossWindowMs: 1,
    });
    recorder.record(record('lost'));
    now = 2;
    await recorder.flush(10);
    expect(recorder.stats().lost.retryWindow).toBe(1);
    expect((await collect(buffer)).map((r) => r.id)).toEqual(['held']);
    const target = memorySink({ limit: 10 });
    await buffer.migrate(target);
    now = 4;
    await recorder.close(1000);
    const loss = (await collect(target)).find((r) => r.kind === 'x.usage.lost');
    expect(loss).toMatchObject({
      context: { sessionId: 's' },
      values: { affectedFrom: 100, affectedTo: 100, 'x.hub.session': 1 },
    });
  });
  it('queues concurrent writes behind migration without losses or duplicates', async () => {
    const buffer = new MigratableBuffer(10);
    const target = memorySink({ limit: 10 });
    await buffer.write([record('a')]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = {
      ...target,
      write: async (batch: readonly UsageRecord[]) => {
        await gate;
        await target.write(batch);
      },
    };
    const migrating = buffer.migrate(sink, 1);
    const writing = buffer.write([record('b'), record('a')]);
    release();
    await Promise.all([migrating, writing]);
    expect(buffer.size).toBe(0);
    expect((await collect(buffer)).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
  it('intermediate failed batch preserves all buffered records until a successful retry', async () => {
    const buffer = new MigratableBuffer(10);
    const target = memorySink({ limit: 10 });
    await buffer.write(['a', 'b', 'c'].map(record));
    let calls = 0;
    const sink = {
      ...target,
      write: async (batch: readonly UsageRecord[]) => {
        if (++calls === 2) throw new Error('failed');
        await target.write(batch);
      },
    };
    await expect(buffer.migrate(sink, 1)).rejects.toThrow('failed');
    expect((await collect(buffer)).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(await collect(target)).toHaveLength(1);
    await buffer.migrate(sink, 1);
    expect(buffer.size).toBe(0);
    expect(await collect(target)).toHaveLength(3);
  });
});

test.each(['request', 'llm'])(
  'retrieval belongs to the request measure (%s)',
  async (measure: string) => {
    const sink = memorySink({ limit: 20 });
    const runtime = await initUsage(
      cfg('memory', { LLM_AGENT_USAGE_MEASURE: measure }),
      { factories: { memory: () => sink } },
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
      records.filter((r: UsageRecord) => r.kind === 'x.hub.retrieval'),
    ).toHaveLength(measure === 'request' ? 1 : 0);
  },
);
