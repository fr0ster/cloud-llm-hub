/**
 * A periodic task that cannot take the process down.
 *
 * A throw inside a `setInterval` callback is an uncaught exception, and CAP
 * shuts the process down on one — so a sweep that fails an hour after start
 * would stop a service that was otherwise serving. The failure is logged and
 * the next tick tries again. A task that returns a promise is guarded the same
 * way, so a rejection is never left unhandled.
 */
export interface TaskLog {
  warn(message: string, detail?: unknown): void;
}

export function guardedTask(
  name: string,
  log: TaskLog,
  run: () => unknown,
): () => void {
  const report = (err: unknown) =>
    log.warn(`${name} failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
  return () => {
    try {
      const result = run();
      if (result instanceof Promise) result.catch(report);
    } catch (err) {
      report(err);
    }
  };
}
