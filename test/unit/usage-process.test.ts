jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async (destinationName: string) => ({
    destinationName,
    authenticationType: 'NoAuthentication',
    sapConfig: { url: 'http://sap.invalid', authType: 'basic' },
  }),
}));
jest.mock('../../srv/connections/connectionFactory', () => ({
  ...jest.requireActual<
    typeof import('../../srv/connections/connectionFactory')
  >('../../srv/connections/connectionFactory'),
  createConnection: () => ({
    connect: async (): Promise<void> => {},
    disconnect: async (): Promise<void> => {},
    close: async (): Promise<void> => {},
    getBaseUrl: async (): Promise<string> => 'http://sap',
    getSessionId: (): string => 'test',
    setSessionType: (): void => {},
    makeAdtRequest: jest.fn(),
  }),
}));
jest.mock('../../srv/lib/system-identity-cache', () => ({
  bindSystemIdentity: (): void => {},
  warmSystemIdentity: async (): Promise<void> => {},
}));

import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
import express from 'express';
import * as agents from '../../srv/agent-manager';
import { buildConnectionForDestination } from '../../srv/lib/background-connection';
import { dialogueFor } from '../../srv/lib/dialogue-sessions';
import {
  admitBackground,
  admitPipeline,
  processAdmissionCounts,
  resetGatekeeperForTest,
  theRetention,
} from '../../srv/lib/gatekeeper';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import {
  establishRequestConnection,
  safeStop,
} from '../../srv/lib/request-connection';
import { readUsageConfig } from '../../srv/lib/usage/config';
import {
  type ProcessCounters,
  type ProcessMeterDeps,
  processCounters,
  startProcessMeter,
  stopProcessMeter,
} from '../../srv/lib/usage/process-meter';
import { initUsage } from '../../srv/lib/usage/runtime';

function hooks() {
  const histogram = {
    enable: jest.fn<boolean, []>(() => true),
    disable: jest.fn<boolean, []>(() => true),
    reset: jest.fn<void, []>(),
    percentile: jest.fn<number, [percentile: number]>(() => 2500000),
  };
  const counters: ProcessCounters = {
    activeSessions: 3,
    runningTasks: 2,
    openSapConnections: 4,
    admissionQueueLength: 5,
  };
  const deps: ProcessMeterDeps = {
    now: jest
      .fn<number, []>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(30000)
      .mockReturnValue(60000),
    memoryUsage: () => ({ rss: 100, heapUsed: 50, external: 10 }),
    cpuUsage: jest
      .fn<NodeJS.CpuUsage, []>()
      .mockReturnValueOnce({ user: 1000, system: 2000 })
      .mockReturnValueOnce({ user: 4000, system: 7000 })
      .mockReturnValue({ user: 6000, system: 8000 }),
    histogram: jest.fn(() => histogram),
    counters: jest.fn<ProcessCounters, []>((): ProcessCounters => counters),
  };
  return { deps, histogram, counters };
}
async function runtime(measure: string = 'process', enabled: string = 'on') {
  return initUsage(
    readUsageConfig({
      LLM_AGENT_USAGE: enabled,
      LLM_AGENT_USAGE_SINKS: 'memory',
      LLM_AGENT_USAGE_MEASURE: measure,
    }),
  );
}
async function records(reader: {
  read(query: { from: number; to: number }): AsyncIterable<UsageRecord>;
}): Promise<UsageRecord[]> {
  const rows: UsageRecord[] = [];
  for await (const row of reader.read({ from: 0, to: Number.MAX_SAFE_INTEGER }))
    rows.push(row);
  return rows;
}
beforeEach((): void => {
  jest.useFakeTimers();
});
afterEach((): void => {
  jest.useRealTimers();
});

test('numeric shape, CPU deltas from start and between ticks, p99 milliseconds and reset', async (): Promise<void> => {
  const r = await runtime();
  if (!r) throw new Error('missing runtime');
  const { deps, histogram, counters } = hooks();
  startProcessMeter(r, 30000, deps);
  await jest.advanceTimersByTimeAsync(30000);
  await jest.advanceTimersByTimeAsync(30000);
  const rows = await records(r.reader());
  expect(rows).toHaveLength(2);
  if (!('values' in rows[0]) || !('values' in rows[1]))
    throw new Error('Expected extension records');
  expect(rows[0].kind).toBe('x.hub.process');
  expect(rows[0].context).toEqual({});
  expect(rows[0].values).toEqual({
    rssBytes: 100,
    heapUsedBytes: 50,
    externalBytes: 10,
    cpuUserMs: 3,
    cpuSystemMs: 5,
    eventLoopDelayP99Ms: 2.5,
    intervalMs: 30000,
    ...counters,
  });
  expect(rows[1].values.cpuUserMs).toBe(2);
  expect(rows[1].values.cpuSystemMs).toBe(1);
  expect(
    Object.values(rows[0].values).every(
      (value: string | number | boolean | undefined): boolean =>
        typeof value === 'number',
    ),
  ).toBe(true);
  expect(histogram.percentile).toHaveBeenCalledWith(99);
  expect(histogram.reset).toHaveBeenCalledTimes(2);
  await r.close(1000);
});

