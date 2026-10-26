import { monitorEventLoopDelay } from 'node:perf_hooks';
import { processAdmissionCounts } from '../gatekeeper';
import { processConnectionCount } from './process-resources';
import type { UsageRuntime } from './runtime';

export interface ProcessCounters {
  // One retained or long-session identity, including sessions still closing.
  activeSessions: number;
  // One admitted execution owner (chat, execute_step, or dialogue background task), until release.
  runningTasks: number;
  // hub-owned SAP connections; connections that
  // @mcp-abap-adt/lib opens itself through `freshConnection` are not included (no lifecycle hook)
  openSapConnections: number;
  // One pipeline waiting for admission at the door.
  admissionQueueLength: number;
}
export interface ProcessValues extends ProcessCounters {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  eventLoopDelayP99Ms: number;
  intervalMs: number;
}
export interface DelayHistogram {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  percentile(percentile: number): number;
}
export interface ProcessMeterDeps {
  now(): number;
  memoryUsage(): Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'external'>;
  cpuUsage(): NodeJS.CpuUsage;
  histogram(): DelayHistogram;
  counters(): ProcessCounters;
}
export function processCounters(): ProcessCounters {
  return {
    ...processAdmissionCounts(),
    openSapConnections: processConnectionCount(),
  };
}
const defaults: ProcessMeterDeps = {
  now: Date.now,
  memoryUsage: (): NodeJS.MemoryUsage => process.memoryUsage(),
  cpuUsage: (): NodeJS.CpuUsage => process.cpuUsage(),
  histogram: (): DelayHistogram => monitorEventLoopDelay(),
  counters: processCounters,
};
const meters = new WeakMap<UsageRuntime, () => void>();

export function stopProcessMeter(runtime: UsageRuntime): void {
  meters.get(runtime)?.();
}
export function startProcessMeter(
  runtime: UsageRuntime | undefined,
  intervalMs: number,
  deps: ProcessMeterDeps = defaults,
): void {
  if (!runtime?.enabled('process') || meters.has(runtime)) return;
  const histogram = deps.histogram();
  let previousCpu = deps.cpuUsage();
  let previousAt = deps.now();
  let stopped = false;
  let running = false;
  histogram.enable();
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    histogram.disable();
  };
  meters.set(runtime, stop);
  runtime.onClose(stop);
  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    try {
      const counters = deps.counters();
      if (stopped) return;
      const cpu = deps.cpuUsage();
      const at = deps.now();
      const memory = deps.memoryUsage();
      const values: ProcessValues = {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        cpuUserMs: (cpu.user - previousCpu.user) / 1000,
        cpuSystemMs: (cpu.system - previousCpu.system) / 1000,
        eventLoopDelayP99Ms: histogram.percentile(99) / 1e6,
        intervalMs: at - previousAt,
        ...counters,
      };
      previousCpu = cpu;
      previousAt = at;
      runtime.recorder.record({
        context: {},
        kind: 'x.hub.process',
        outcome: 'ok',
        values: { ...values },
      });
    } finally {
      if (!stopped) histogram.reset();
      running = false;
    }
  };
  runtime.schedule(
    'process',
    (): void => {
      try {
        tick();
      } catch {
        // A failed sample does not stop subsequent intervals.
      }
    },
    intervalMs,
  );
}
