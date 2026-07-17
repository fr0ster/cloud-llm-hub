/**
 * Minimal FIFO async semaphore.
 *
 * Bounds how many heavy operations run at once. `acquire()` resolves with a
 * one-shot `release` function; callers MUST call it (in a `finally`) exactly
 * once. When all permits are taken, further `acquire()` calls park in a FIFO
 * queue and are handed a permit — in order — as earlier holders release.
 *
 * Used to cap concurrent SmartAgent executions on the `/mcp/agent/stream/http`
 * (`execute_step`) path: N parallel heavy pipelines each spike memory, so an
 * unbounded fan-out (a planner firing many steps at once — which the tool
 * contract already forbids) could OOM the container. The semaphore turns that
 * into "at most `max` run, the rest wait cheaply", bounding peak memory
 * regardless of how many calls arrive.
 */
export class Semaphore {
  /** Permits currently owned by a running holder (never exceeds `max`). */
  private held = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly max: number;

  /** @param max maximum concurrent holders (coerced to an integer >= 1). */
  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  /** Permits currently held (running). */
  get active(): number {
    return this.held;
  }

  /** How many callers are parked waiting for a permit. */
  get pending(): number {
    return this.waiters.length;
  }

  /**
   * Acquire a permit. Resolves immediately if one is free, otherwise waits in
   * FIFO order. The returned `release` is idempotent — safe to call once; extra
   * calls are ignored.
   */
  async acquire(): Promise<() => void> {
    if (this.held < this.max) {
      this.held++;
    } else {
      // Park until a holder hands us its permit. On resume the permit is
      // already counted in `held` (the releaser never decremented it — it
      // transferred ownership to us), so we do NOT touch `held` here. That
      // transfer keeps `held` pinned at `max` across the handoff, so a fresh
      // acquire() racing in between cannot slip past the cap.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // pass this permit straight to the next waiter — held unchanged
      } else {
        this.held--;
      }
    };
  }
}
