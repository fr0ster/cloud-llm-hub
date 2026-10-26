import type { UsageRuntime } from './runtime';

// Stores consult this leaf module without importing runtime initialization and
// its backend factories back into the store module graph.
let current: UsageRuntime | undefined;
export const usageRuntime = (): UsageRuntime | undefined => current;
export function setUsageRuntimeForTest(
  runtime: UsageRuntime | undefined,
): void {
  current = runtime;
}
