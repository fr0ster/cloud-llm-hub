/** Shared budget for usage shutdown waits and recorder close. */
export const USAGE_SHUTDOWN_TIMEOUT_MS = 5000;

export async function withinUsageShutdownBudget(
  work: Promise<void>,
  timeoutMs: number = USAGE_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve: (value: boolean) => void) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