test.each(['off', 'disabled'])(
  '%s does no process work',
  async (mode: string): Promise<void> => {
    const r = await runtime(
      mode === 'disabled' ? 'llm' : 'process',
      mode === 'off' ? 'off' : 'on',
    );
    const before = jest.getTimerCount();
    const { deps } = hooks();
    startProcessMeter(r, 30000, deps);
    expect(jest.getTimerCount()).toBe(before);
    expect(deps.histogram).not.toHaveBeenCalled();
    expect(deps.cpuUsage).not.toHaveBeenCalled();
    expect(deps.counters).not.toHaveBeenCalled();
    const req = express.request;
    req.headers = { 'x-sap-login': 'dev', 'x-sap-password': 'secret' };
    const chat = await establishRequestConnection(
      req,
      express.response,
      'DEST',
    );
    const step = await buildConnectionForDestination(req, 'DEST');
    const execution = await admitPipeline('off-user', 'off-session');
    if (!('admitted' in execution)) throw new Error('refused');
    expect(processCounters().openSapConnections).toBe(0);
    expect(processCounters().runningTasks).toBe(0);
    execution.admitted.release();
    await safeStop(chat.connection);
    await safeStop(step.connection);
    await r?.close(1000);
    resetGatekeeperForTest();
  },
);

test('close clears timer and disables histogram; stop is idempotent', async (): Promise<void> => {
  const r = await runtime();
  if (!r) throw new Error('missing runtime');
  const { deps, histogram } = hooks();
  startProcessMeter(r, 30000, deps);
  startProcessMeter(r, 30000, deps);
  await r.close(1000);
  expect(jest.getTimerCount()).toBe(0);
  expect(histogram.enable).toHaveBeenCalledTimes(1);
  expect(histogram.disable).toHaveBeenCalledTimes(1);
  stopProcessMeter(r);
  expect(histogram.disable).toHaveBeenCalledTimes(1);
});

test('explicit stop disables histogram and prevents later measurements', async (): Promise<void> => {
  const r = await runtime();
  if (!r) throw new Error('missing runtime');
  const { deps, histogram } = hooks();
  startProcessMeter(r, 30000, deps);
  stopProcessMeter(r);
  await jest.advanceTimersByTimeAsync(30000);
  expect(histogram.disable).toHaveBeenCalledTimes(1);
  expect(deps.counters).not.toHaveBeenCalled();
  await r.close(1000);
});

test('pending dialogue opening never silences subsequent process intervals', async (): Promise<void> => {
  const r = await runtime();
  if (!r) throw new Error('missing runtime');
  let fail: (reason: Error) => void = (): void => {};
  const spy = jest.spyOn(agents, 'getSmartAgent').mockImplementation(
    () =>
      new Promise<never>(
        (
          _resolve: (value: never) => void,
          reject: (reason: Error) => void,
        ): void => {
          fail = reject;
        },
      ),
  );
  const opening = dialogueFor('pending-user', 'pending-key', 'DEST').catch(
    (): void => {},
  );
  const { deps } = hooks();
  deps.counters = processCounters;
  try {
    startProcessMeter(r, 30000, deps);
    await jest.advanceTimersByTimeAsync(90000);
    expect(await records(r.reader())).toHaveLength(3);
  } finally {
    fail(new Error('test cleanup'));
    await opening;
    spy.mockRestore();
    await r.close(1000);
  }
});

test('ordinary chat and sessionless execute_step connection owners are counted by identity until cleanup', async (): Promise<void> => {
  const r = await runtime();
  const req = express.request;
  req.headers = { 'x-sap-login': 'dev', 'x-sap-password': 'secret' };
  const chat = await establishRequestConnection(req, express.response, 'DEST');
  const step = await buildConnectionForDestination(req, 'DEST');
  expect(chat.connection).toBeDefined();
  expect(processCounters().openSapConnections).toBe(2);
  await safeStop(chat.connection);
  expect(processCounters().openSapConnections).toBe(1);
  await safeStop(chat.connection);
  expect(processCounters().openSapConnections).toBe(1);
  await safeStop(step.connection);
  expect(processCounters().openSapConnections).toBe(0);
  await r?.close(1000);
});

test('mixed channel execution owners count chat, execute_step and dialogue tasks once each', async (): Promise<void> => {
  resetGatekeeperForTest();
  const r = await runtime();
  const chat = await admitPipeline('user', 'chat');
  const step = await admitPipeline('user', 'step');
  const dialogue = await admitBackground('user', 'dialogue');
  if (
    !('admitted' in chat) ||
    !('admitted' in step) ||
    !('admitted' in dialogue)
  )
    throw new Error('refused');
  expect(processCounters().runningTasks).toBe(3);
  dialogue.admitted.run((): void => {
    expect(processCounters().runningTasks).toBe(3);
  });
  dialogue.admitted.release();
  dialogue.admitted.release();
  expect(processCounters().runningTasks).toBe(2);
  chat.admitted.release();
  step.admitted.release();
  expect(processCounters().runningTasks).toBe(0);
  await r?.close(1000);
  resetGatekeeperForTest();
});

test('closing long session overlapping retention counts once while cleanup remains pending', async (): Promise<void> => {
  resetGatekeeperForTest();
  let finish: () => void = (): void => {};
  const pending = new Promise<void>((resolve: () => void): void => {
    finish = resolve;
  });
  const registry = new LongSessionRegistry(
    { ttlMs: 1000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
    { onClose: (): Promise<void> => pending },
  );
  setLongSessionsForTest(registry);
  const session = registry.open('user', {});
  if ('refused' in session) throw new Error('refused');
  const lease = theRetention().lease('user', session.key, 'pipeline');
  if ('refused' in lease) throw new Error('refused');
  const closing = registry.close('user', session.key, 'explicit');
  expect(registry.has('user', session.key)).toBe(false);
  expect(processAdmissionCounts().activeSessions).toBe(1);
  finish();
  await closing;
  lease.release();
  setLongSessionsForTest(undefined);
  resetGatekeeperForTest();
});
