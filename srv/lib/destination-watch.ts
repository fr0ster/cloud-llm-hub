/** Bounded startup retries followed by the ordinary discovery interval. */
export function watchDestinations(
  check: () => Promise<boolean>,
  settled: () => void,
  intervalMs: number,
): () => void {
  const deadlines = [0, 5000, 10000, 20000];
  const startedAt = Date.now();
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    timer = setTimeout(
      async () => {
        if (stopped) return;
        const found = await check();
        attempt++;
        if (found || attempt === deadlines.length) settled();
        if (!found && !stopped) schedule();
      },
      attempt < deadlines.length
        ? Math.max(0, startedAt + deadlines[attempt] - Date.now())
        : intervalMs,
    );
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
