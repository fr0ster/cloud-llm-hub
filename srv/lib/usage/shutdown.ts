/** Shared budget for usage shutdown waits and recorder close. */
export const USAGE_SHUTDOWN_TIMEOUT_MS = 5000;

export async function withinUsageShutdownBudget(
  work: Promise<void>,
  timeoutMs: number = USAGE_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((): boolean => true),
      new Promise<boolean>((resolve: (value: boolean) => void): void => {
        timer = setTimeout((): void => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Spend one deadline on draining, final snapshots and recorder delivery. */
export async function completeUsageShutdown(
  deadline: number,
  draining: Promise<void>,
  closeSessions: (remainingMs: number) => Promise<void>,
  closeRuntime: (remainingMs: number) => Promise<void>,
): Promise<void> {
  await withinUsageShutdownBudget(draining, Math.max(0, deadline - Date.now()));
  await closeSessions(Math.max(0, deadline - Date.now()));
  await closeRuntime(Math.max(0, deadline - Date.now()));
}
