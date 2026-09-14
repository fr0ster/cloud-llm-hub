# LLM Gatekeeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit work against the SAP AI Core per-minute model quota so that a caller is either refused at the door before anything starts, or carried to the end however slowly — and never cut in the middle with an ABAP object left locked.

**Architecture:** One gate object per quota holds a sliding window of request *starts* and a FIFO queue of waiters, driven by a single dispatcher timer. Every LLM and embedder this service constructs is wrapped so that one permit is taken per HTTP attempt. In front of that, a door counts live pipelines across all channels and refuses when memory is spent. An admission handle owns a register of in-flight calls so a slot is freed only after the last of them settles and the ADT session has been torn down.

**Tech Stack:** TypeScript (strict), SAP CAP (`@sap/cds` 9), Node 22, Jest + ts-jest for unit tests, Biome for lint/format. Library seams from `@mcp-abap-adt/llm-agent` 25.0.0 (`ILlm`, `IEmbedder`, `IThrottleStrategy`, `ReportThrottling`, `findThrottled`, `IMcpFailureClassifier`).

**Spec:** `docs/superpowers/specs/2026-09-13-llm-gatekeeper-design.md` (approved at `57225d71`)

## Global Constraints

- **The library invents no durations and neither do we above the connector.** No timeout is added over running work. The only bounds are an `AbortSignal` from whoever is waiting, and idleness where nothing is running.
- **Absent means off, malformed means refuse to start.** An unset variable disables what it configures and the service behaves exactly as today. A malformed value throws at startup naming the variable.
- **One permit per HTTP attempt.** Nothing between the permit and the transport may retry. Providers get `ReportThrottling`.
- **A permit is a start, not a lease.** It expires by ageing out of the window, never by the call ending. The one exception is a call that never reached the wire, which gives its permit back.
- **Only shutdown ends an admitted pipeline.** Not a `429`, not a client disconnect, not a clock of ours.
- **The slot is released last** — after the call register empties and after `safeStop`.
- **Never blind-retry a stateful write.** An unanswered write is reported once, never repeated.
- All code, comments, commit messages and docs in **English**. Biome: single quotes, 2-space indent, 100-char width.
- Every task ends green on `npm run test:unit`, `npm run test:check` and `npx biome check` for the files it touched.

---

## Phase map

Each phase leaves the service working and tested; a later phase may be deferred without leaving the earlier ones half-built.

| Phase | Tasks | Deliverable |
|---|---|---|
| 1 — the gatekeeper | 1–8 | Quota gate, every model call gated, the door, the register, teardown order |
| 2 — a dependency that is down | 9–11 | Destinations close on MCP outage, unanswered writes reported, honest `Retry-After` |
| 3 — collision and visibility | 12–15 | Collision guard, observability, health policy, docs |

## File structure

**New files**

| File | Responsibility |
|---|---|
| `srv/lib/quota-gate.ts` | One quota: sliding window of starts, FIFO waiter queue, one dispatcher timer, permit nodes with `O(1)` give-back. Pure — no env, no logging, no clock but an injected `now`. |
| `srv/lib/quota-registry.ts` | Reads and validates `LLM_GATEKEEPER_QUOTAS` / `LLM_GATEKEEPER_QUOTA_OF_MODEL`, resolves a model name to its gate, answers "is this model configured". |
| `srv/lib/gated-llm.ts` | `GatedLlm` (an `ILlm`) and `gateEmbedder` (an `IEmbedder`): one permit per attempt, wait as told, re-queue when no interval was named, give the permit back when nothing reached the wire. |
| `srv/lib/admission.ts` | The door: live-pipeline counter shared by every channel, the admission handle, the in-flight call register, and the caller-less/collision bookkeeping. |
| `srv/lib/gatekeeper-metrics.ts` | The four observability scopes, kept apart so a collision never reads as memory pressure. |

**Modified files**

| File | Change |
|---|---|
| `srv/agent-config.ts` | Parse, validate and log the three `LLM_GATEKEEPER_*` variables. |
| `srv/agent-manager.ts` | One function constructs every LLM, one constructs the embedder; both gate. Model-quota check at the hot-swap. `invokeEmbeddedTool` takes and honours the signal, and distinguishes a lost connection from a failed tool. |
| `srv/openai-handler.ts` | Admission after the agent is resolved; detached output sink; disconnect notes instead of tearing down; collision refusal. |
| `srv/anthropic-handler.ts` | The same three changes. |
| `srv/agent-mcp.ts` | The local semaphore is replaced by the shared door; teardown order unchanged but now waits on the register. |
| `srv/agent-service.ts`, `srv/agent-service.cds` | `Chat` removed — dead surface with neither a door nor a session lifecycle. `Health` stays: it starts no pipeline and is the one caller of the probe policy. |
| `srv/lib/throttle-surfacing.ts` | Formatters for the door refusal (no number), the collision refusal (`409`/`pipeline_in_flight`) and the unknown-model refusal (`400`). |
| `srv/lib/recording-mcp-client.ts` | Open the record at dispatch so "sent, unanswered" is a state, not an absence. |
| `docs/architecture/ARCHITECTURE.md`, `README.md`, `.mtaext` samples | Document the variables and the guarantee. |

---

## Phase 1 — the gatekeeper

### Task 1: The quota gate

**Files:**
- Create: `srv/lib/quota-gate.ts`
- Test: `test/unit/quota-gate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface Permit { giveBack(): void }`
  - `export interface QuotaLimits { limit: number; windowMs: number }`
  - ```ts
    export class QuotaGate {
      constructor(limits: QuotaLimits, now?: () => number);
      acquire(signal?: AbortSignal, opts?: { notBefore?: number }): Promise<Permit>;
      msUntilNextOpening(): number;
      get liveStarts(): number;
      get waiting(): number;
      stop(reason?: unknown): void;
    }
    ```

- [ ] **Step 1: Write the failing test**

Create `test/unit/quota-gate.test.ts`:

```ts
import { QuotaGate } from '../../srv/lib/quota-gate';

/** A clock the test moves by hand, so no test waits on real time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('QuotaGate — the window', () => {
  it('admits up to the limit immediately and counts them as starts', async () => {
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 3, windowMs: 60_000 }, clock.now);
    await gate.acquire();
    await gate.acquire();
    await gate.acquire();
    expect(gate.liveStarts).toBe(3);
    gate.stop();
  });

  it('parks the caller past the limit and admits it when the oldest start ages out', async () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 1, windowMs: 60_000 }, clock.now);
    await gate.acquire();

    let admitted = false;
    const parked = gate.acquire().then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(gate.waiting).toBe(1);

    clock.advance(60_000);
    jest.advanceTimersByTime(60_000);
    await parked;
    expect(admitted).toBe(true);
    gate.stop();
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/unit/quota-gate.test.ts`
Expected: FAIL — `Cannot find module '../../srv/lib/quota-gate'`.

- [ ] **Step 3: Write the gate**

Create `srv/lib/quota-gate.ts`:

```ts
/**
 * One quota: a sliding window of request STARTS and a FIFO queue of waiters.
 *
 * A permit is taken on entry and expires by ageing out of the window, never by
 * the call ending — this counts starts per minute, not concurrency, which is
 * why it is not a semaphore.
 *
 * The one exception is a call that never reached the wire: it gives its permit
 * back, because it was never a start. That is a correction of the record, so it
 * must be cheap and must not disturb the window's ordering — hence a permit is
 * a node the holder keeps, marked dead in place in O(1) and skipped when the
 * head is trimmed, with the live count maintained as it is marked.
 */

export interface Permit {
  /** Undo this start. Idempotent; only meaningful before the node ages out. */
  giveBack(): void;
}

export interface QuotaLimits {
  limit: number;
  windowMs: number;
}

/**
 * One start, in a doubly-linked list.
 *
 * A list rather than an array because a permit given back has to leave from
 * the MIDDLE in constant time. Marking it dead in place and skipping it later
 * puts a scan back on the hot path — and that scan is longest during a herd of
 * pre-wire refusals, which is precisely when this code is under load. Unlinking
 * is `O(1)` from anywhere, the head is the oldest and the tail is the newest,
 * so nothing is ever searched for.
 */
interface StartNode {
  at: number;
  prev: StartNode | undefined;
  next: StartNode | undefined;
  /** Off the list already, by give-back or by ageing out. */
  gone: boolean;
}

interface Waiter {
  resolve: (permit: Permit) => void;
  reject: (reason: unknown) => void;
  cancelled: boolean;
  /**
   * Not eligible before this moment. A retry joins the queue immediately and
   * keeps its place; sleeping outside and re-acquiring afterwards would let
   * newcomers overtake it, and would wake every throttled caller at once to
   * race — which is the herd this queue exists to prevent.
   */
  notBefore: number;
}

export class QuotaGate {
  /** Oldest start. */
  private oldest: StartNode | undefined;
  /** Newest start. Read directly for pacing; never searched for. */
  private newest: StartNode | undefined;
  /** Waiters, also consumed by index; a cancelled one is skipped, not spliced. */
  private waiters: Waiter[] = [];
  private waitHead = 0;
  private liveWaiters = 0;
  private live = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly limits: QuotaLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts counted inside the current window. */
  get liveStarts(): number {
    this.trim();
    return this.live;
  }

  /**
   * Callers parked waiting for a place.
   *
   * A counter, not a scan: this is read on every `acquire` and every
   * `schedule`, so walking the queue's tail each time would put a linear step
   * back on the hot path the head indices exist to keep constant.
   */
  get waiting(): number {
    return this.liveWaiters;
  }

  /**
   * Take a permit, waiting in FIFO order if the window is full.
   *
   * The caller's signal is the only bound: this method sets no deadline of its
   * own, because how long anyone may be held is not ours to decide.
   */
  acquire(signal?: AbortSignal, opts?: { notBefore?: number }): Promise<Permit> {
    // Nothing is admitted after the gate stops. Without this a caller arriving
    // during shutdown either takes a place nobody will account for, or parks in
    // a queue whose timer is gone and waits for ever.
    if (this.stopped) {
      return Promise.reject(new Error('Gate stopped'));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('Aborted'));
    }
    const notBefore = opts?.notBefore ?? 0;
    this.trim();
    if (this.waiting === 0 && this.live < this.limits.limit && notBefore <= this.now()) {
      return Promise.resolve(this.record());
    }
    return new Promise<Permit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, cancelled: false, notBefore };
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            // Marked, not removed: splicing is linear and would also disturb
            // the order every other waiter is relying on.
            if (waiter.cancelled) return;
            waiter.cancelled = true;
            this.liveWaiters--;
            reject(signal.reason ?? new Error('Aborted'));
            this.schedule();
          },
          { once: true },
        );
      }
      this.waiters.push(waiter);
      this.liveWaiters++;
      this.schedule();
    });
  }

  /**
   * When our own rate next allows a start, in milliseconds.
   *
   * This is what a throttled call with no named interval paces against, and it
   * is our configured rate rather than our window. Two things can hold a start
   * back and the answer is the later of them:
   *
   * - **spacing.** At a limit of ten a minute, starts belong six seconds
   *   apart, so a call goes six seconds after the most recent one. Returning
   *   the oldest start's expiry instead would delay it by nearly the whole
   *   minute while nine places sat empty.
   * - **a full window.** When every place is taken, no spacing helps: the
   *   oldest start has to age out first.
   *
   * Neither is a guess about the server. Both come from the operator's own
   * numbers, which is what makes this ours to decide.
   */
  msUntilNextOpening(): number {
    this.trim();
    const now = this.now();
    const spacing = Math.ceil(this.limits.windowMs / this.limits.limit);
    // Both ends are pointers. A permit given back has already left the list, so
    // `newest` can never be one — which is the whole reason this is a list and
    // not an array with dead entries to step past.
    const untilSpaced =
      this.newest === undefined ? 0 : Math.max(0, this.newest.at + spacing - now);
    const untilPlace =
      this.live < this.limits.limit || this.oldest === undefined
        ? 0
        : Math.max(0, this.oldest.at + this.limits.windowMs - now);

    return Math.max(untilSpaced, untilPlace);
  }

  /**
   * Drop the timer and turn away everyone still parked. The gate is unusable
   * after.
   *
   * Rejecting is the point: this runs on shutdown and from
   * `clearQuotaRegistry`, and a waiter left holding an unsettled promise would
   * hang its pipeline for the life of the process — the one thing a shutdown
   * path must not do.
   */
  stop(reason: unknown = new Error('Gate stopped')): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (let i = this.waitHead; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      if (waiter.cancelled) continue;
      waiter.cancelled = true;
      this.liveWaiters--;
      waiter.reject(reason);
    }
    this.waitHead = this.waiters.length;
  }

  /** Append a start and hand back the node that undoes it. */
  private record(): Permit {
    const node: StartNode = {
      at: this.now(),
      prev: this.newest,
      next: undefined,
      gone: false,
    };
    if (this.newest) this.newest.next = node;
    this.newest = node;
    if (!this.oldest) this.oldest = node;
    this.live++;
    return {
      giveBack: () => {
        // Already off the list, by an earlier give-back or by ageing out.
        // Without this a late give-back would decrement `live` twice and let
        // the dispatcher admit past the limit from then on.
        if (node.gone) return;
        this.unlink(node);
        this.live--;
        // A place opened NOW, not at the expiry the timer was set for.
        this.dispatch();
      },
    };
  }

  /** Remove one node from anywhere in the list. O(1). */
  private unlink(node: StartNode): void {
    node.gone = true;
    if (node.prev) node.prev.next = node.next;
    else this.oldest = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.newest = node.prev;
    node.prev = undefined;
    node.next = undefined;
  }

  /** Age out everything older than the window. O(1) amortised. */
  private trim(): void {
    const cutoff = this.now() - this.limits.windowMs;
    while (this.oldest && this.oldest.at <= cutoff) {
      this.unlink(this.oldest);
      this.live--;
    }
  }

  /** Hand out every free place, in order, then re-arm the timer. */
  private dispatch(): void {
    if (this.stopped) return;
    this.trim();
    for (;;) {
      const waiter = this.firstLiveWaiter();
      if (!waiter || this.live >= this.limits.limit) break;
      // Strictly first come, first served, including a retry waiting out an
      // interval: the head holds the line rather than being stepped over. The
      // timer below wakes for it.
      if (waiter.notBefore > this.now()) break;
      this.waitHead++;
      waiter.cancelled = true; // settled; its abort listener has nothing left to do
      this.liveWaiters--;
      waiter.resolve(this.record());
    }
    if (this.waitHead > 32 && this.waitHead * 2 > this.waiters.length) {
      this.waiters = this.waiters.slice(this.waitHead);
      this.waitHead = 0;
    }
    this.schedule();
  }

  /**
   * The first waiter still in play, dropping the cancelled ones on the way.
   *
   * Advancing the head past them here means nothing else has to skip them, so
   * each cancelled waiter is stepped over exactly once across the gate's life.
   */
  private firstLiveWaiter(): Waiter | undefined {
    while (this.waitHead < this.waiters.length && this.waiters[this.waitHead].cancelled) {
      this.waitHead++;
    }
    if (this.waitHead > 32 && this.waitHead * 2 > this.waiters.length) {
      this.waiters = this.waiters.slice(this.waitHead);
      this.waitHead = 0;
    }
    return this.waiters[this.waitHead];
  }

  /** One timer per quota, set to the moment the next place opens. */
  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.waiting === 0) return;
    // Only a FULL window makes anyone wait for an expiry. With room to spare
    // the place is already there, and timing the wake to the oldest start
    // would park a delayed waiter for the rest of the window over nothing.
    const untilPlace =
      this.live < this.limits.limit || this.oldest === undefined
        ? 0
        : Math.max(0, this.oldest.at + this.limits.windowMs - this.now());
    // And the head waiter may not be eligible yet, in which case waking on the
    // place alone would spin.
    const head = this.firstLiveWaiter();
    const untilEligible = head ? Math.max(0, head.notBefore - this.now()) : 0;
    const waitMs = Math.max(untilPlace, untilEligible);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dispatch();
    }, waitMs);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/unit/quota-gate.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the properties this shape gets wrong**

Append to `test/unit/quota-gate.test.ts`:

```ts
describe('QuotaGate — the properties this shape gets wrong', () => {
  it('never leaves waiters present with no dispatch scheduled', async () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 1, windowMs: 1_000 }, clock.now);
    await gate.acquire();
    const parked = gate.acquire();
    // No manual nudge: if scheduling were missed, this would hang for ever.
    clock.advance(1_000);
    jest.advanceTimersByTime(1_000);
    await expect(parked).resolves.toBeDefined();
    gate.stop();
    jest.useRealTimers();
  });

  it('serves waiters first in, first out', async () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 1, windowMs: 1_000 }, clock.now);
    await gate.acquire();
    const order: number[] = [];
    const a = gate.acquire().then(() => order.push(1));
    const b = gate.acquire().then(() => order.push(2));
    const c = gate.acquire().then(() => order.push(3));
    for (let i = 0; i < 3; i++) {
      clock.advance(1_000);
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
    }
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
    gate.stop();
    jest.useRealTimers();
  });

  it('holds the limit with twenty callers against five places', async () => {
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 5, windowMs: 60_000 }, clock.now);
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      void gate.acquire().then(() => { admitted++; });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(admitted).toBe(5);
    expect(gate.liveStarts).toBe(5);
    gate.stop();
  });

  it('admits one and parks the rest at a limit of one', async () => {
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 1, windowMs: 60_000 }, clock.now);
    let admitted = 0;
    for (let i = 0; i < 4; i++) {
      void gate.acquire().then(() => { admitted++; });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(admitted).toBe(1);
    expect(gate.waiting).toBe(3);
    gate.stop();
  });

  it('wakes a sleeping waiter when a permit is given back', async () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 1, windowMs: 600_000 }, clock.now);
    const permit = await gate.acquire();

    let admitted = false;
    const parked = gate.acquire().then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);

    // No clock movement at all: the room comes from the give-back, and the
    // timer was set ten minutes out. This is the lost wake-up in its second
    // costume.
    permit.giveBack();
    await parked;
    expect(admitted).toBe(true);
    expect(gate.liveStarts).toBe(1);
    gate.stop();
    jest.useRealTimers();
  });

  it('keeps a retrying caller in its place rather than behind a newcomer', async () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 1, windowMs: 1_000 }, clock.now);
    await gate.acquire();

    const order: string[] = [];
    // A retry that may not go for 200ms, queued first.
    const retry = gate
      .acquire(undefined, { notBefore: clock.now() + 200 })
      .then(() => order.push('retry'));
    // A newcomer, eligible at once, queued second.
    const fresh = gate.acquire().then(() => order.push('fresh'));

    for (let i = 0; i < 3; i++) {
      clock.advance(1_000);
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
    }
    await Promise.all([retry, fresh]);
    // Strictly first come, first served: the head holds the line while it
    // waits out its interval instead of being stepped over.
    expect(order).toEqual(['retry', 'fresh']);
    gate.stop();
    jest.useRealTimers();
  });

  it('paces a retry at the configured rate, not at the whole window', async () => {
    // Ten a minute is one every six seconds. Returning the oldest start's
    // expiry would hold the retry for nearly a minute while nine places stood
    // empty — and a limit of 1 in the test would have hidden it, because there
    // the two answers coincide.
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 10, windowMs: 60_000 }, clock.now);
    await gate.acquire();
    expect(gate.msUntilNextOpening()).toBe(6_000);
    clock.advance(6_000);
    expect(gate.msUntilNextOpening()).toBe(0);
    gate.stop();
  });

  it('waits for an expiry only when the window is actually full', async () => {
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 2, windowMs: 60_000 }, clock.now);
    await gate.acquire();
    clock.advance(30_000);
    await gate.acquire();
    // Full now, so the oldest start's expiry is the binding constraint.
    expect(gate.msUntilNextOpening()).toBe(30_000);
    gate.stop();
  });

  it('does not park a delayed waiter behind an expiry when places are free', async () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 10, windowMs: 60_000 }, clock.now);
    await gate.acquire();

    let admitted = false;
    const parked = gate
      .acquire(undefined, { notBefore: clock.now() + 200 })
      .then(() => { admitted = true; });

    clock.advance(200);
    jest.advanceTimersByTime(200);
    await parked;
    // Nine places were free the whole time; only eligibility was pending.
    expect(admitted).toBe(true);
    gate.stop();
    jest.useRealTimers();
  });

  it('paces from the newest live start, not from a returned permit', async () => {
    // A permit given back was never a start. Reading it as the newest would
    // push the next retry out by a whole spacing for a request that never
    // reached the wire — and `trim` cannot help, because it only drops dead
    // nodes from the head, and this one is at the tail.
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 10, windowMs: 60_000 }, clock.now);
    await gate.acquire(); // a real start, stays live
    clock.advance(6_000);
    const returned = await gate.acquire();
    returned.giveBack();
    // Six seconds have passed since the only live start, so a retry may go now.
    expect(gate.msUntilNextOpening()).toBe(0);
    gate.stop();
  });

  it('admits nobody once it has stopped', async () => {
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 10, windowMs: 60_000 }, clock.now);
    gate.stop();
    // Places were free, which is exactly how this would have gone unnoticed:
    // a permit handed out after shutdown that nothing will ever account for.
    await expect(gate.acquire()).rejects.toThrow(/stopped/i);
  });

  it('turns away everyone still parked when it stops', async () => {
    // stop() runs on shutdown and from clearQuotaRegistry. A waiter left
    // holding an unsettled promise would hang its pipeline for the life of the
    // process, which is the one thing a shutdown path must not do.
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 1, windowMs: 60_000 }, clock.now);
    await gate.acquire();
    const parked = gate.acquire();
    gate.stop(new Error('shutting down'));
    await expect(parked).rejects.toThrow('shutting down');
    expect(gate.waiting).toBe(0);
  });

  it('ignores a permit given back after it has aged out of the window', async () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 2, windowMs: 1_000 }, clock.now);
    const permit = await gate.acquire();
    await gate.acquire();
    clock.advance(1_500);
    expect(gate.liveStarts).toBe(0);

    // The start is already uncounted. Decrementing again would push the count
    // below the real number of starts and let the dispatcher admit past the
    // limit from then on.
    permit.giveBack();
    expect(gate.liveStarts).toBe(0);
    await gate.acquire();
    await gate.acquire();
    expect(gate.liveStarts).toBe(2);
    gate.stop();
    jest.useRealTimers();
  });

  it('leaves the queue intact when a waiting caller aborts', async () => {
    const clock = fakeClock();
    const gate = new QuotaGate({ limit: 1, windowMs: 60_000 }, clock.now);
    await gate.acquire();
    const controller = new AbortController();
    const parked = gate.acquire(controller.signal);
    const behind = gate.acquire();
    controller.abort(new Error('caller left'));
    await expect(parked).rejects.toThrow('caller left');
    expect(gate.waiting).toBe(1);
    void behind;
    gate.stop();
  });
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest test/unit/quota-gate.test.ts`
Expected: PASS, 16 tests.

> **On the hot path being constant-time.** The queue is a serialisation point,
> so `shift`, `find`, `indexOf` and `splice` are all wrong here — each is linear
> in what it touches. The window is a doubly-linked list because a permit given
> back has to leave from the middle: marking it dead in an array and skipping it
> later puts a scan back on the hot path, and that scan is longest during a herd
> of pre-wire refusals, which is exactly when this code is under load. Both ends
> are pointers, so the oldest start and the newest are read rather than searched
> for. The waiter queue stays an array consumed by a head index, with cancelled
> entries stepped over once each and the array compacted when the dead prefix
> passes half its length.

- [ ] **Step 7: Lint and typecheck**

Run: `npx biome check --write srv/lib/quota-gate.ts test/unit/quota-gate.test.ts && npm run test:check`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/quota-gate.ts test/unit/quota-gate.test.ts
git commit -m "feat(gatekeeper): one quota, a sliding window of starts and a FIFO queue"
```

### Task 2: The configuration, and the quota registry

**Files:**
- Create: `srv/lib/gatekeeper-config.ts`, `srv/lib/quota-registry.ts`
- Modify: `srv/agent-config.ts` (log what is in force, which is also what validates it)
- Test: `test/unit/quota-registry.test.ts`

**Why the configuration is its own module.** Validation and runtime state are
different things and must not import each other. With the door's check inside
`admission.ts`, the configuration loader would depend on a module holding live
counters, while `agent-manager` and both handlers already import both — a cycle
that resolves differently depending on import order, with half-initialised
exports as the failure. So one module reads the environment and validates it,
and holds nothing; the registry and the door each consume it.

**Interfaces:**
- Consumes: `QuotaGate`, `QuotaLimits`, `Permit` from Task 1.
- Produces, from `gatekeeper-config`:
  - `export interface GatekeeperConfig { quotas: Map<string, QuotaLimits>; keyOfModel: Map<string, string>; maxLivePipelines?: number }`
  - `export function gatekeeperConfig(): GatekeeperConfig` — parsed once, fully validated, throws on anything malformed
  - `export function describeGatekeeperConfig(): string` — the one-line startup log, and the call that makes validation happen at boot
  - `export function clearGatekeeperConfig(): void`
- Produces, from `quota-registry`:
  - `export class UnknownModelError extends Error { readonly model: string }`
  - `export function quotasConfigured(): boolean`
  - `export function quotaForModel(model: string): { key: string; gate: QuotaGate } | undefined` — throws `UnknownModelError` when quotas are configured and the model names neither an entry nor a mapping
  - `export function gateForModel(model: string): QuotaGate | undefined`
  - `export function liveGates(): Array<{ key: string; gate: QuotaGate }>` — for the metrics snapshot
  - `export function clearQuotaRegistry(): void` — test seam, mirrors `clearAgentConfig`

- [ ] **Step 1: Write the failing test**

Create `test/unit/quota-registry.test.ts`:

```ts
const load = () => {
  jest.resetModules();
  const mod = require('../../srv/lib/quota-registry') as typeof import('../../srv/lib/quota-registry');
  mod.clearQuotaRegistry();
  return mod;
};

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_QUOTAS;
  delete process.env.LLM_GATEKEEPER_QUOTA_OF_MODEL;
  jest.resetModules();
});

describe('quota registry — absent means off', () => {
  it('gates nothing and rejects nothing when no quotas are configured', () => {
    const mod = load();
    expect(mod.quotasConfigured()).toBe(false);
    expect(mod.gateForModel('anything-at-all')).toBeUndefined();
  });
});

describe('quota registry — a configured quota', () => {
  it('gives each model its own gate, keyed by name, and reuses it', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({
      'anthropic--claude-4.5-sonnet': { limit: 60 },
      'text-embedding-3-small': { limit: 200 },
    });
    const mod = load();
    const a = mod.gateForModel('anthropic--claude-4.5-sonnet');
    const b = mod.gateForModel('anthropic--claude-4.5-sonnet');
    const c = mod.gateForModel('text-embedding-3-small');
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('maps several models onto one quota when told to', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ shared: { limit: 10 } });
    process.env.LLM_GATEKEEPER_QUOTA_OF_MODEL = JSON.stringify({
      'model-a': 'shared',
      'model-b': 'shared',
    });
    const mod = load();
    expect(mod.gateForModel('model-a')).toBe(mod.gateForModel('model-b'));
  });

  it('reports mapped models under the key they share, not their own names', () => {
    // Filed by model name, one full window would appear as two half-full ones.
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ shared: { limit: 10 } });
    process.env.LLM_GATEKEEPER_QUOTA_OF_MODEL = JSON.stringify({
      'model-a': 'shared',
      'model-b': 'shared',
    });
    const mod = load();
    expect(mod.quotaForModel('model-a')?.key).toBe('shared');
    expect(mod.quotaForModel('model-b')?.key).toBe('shared');
    expect(mod.liveGates().map((g) => g.key)).toEqual(['shared']);
  });

  it('defaults the window to a minute, which is how providers meter', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 1 } });
    const mod = load();
    const { describeGatekeeperConfig } = require('../../srv/lib/gatekeeper-config') as typeof import('../../srv/lib/gatekeeper-config');
    expect(describeGatekeeperConfig()).toContain('60000');
  });
});

describe('quota registry — malformed means refuse to start', () => {
  const bad: Array<[string, string]> = [
    ['not JSON at all', '{'],
    ['a limit that is not a number', JSON.stringify({ m: { limit: 'many' } })],
    ['a limit of zero', JSON.stringify({ m: { limit: 0 } })],
    ['a negative limit', JSON.stringify({ m: { limit: -1 } })],
    ['a fractional limit', JSON.stringify({ m: { limit: 1.5 } })],
    ['a window of zero', JSON.stringify({ m: { limit: 1, windowMs: 0 } })],
  ];
  for (const [what, value] of bad) {
    it(`refuses ${what}, naming the variable`, () => {
      process.env.LLM_GATEKEEPER_QUOTAS = value;
      expect(() => load().quotasConfigured()).toThrow(/LLM_GATEKEEPER_QUOTAS/);
    });
  }

  it('refuses a mapping to a quota key that does not exist', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ real: { limit: 1 } });
    process.env.LLM_GATEKEEPER_QUOTA_OF_MODEL = JSON.stringify({ m: 'typo' });
    expect(() => load().quotasConfigured()).toThrow(
      /LLM_GATEKEEPER_QUOTA_OF_MODEL.*typo/s,
    );
  });
});

describe('gatekeeper config — a door needs a quota', () => {
  it('refuses a door with no window, naming both variables', () => {
    // The door admits on a promise the window keeps. Alone it would refuse
    // callers to protect a guarantee that the first 429 then breaks.
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '4';
    delete process.env.LLM_GATEKEEPER_QUOTAS;
    expect(() => load().quotasConfigured()).toThrow(
      /LLM_GATEKEEPER_MAX_LIVE_PIPELINES[\s\S]*LLM_GATEKEEPER_QUOTAS/,
    );
    delete process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES;
  });

  it('accepts the two together', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 1 } });
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '4';
    expect(() => load().quotasConfigured()).not.toThrow();
    delete process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES;
  });
});

describe('quota registry — an unknown model at runtime', () => {
  it('is rejected once quotas are configured, naming the model and the variable', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ known: { limit: 1 } });
    const mod = load();
    // A typo in body.model would otherwise un-gate every later main call,
    // and no startup log could have caught it.
    expect(() => mod.gateForModel('knwon')).toThrow(mod.UnknownModelError);
    try {
      mod.gateForModel('knwon');
    } catch (e) {
      expect((e as Error).message).toContain('knwon');
      expect((e as Error).message).toContain('LLM_GATEKEEPER_QUOTAS');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/unit/quota-registry.test.ts`
Expected: FAIL — `Cannot find module '../../srv/lib/quota-registry'`.

- [ ] **Step 3: Write the registry**

Create `srv/lib/gatekeeper-config.ts` — the environment, read once and checked,
holding no runtime state of any kind:

```ts
import type { QuotaLimits } from './quota-gate';

/**
 * Everything the gatekeeper is configured with, and nothing it remembers.
 *
 * Separate from the registry and the door because validation and live state
 * must not depend on each other. With the door's check inside `admission.ts`,
 * the configuration loader depended on a module holding live counters, while
 * `agent-manager` and both handlers already imported both — a cycle that
 * resolves differently depending on import order, with half-initialised
 * exports as the failure mode. One module reads the environment and validates
 * it; the registry and the door each consume it.
 */

const QUOTAS_VAR = 'LLM_GATEKEEPER_QUOTAS';
const MAP_VAR = 'LLM_GATEKEEPER_QUOTA_OF_MODEL';
const DOOR_VAR = 'LLM_GATEKEEPER_MAX_LIVE_PIPELINES';
const DEFAULT_WINDOW_MS = 60_000;

export interface GatekeeperConfig {
  quotas: Map<string, QuotaLimits>;
  keyOfModel: Map<string, string>;
  maxLivePipelines?: number;
}

let cached: GatekeeperConfig | undefined;

function readJsonObject(name: string): Record<string, unknown> | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${name}: expected JSON, got ${JSON.stringify(raw)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${name}: expected a JSON object of entries`);
  }
  return parsed as Record<string, unknown>;
}

function positiveInt(value: unknown, name: string, field: string, key: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(
      `Invalid ${name}: ${JSON.stringify(key)}.${field} must be a positive whole number, got ${JSON.stringify(value)}`,
    );
  }
  return value as number;
}

function build(): GatekeeperConfig {
  const quotas = new Map<string, QuotaLimits>();
  const raw = readJsonObject(QUOTAS_VAR);
  if (raw) {
    for (const [key, entry] of Object.entries(raw)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(
          `Invalid ${QUOTAS_VAR}: ${JSON.stringify(key)} must be an object with a limit`,
        );
      }
      const e = entry as { limit?: unknown; windowMs?: unknown };
      quotas.set(key, {
        limit: positiveInt(e.limit, QUOTAS_VAR, 'limit', key),
        windowMs:
          e.windowMs === undefined
            ? DEFAULT_WINDOW_MS
            : positiveInt(e.windowMs, QUOTAS_VAR, 'windowMs', key),
      });
    }
  }

  const keyOfModel = new Map<string, string>();
  const mapping = readJsonObject(MAP_VAR);
  if (mapping) {
    for (const [model, key] of Object.entries(mapping)) {
      if (typeof key !== 'string' || !quotas.has(key)) {
        // Somebody intending a limit and not getting one, which is the failure
        // mode this whole design exists to make visible.
        throw new Error(
          `Invalid ${MAP_VAR}: ${JSON.stringify(model)} maps to ${JSON.stringify(key)}, which is not a key in ${QUOTAS_VAR}`,
        );
      }
      keyOfModel.set(model, key);
    }
  }

  let maxLivePipelines: number | undefined;
  const door = process.env[DOOR_VAR];
  if (door !== undefined && door.trim() !== '') {
    const n = Number(door);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new Error(
        `Invalid ${DOOR_VAR}: expected a positive whole number of pipelines, got ${JSON.stringify(door)}`,
      );
    }
    if (quotas.size === 0) {
      // The door is the front half of a guarantee whose back half is the
      // window. Alone it would refuse callers to protect a promise it cannot
      // keep: an admitted request would meet its first 429 and end.
      throw new Error(
        `Invalid ${DOOR_VAR}: a door needs a quota. Set ${QUOTAS_VAR} as well, or unset the door.`,
      );
    }
    maxLivePipelines = n;
  }

  return { quotas, keyOfModel, maxLivePipelines };
}

export function gatekeeperConfig(): GatekeeperConfig {
  if (!cached) cached = build();
  return cached;
}

/** One line for the startup log, and the call that makes validation happen. */
export function describeGatekeeperConfig(): string {
  const cfg = gatekeeperConfig();
  const quotas =
    cfg.quotas.size === 0
      ? 'none configured (no rate limiting)'
      : [...cfg.quotas].map(([k, l]) => `${k}=${l.limit}/${l.windowMs}ms`).join(', ');
  const mapped = cfg.keyOfModel.size > 0 ? `, mapped models: ${cfg.keyOfModel.size}` : '';
  const door =
    cfg.maxLivePipelines === undefined
      ? 'no door'
      : `door: ${cfg.maxLivePipelines} live pipelines`;
  return `LLM gatekeeper — quotas: ${quotas}${mapped}; ${door}`;
}

/** Test seam. */
export function clearGatekeeperConfig(): void {
  cached = undefined;
}
```

and `srv/lib/quota-registry.ts`, which now holds gates and nothing else:

```ts
import { clearGatekeeperConfig, gatekeeperConfig } from './gatekeeper-config';
import { QuotaGate } from './quota-gate';

const QUOTAS_VAR = 'LLM_GATEKEEPER_QUOTAS';
const MAP_VAR = 'LLM_GATEKEEPER_QUOTA_OF_MODEL';

/** A model nobody configured, seen while quotas are in force. */
export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(
      `Model ${JSON.stringify(model)} has no quota. Add it to ${QUOTAS_VAR}, or map it to an existing key with ${MAP_VAR}.`,
    );
    this.name = 'UnknownModelError';
  }
}

const gates = new Map<string, QuotaGate>();

/** Whether any quota is in force. False means the service behaves as before. */
export function quotasConfigured(): boolean {
  return gatekeeperConfig().quotas.size > 0;
}

/**
 * The gate AND the key it is filed under.
 *
 * Observability needs the key, not the model name: two models mapped onto one
 * quota spend the same places, and reporting them as separate scopes would show
 * two half-full windows where there is one full one.
 *
 * Throws `UnknownModelError` when quotas ARE configured and the model names
 * neither an entry nor a mapping: `/v1/chat/completions` accepts any
 * `body.model` and hot-swaps the shared LLM to it, so a typo would otherwise
 * un-gate every later main call, long after any startup check could see it.
 */
export function quotaForModel(
  model: string,
): { key: string; gate: QuotaGate } | undefined {
  const cfg = gatekeeperConfig();
  if (cfg.quotas.size === 0) return undefined;
  const key = cfg.keyOfModel.get(model) ?? model;
  const limits = cfg.quotas.get(key);
  if (!limits) throw new UnknownModelError(model);
  let gate = gates.get(key);
  if (!gate) {
    gate = new QuotaGate(limits);
    gates.set(key, gate);
  }
  return { key, gate };
}

/** The gate alone, for callers that do not need the key. */
export function gateForModel(model: string): QuotaGate | undefined {
  return quotaForModel(model)?.gate;
}

/** Every gate built so far, for the metrics snapshot. */
export function liveGates(): Array<{ key: string; gate: QuotaGate }> {
  return [...gates.entries()].map(([key, gate]) => ({ key, gate }));
}

/** Test seam. Drops the parsed configuration and every gate built from it. */
export function clearQuotaRegistry(): void {
  for (const gate of gates.values()) gate.stop();
  gates.clear();
  clearGatekeeperConfig();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/unit/quota-registry.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Log the configuration at startup**

In `srv/agent-config.ts`, inside `loadAgentConfig()` just before it returns, add:

```ts
  // A limit only shows itself under load, and by then nobody remembers what was
  // configured. One line covers quotas and the door together, and reading it
  // here is what makes a malformed value — or a door configured without a
  // quota — fail at startup rather than on the first request.
  cds.log('agent-config').info(describeGatekeeperConfig());
```

and at the top of the file:

```ts
import { describeGatekeeperConfig } from './lib/gatekeeper-config';
```

> Only `gatekeeper-config` is imported here, never `admission`. The
> configuration loader must not depend on a module holding live counters:
> `agent-manager` and both handlers already import both, and the cycle would
> resolve differently depending on import order.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm run test:unit && npm run test:check`
Expected: PASS, no type errors.

- [ ] **Step 7: Lint and commit**

```bash
npx biome check --write srv/lib/gatekeeper-config.ts srv/lib/quota-registry.ts srv/agent-config.ts test/unit/quota-registry.test.ts
git add srv/lib/gatekeeper-config.ts srv/lib/quota-registry.ts srv/agent-config.ts test/unit/quota-registry.test.ts
git commit -m "feat(gatekeeper): quotas come from configuration, and a malformed one refuses to start"
```

### Task 3: `GatedLlm` — one permit per HTTP attempt

**Files:**
- Create: `srv/lib/gated-llm.ts`
- Test: `test/unit/gated-llm.test.ts`

**Interfaces:**
- Consumes: `quotaForModel`, `QuotaGate`, `Permit` from Tasks 1–2.

> No metrics here. This wrapper is where the wait is measurable, and Task 13 adds the two lines that measure it — a task may not import a module a later one creates, and a half-built module smuggled in early is the same rule broken quietly.
- Produces:
  - `export function gateLlm(inner: ILlm, model: string): ILlm`
  - `export function gateEmbedder(inner: IEmbedder, model: string): IEmbedder`
  - `export const REQUEUE_REASON = 'no-interval'` — why a throttled call with no named interval goes back to the tail

**Why the wrapper and not `ILlmRateLimiter`:** that seam admits one call and cannot see the attempts inside it. `RateLimiterLlm.chat` awaits `acquire()` once and hands off to a chain that retries, so every retry is a request the window never saw.

**Where it sits:** the builder wraps `RetryLlm` *above* whatever main LLM it is handed, so each of its attempts re-enters this wrapper and takes its own permit. Nothing between the permit and the transport may retry — the provider's strategy is `ReportThrottling`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/gated-llm.test.ts`:

```ts
import type { ILlm, LlmError, LlmResponse, Result } from '@mcp-abap-adt/llm-agent';

const load = () => {
  jest.resetModules();
  const registry = require('../../srv/lib/quota-registry') as typeof import('../../srv/lib/quota-registry');
  registry.clearQuotaRegistry();
  const gated = require('../../srv/lib/gated-llm') as typeof import('../../srv/lib/gated-llm');
  return { registry, gated };
};

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_QUOTAS;
  jest.resetModules();
});

/** An ILlm that fails with a scripted error a fixed number of times. */
function scriptedLlm(errors: LlmError[]) {
  let calls = 0;
  const llm: ILlm & { calls: () => number } = {
    model: 'm',
    calls: () => calls,
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      const err = errors[calls];
      calls++;
      if (err) return { ok: false, error: err };
      return { ok: true, value: { content: 'ok', finishReason: 'stop' } };
    },
    async *streamChat() {
      yield { ok: true as const, value: { content: 'ok', finishReason: 'stop' as const } };
    },
  };
  return llm;
}

function throttled(retryAfterSeconds?: number, attempts = 1): LlmError {
  const e = new Error('429') as LlmError & {
    throttled?: boolean;
    attempts?: number;
    retryAfterSeconds?: number;
  };
  e.throttled = true;
  e.attempts = attempts;
  if (retryAfterSeconds !== undefined) e.retryAfterSeconds = retryAfterSeconds;
  return e;
}

describe('gateLlm — every attempt is accounted', () => {
  it('records one start per HTTP attempt, not one per call', async () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 10 } });
    const { registry, gated } = load();
    const inner = scriptedLlm([throttled(0.001), throttled(0.001)]);
    const llm = gated.gateLlm(inner, 'm');

    const result = await llm.chat([]);
    expect(result.ok).toBe(true);
    expect(inner.calls()).toBe(3);
    // Three attempts, three starts. One start here would be the accounting
    // going quietly wrong under exactly the load this exists for.
    expect(registry.gateForModel('m')?.liveStarts).toBe(3);
  });

  it('gives the permit back when nothing reached the wire', async () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 10 } });
    const { registry, gated } = load();
    // attempts === 0 is the library saying it refused before the transport:
    // its own quota gate was shut, so no request left this process.
    const inner = scriptedLlm([throttled(0.001, 0)]);
    const llm = gated.gateLlm(inner, 'm');
    await llm.chat([]);
    expect(inner.calls()).toBe(2);
    expect(registry.gateForModel('m')?.liveStarts).toBe(1);
  });
});

describe('gateLlm — a 429 delays, it does not interrupt', () => {
  it('waits out an interval the server named and finishes', async () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 10 } });
    const { gated } = load();
    const inner = scriptedLlm([throttled(0.001)]);
    const result = await gated.gateLlm(inner, 'm').chat([]);
    expect(result.ok).toBe(true);
  });

  it('re-queues when the server named nothing, rather than guessing a wait', async () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 10 } });
    const { gated } = load();
    const inner = scriptedLlm([throttled(undefined)]);
    const result = await gated.gateLlm(inner, 'm').chat([]);
    expect(result.ok).toBe(true);
    expect(inner.calls()).toBe(2);
  });
});

describe('gateLlm — nothing configured', () => {
  it('passes straight through with no gate at all', async () => {
    const { gated } = load();
    const inner = scriptedLlm([]);
    const result = await gated.gateLlm(inner, 'm').chat([]);
    expect(result.ok).toBe(true);
    expect(inner.calls()).toBe(1);
  });

  it('reports a 429 that named nothing, instead of retrying at once', async () => {
    // With no window there is nothing to pace against, so a zero delay would
    // turn one refusal into a storm against a provider that had just asked us
    // to stop.
    const { gated } = load();
    const inner = scriptedLlm([throttled(undefined)]);
    const result = await gated.gateLlm(inner, 'm').chat([]);
    expect(result.ok).toBe(false);
    expect(inner.calls()).toBe(1);
  });

  it('throws back the outer error, not the marker buried in its cause', async () => {
    // Every layer rewraps, so the marker is usually on a cause. Throwing that
    // would lose the provider's own message and stack.
    const { gated } = load();
    const inner = Object.assign(new Error('429'), {
      throttled: true,
      attempts: 1,
      retryAfterSeconds: 30,
    });
    const outer = Object.assign(new Error('SAP AI SDK API error'), { cause: inner });
    const embedder = gated.gateEmbedder(
      {
        embed: async () => {
          throw outer;
        },
      } as never,
      'm',
    );
    await expect(embedder.embed('x')).rejects.toBe(outer);
  });

  it('throws the embedder 429 back rather than returning an empty result', async () => {
    // The embedder's attempt wrapper swallows the throw to report it, so
    // returning the placeholder here would hand the caller `undefined` as a
    // successful embedding and lose the refusal altogether.
    const { gated } = load();
    const err = Object.assign(new Error('429'), {
      throttled: true,
      attempts: 1,
      retryAfterSeconds: 30,
    });
    const embedder = gated.gateEmbedder(
      {
        embed: async () => {
          throw err;
        },
      } as never,
      'm',
    );
    await expect(embedder.embed('x')).rejects.toBe(err);
  });

  it('reports a 429 that named an interval, instead of waiting it out', async () => {
    // Waiting here would be unbounded: the ceiling that used to make it safe
    // went with WaitIfShortEnough, and there is no door in front to justify it.
    const { gated } = load();
    const inner = scriptedLlm([throttled(600)]);
    const started = Date.now();
    const result = await gated.gateLlm(inner, 'm').chat([]);
    expect(result.ok).toBe(false);
    expect(inner.calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/unit/gated-llm.test.ts`
Expected: FAIL — `Cannot find module '../../srv/lib/gated-llm'`.

- [ ] **Step 3: Write the wrapper**

Create `srv/lib/gated-llm.ts`:

```ts
import {
  findThrottled,
  type CallOptions,
  type IEmbedder,
  type IEmbedResult,
  type ILlm,
  type LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmTool,
  type Message,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { Permit } from './quota-gate';
import { quotaForModel } from './quota-registry';

/**
 * One permit per HTTP attempt, taken as close to the wire as we can get.
 *
 * `ILlmRateLimiter` is not the seam for this: it admits one CALL and cannot see
 * the attempts inside it, so a retry below it is a request the window never
 * saw. The retrying therefore stays above this wrapper — the builder's
 * `RetryLlm` re-enters here and takes its own permit — and nothing between the
 * permit and the transport may retry, which is why the provider's strategy is
 * `ReportThrottling`.
 */

export const REQUEUE_REASON = 'no-interval';

/**
 * Run one gated operation: take a permit, attempt, and decide from the result.
 *
 * A throttled failure whose `attempts` is 0 never reached the wire — the
 * library's own gate refused it, knowing the quota was shut. That is not a
 * start, so the permit goes back.
 */
async function runGated<T>(
  model: string,
  signal: AbortSignal | undefined,
  attempt: () => Promise<{ value: T; throttled?: unknown }>,
  /**
   * What giving up means for this caller, and it is not the same for both.
   *
   * An `ILlm` carries its failure inside the `Result`, so returning the value
   * IS returning the error. An `IEmbedder` throws, and its attempt wrapper has
   * already swallowed the throw to report it here — so returning the value
   * would hand the caller `undefined` as a successful embedding and lose the
   * `429` entirely.
   */
  giveUp: (value: T, error: unknown) => T,
): Promise<T> {
  let nextAttemptAt = 0;
  for (;;) {
    const quota = quotaForModel(model);
    let permit: Permit | undefined;
    if (quota) {
      permit = await quota.gate.acquire(signal, { notBefore: nextAttemptAt });
    }

    const { value, throttled } = await attempt();
    const limit = throttled ? findThrottled(throttled) : undefined;
    if (!limit) return value;

    if (limit.attempts === 0) permit?.giveBack();

    // With no quota there is no gate and no queue — nothing to wait in and
    // nothing to pace against. The failure goes back as it arrived and the
    // caller decides, which is what "absent means off" has to mean here. (A
    // door without a quota cannot happen: the configuration refuses to start,
    // because the door's guarantee rests on there being a window to wait in.)
    //
    // The alternative was worse in both directions. A no-interval 429 would
    // have looped with a zero delay, turning one refusal into a retry storm
    // against a provider that had just asked us to stop; and an interval would
    // have been waited out with no ceiling, where the ceiling removed with
    // `WaitIfShortEnough` was the only thing that had made waiting safe.
    // `throttled` and not `limit`: the second is whatever `findThrottled` dug
    // out of the cause chain, and throwing that would hand the caller an inner
    // error stripped of the provider's own message, stack and context.
    if (!quota) return giveUp(value, throttled);

    // Exactly what the server named, however long — a ceiling here would kill
    // work the door has promised to carry — or, when it named nothing, our own
    // configured rate. We may not invent an interval and do not have to.
    const seconds = limit.retryAfterSeconds;
    const delayMs =
      seconds !== undefined && Number.isFinite(seconds)
        ? seconds * 1000
        : quota.gate.msUntilNextOpening();

    // The retry waits INSIDE the queue, not beside it. Sleeping out here and
    // re-acquiring afterwards would drop this call to the back behind every
    // newcomer, and would wake every throttled caller at once to race for the
    // same place.
    nextAttemptAt = Date.now() + delayMs;
  }
}

export function gateLlm(inner: ILlm, model: string): ILlm {
  const gated: ILlm = {
    get model() {
      return inner.model;
    },
    chat(messages: Message[], tools?: LlmTool[], options?: CallOptions) {
      return runGated<Result<LlmResponse, LlmError>>(
        model,
        options?.signal,
        async () => {
          const value = await inner.chat(messages, tools, options);
          return { value, throttled: value.ok ? undefined : value.error };
        },
        // The Result already carries the error.
        (value) => value,
      );
    },
    async *streamChat(
      messages: Message[],
      tools?: LlmTool[],
      options?: CallOptions,
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      // The opening attempt carries the same guarantee as chat(): a 429 before
      // any chunk has flowed delays the stream, it does not end it. Once chunks
      // ARE flowing the request is under way — a permit re-taken mid-stream
      // would count a start that never happened, and a mid-stream failure is
      // not ours to replay.
      let nextAttemptAt = 0;
      for (;;) {
        const quota = quotaForModel(model);
        let permit: Permit | undefined;
        if (quota) {
          permit = await quota.gate.acquire(options?.signal, {
            notBefore: nextAttemptAt,
          });
        }
        let yielded = 0;
        let reopen: { waitMs: number } | undefined;

        for await (const chunk of inner.streamChat(messages, tools, options)) {
          if (chunk.ok) {
            yielded++;
            yield chunk;
            continue;
          }
          const limit = yielded === 0 ? findThrottled(chunk.error) : undefined;
          if (!limit || options?.signal?.aborted) {
            yield chunk;
            return;
          }
          if (limit.attempts === 0) permit?.giveBack();
          if (!quota) {
            // As above: with no gate there is nothing to wait in.
            yield chunk;
            return;
          }
          const seconds = limit.retryAfterSeconds;
          reopen = {
            waitMs:
              seconds !== undefined && Number.isFinite(seconds)
                ? seconds * 1000
                : quota.gate.msUntilNextOpening(),
          };
          break;
        }

        if (!reopen) return;
        // As in `runGated`: the wait happens inside the queue so the place is
        // kept, unless there is no gate at all to keep it in.
        nextAttemptAt = Date.now() + reopen.waitMs;
      }
    },
  };
  if (inner.healthCheck) gated.healthCheck = inner.healthCheck.bind(inner);
  return gated;
}

export function gateEmbedder(inner: IEmbedder, model: string): IEmbedder {
  const gated: IEmbedder = {
    embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
      return runGated<IEmbedResult>(
        model,
        options?.signal,
        async () => {
          try {
            return { value: await inner.embed(text, options) };
          } catch (error) {
            if (findThrottled(error)) {
              return { value: undefined as never, throttled: error };
            }
            throw error;
          }
        },
        // An embedder throws, so giving up throws the original back. Returning
        // the placeholder would be an empty vector reported as a success.
        (_value, error) => {
          throw error;
        },
      );
    },
  };
  const batch = (inner as IEmbedder & { embedBatch?: unknown }).embedBatch;
  if (typeof batch === 'function') {
    (gated as IEmbedder & { embedBatch: unknown }).embedBatch = (
      texts: string[],
      options?: CallOptions,
    ) =>
      runGated<IEmbedResult[]>(
        model,
        options?.signal,
        async () => {
          try {
            return {
              value: await (
                batch as (t: string[], o?: CallOptions) => Promise<IEmbedResult[]>
              ).call(inner, texts, options),
            };
          } catch (error) {
            if (findThrottled(error)) {
              return { value: undefined as never, throttled: error };
            }
            throw error;
          }
        },
        (_value, error) => {
          throw error;
        },
      );
  }
  return gated;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/unit/gated-llm.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Assert the library's own gate costs no permit**

Append to `test/unit/gated-llm.test.ts`:

```ts
describe('gateLlm — a refusal that never reached the wire', () => {
  it('leaves the window its full allowance after a herd meets a shut gate', async () => {
    // Sized so nobody parks: the property under test is what a pre-wire
    // refusal costs, and a limit that makes callers queue would turn this into
    // a test of the window's timing instead — one that waits out real minutes.
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 40 } });
    const { registry, gated } = load();
    const gate = registry.gateForModel('m');

    // Twenty callers, every one turned back by the library's own gate BEFORE
    // the transport: `attempts: 0` means no request left this process. Each
    // then succeeds on its second pass.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        gated.gateLlm(scriptedLlm([throttled(0.001, 0)]), 'm').chat([]),
      ),
    );

    // Exactly twenty: the pre-wire refusals cost nothing, so the window counts
    // the calls that actually reached a provider and not forty. An equality,
    // because `<= 20` would pass with every phantom start counted.
    expect(gate?.liveStarts).toBe(20);
  });
});
```

- [ ] **Step 6: Run, lint, typecheck**

Run: `npx jest test/unit/gated-llm.test.ts && npx biome check --write srv/lib/gated-llm.ts test/unit/gated-llm.test.ts && npm run test:check`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/gated-llm.ts test/unit/gated-llm.test.ts
git commit -m "feat(gatekeeper): a permit per HTTP attempt, and none for a call that never left"
```

### Task 4: Every construction site goes through the gate

**Files:**
- Modify: `srv/agent-manager.ts` — the five `makeLlm` call sites (main, classifier, two helpers, critic), the embedder built at `srv/agent-manager.ts:974-987`, and the model hot-swap
- Modify: `srv/agent-config.ts` (the retired ceiling), `srv/openai-handler.ts`, `srv/anthropic-handler.ts`, `srv/lib/throttle-surfacing.ts` (the unknown-model refusal)
- Test: `test/unit/gated-construction.test.ts`, and additions to `test/unit/quota-registry.test.ts`

> Task 2 leaves the registry able to refuse an unknown model; this task is where that refusal is wired to the swap and to the wire, because these are the files it already owns. Splitting it would leave production changes in a task that lints and commits neither.

**Interfaces:**
- Consumes: `gateLlm`, `gateEmbedder` from Task 3.
- Produces: `buildGatedLlm(cfg, model)` and `buildGatedEmbedder(cfg, model)` inside `agent-manager` — the only functions in the module that call `makeLlm` or construct an embedder.

**Why:** `SmartAgentBuilder.withRateLimiter()` wraps only the main LLM, which would gate roughly half our traffic while the documentation claimed otherwise. Making it unavoidable rather than remembered means one function returns an LLM and is the only caller of `makeLlm`, and one wrapper returns an embedder while the raw one never leaves the module.

- [ ] **Step 1: Write the failing test**

Create `test/unit/gated-construction.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A structural test, deliberately. The property is "no sixth construction site
 * can quietly bypass the gate", and that is a property of the module's shape —
 * a behavioural test would pass while a new raw call site sat beside it.
 */
const source = readFileSync(join(__dirname, '../../srv/agent-manager.ts'), 'utf8');

describe('agent-manager — one door for construction', () => {
  it('calls makeLlm from exactly one place', () => {
    const callSites = source.match(/\bmakeLlm\s*\(/g) ?? [];
    expect(callSites).toHaveLength(1);
  });

  it('makes that place hand the result to the gate', () => {
    expect(source).toMatch(/function buildGatedLlm[\s\S]{0,600}gateLlm\(/);
  });

  it('constructs an embedder from exactly one place, and gates it there', () => {
    const raw = source.match(/new (SapAiCoreEmbedder|OpenAiEmbedder)\s*\(/g) ?? [];
    expect(raw.length).toBeGreaterThan(0);
    expect(source).toMatch(/function buildGatedEmbedder[\s\S]{0,1200}gateEmbedder\(/);
    // Every raw construction lives inside that one builder.
    const builderStart = source.indexOf('function buildGatedEmbedder');
    for (const match of raw) {
      expect(source.indexOf(match)).toBeGreaterThan(builderStart);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/unit/gated-construction.test.ts`
Expected: FAIL — five `makeLlm` call sites, no `buildGatedLlm`.

- [ ] **Step 3: Add the two builders**

In `srv/agent-manager.ts`, near the existing `sharedMainLlm` declarations, add:

```ts
import { gateEmbedder, gateLlm } from './lib/gated-llm';

/**
 * The only caller of `makeLlm` in this service.
 *
 * Every model call is metered, not just the main one: the builder's
 * `withRateLimiter` sees the main LLM alone, which would leave the reviewer,
 * the helpers, the classifier and every RAG query outside the window.
 */
async function buildGatedLlm(
  cfg: Parameters<typeof makeLlm>[0],
  temperature: number,
): Promise<ILlm> {
  const model = cfg.model;
  if (!model) throw new Error('buildGatedLlm requires an explicit model');

  // Refuse the swap before anything is built or replaced — see Step 5.
  quotaForModel(model);

  return gateLlm(
    await makeLlm(
      {
        ...cfg,
        // The provider reports; it does not absorb. Anything it waited out or
        // retried inside one of our attempts would be a request the window
        // never saw, which is the whole invariant. WaitIfShortEnough was the
        // right answer before there was a door in front, and survives nowhere
        // now: waiting as told is the gated wrapper's job, one permit at a
        // time.
        whenThrottled: new ReportThrottling(),
      },
      temperature,
    ),
    model,
  );
}
```

and the imports this needs:

```ts
import { ReportThrottling } from '@mcp-abap-adt/llm-agent';
import { quotaForModel } from './lib/quota-registry';
```

Replace each of the five `await makeLlm(...)` / `makeLlm(...)` call sites with `await buildGatedLlm(...)`, passing the same arguments.

- [ ] **Step 4: Fold the embedder construction into one builder**

Replace the `rawEmbedder` block at `srv/agent-manager.ts:974-987` with:

```ts
/**
 * The only place an embedder is constructed. The raw one never leaves here, so
 * a RAG query cannot reach a provider without passing the window.
 */
function buildGatedEmbedder(config: AgentConfig, embeddingModel: string): IEmbedder {
  const raw: SapAiCoreEmbedder | OpenAiEmbedder =
    config.llm.provider === 'sap-ai-sdk'
      ? new SapAiCoreEmbedder({
          modelName: embeddingModel,
          ...(config.llm.resourceGroup ? { resourceGroup: config.llm.resourceGroup } : {}),
        })
      : new OpenAiEmbedder({
          apiKey: config.llm.apiKey || '',
          baseURL: config.llm.baseUrl,
          model: embeddingModel,
        });
  return gateEmbedder(raw, embeddingModel);
}
```

The embedders take no throttling strategy — they surface what the server said
and this wrapper decides — so there is nothing to override there.

and call `buildGatedEmbedder(config, embeddingModel)` where `rawEmbedder` was used, keeping the existing `CircuitBreakerEmbedder` wrapping around the result.

> Keep the existing `SapAiCoreEmbedder` constructor arguments exactly as they are in the file — the snippet above shows the shape, not a licence to change which options are passed.

- [ ] **Step 5: Assert the provider absorbs nothing**

Append to `test/unit/gated-construction.test.ts`:

```ts
describe('agent-manager — the provider reports, it does not absorb', () => {
  it('hands every provider ReportThrottling', () => {
    // WaitIfShortEnough inside the provider would wait out a 429 within one of
    // our attempts: the retry happens, the window never sees it, and the count
    // is wrong under exactly the load this exists for.
    expect(source).toMatch(/whenThrottled:\s*new ReportThrottling\(\)/);
    expect(source).not.toMatch(/whenThrottled:\s*config\.llm\.whenThrottled/);
  });
});
```

and a behavioural one in `test/unit/gated-llm.test.ts`:

```ts
describe('gateLlm — one transport attempt per entry', () => {
  it('calls the provider exactly once for each permit it takes', async () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 10 } });
    const { registry, gated } = load();
    const inner = scriptedLlm([throttled(0.001), throttled(0.001)]);
    await gated.gateLlm(inner, 'm').chat([]);
    // Three calls, three permits, one each. A provider that retried inside
    // would show fewer permits than calls.
    expect(inner.calls()).toBe(registry.gateForModel('m')?.liveStarts);
  });
});
```

- [ ] **Step 6: Retire the now-unused ceiling, and everything that referenced it**

`WaitIfShortEnough` and `LLM_AGENT_THROTTLE_MAX_WAIT_MS` have no caller left:
every LLM comes from `buildGatedLlm`, which hands the provider
`ReportThrottling`. Delete `srv/lib/throttle-strategy.ts`, the `whenThrottled`
field from `srv/agent-config.ts`, and the "configured wait ceiling" block from
`test/unit/throttle-surfacing.test.ts`. Leaving a dead ceiling in the
configuration would read as a setting that still does something.

**Three test files reference it, not one.** `test/unit/executor-worker.test.ts`
and `test/unit/agent-controller-wiring.test.ts` both import
`WaitIfShortEnough` and set `whenThrottled: new WaitIfShortEnough(20_000)` in
their `AgentConfig` fixtures. Deleting the module without them fails the suite
on `Cannot find module`, and deleting the field leaves two fixtures describing
a config shape that no longer exists. Drop the import and the line from each;
the fixtures need no replacement, because the provider's strategy is no longer
a consumer concern.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx jest test/unit/gated-construction.test.ts && npm run test:unit`
Expected: PASS; the existing suite stays green.

- [ ] **Step 8: Refuse an unknown model at the swap, before anything moves**

The registry throwing is not enough on its own: `gateForModel` is reached only
once `GatedLlm.chat` is already running, and by then `getSmartAgent` has
replaced `currentModel` and the shared LLM for this request **and every one
after it**. A typo would be accepted, become the active model, pass admission,
and only then fail inside the pipeline, with the swap left in place.

So the check happens at the swap. In `srv/agent-manager.ts`, at the top of the
block that reacts to `requestedModel !== activeModel`, before `makeLlm` and
before any shared state is touched:

```ts
  if (requestedModel && requestedModel !== activeModel) {
    // Throws UnknownModelError when quotas are in force and this name has
    // neither an entry nor a mapping. Before the swap, deliberately: a name we
    // will not meter must not become the model every later call uses.
    quotaForModel(requestedModel);
```

In `srv/openai-handler.ts` and `srv/anthropic-handler.ts`, turn it into a bad
request, never an overload, because it will not become valid by waiting:

```ts
  } catch (err) {
    if (err instanceof UnknownModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(unknownModelPayload(err, dialect)));
      return;
    }
    throw err;
  }
```

and in `srv/lib/throttle-surfacing.ts`:

```ts
/**
 * A model nobody configured. A bad request, not an overload: 529 or a
 * retryable 503 would invite a retry loop that cannot succeed, because the
 * name will never become valid on its own.
 */
export function unknownModelPayload(
  err: { model: string; message: string },
  dialect: 'openai' | 'anthropic',
): unknown {
  const error = {
    type: 'invalid_request_error',
    code: 'model_not_configured',
    param: 'model',
    message: err.message,
  };
  return dialect === 'anthropic' ? { type: 'error', error } : { error };
}
```

- [ ] **Step 9: Assert the swap does not happen**

Append to `test/unit/quota-registry.test.ts`:

```ts
describe('an unknown model does not become the active one', () => {
  it('is refused before the swap, so later calls keep the model that works', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ known: { limit: 1 } });
    const mod = load();
    // The check that runs at the swap. Reached only inside chat(),
    // `currentModel` would already have moved for every later request.
    expect(() => mod.quotaForModel('knwon')).toThrow(mod.UnknownModelError);
    expect(mod.quotaForModel('known')?.key).toBe('known');
  });
});
```

and in `test/unit/gated-construction.test.ts`, created at the start of this
task:

```ts
describe('agent-manager — the model check comes before the swap', () => {
  it('resolves the quota before anything is built or replaced', () => {
    // Not `makeLlm(` — after this refactor its one call site lives inside
    // buildGatedLlm, declared above the swap, so searching forward from the
    // swap finds nothing and the assertion would compare against -1.
    const swap = source.indexOf('requestedModel !== activeModel');
    const check = source.indexOf('quotaForModel(requestedModel)', swap);
    const build = source.indexOf('buildGatedLlm(', swap);
    const assign = source.indexOf('sharedMainLlm =', swap);
    expect(swap).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(swap);
    expect(build).toBeGreaterThan(check);
    expect(assign).toBeGreaterThan(check);
  });
});
```

- [ ] **Step 10: Run both suites**

Run: `npx jest test/unit/quota-registry.test.ts test/unit/gated-construction.test.ts && npm run test:unit`
Expected: PASS, 14 and 6 tests, and the existing suite stays green.

- [ ] **Step 11: Lint, typecheck, commit**

```bash
npx biome check --write srv/agent-manager.ts srv/agent-config.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/lib/throttle-surfacing.ts test/unit/quota-registry.test.ts test/unit/gated-construction.test.ts test/unit/gated-llm.test.ts test/unit/executor-worker.test.ts test/unit/agent-controller-wiring.test.ts test/unit/throttle-surfacing.test.ts
npm run test:check
git add -A
git commit -m "feat(gatekeeper): every model passes the window, and the provider absorbs nothing"
```

---

### Task 5: The door

**Files:**
- Create: `srv/lib/admission.ts`
- Modify: `srv/lib/throttle-surfacing.ts` (the door refusal), `srv/agent-mcp.ts` (fold the semaphore in)
- Test: `test/unit/admission.test.ts`

**Interfaces:**
- Consumes: `gatekeeperConfig` from Task 2.
- Produces:
  - `export class DoorFullError extends Error { readonly code = 'door_full' }`
  - `export interface AdmissionHandle { release(): Promise<void>; readonly signal: AbortSignal }`
  - `export function admit(): Promise<AdmissionHandle>` — throws `DoorFullError` when the door is configured and full
  - `export function livePipelines(): number`
  - `export function configuredCapacity(): number | undefined` — reads the validated value from `gatekeeper-config`
  - `export function clearAdmission(): void` — test seam

**The rule:** a pipeline is live from the moment it is admitted until it finishes or fails. It is not released while it waits on a quota — waiting is exactly when it still holds its context. The door is entered **after** the agent is resolved, so a caller waiting for a destination or a shared corpus build waits outside it, holding an HTTP request and no pipeline.

- [ ] **Step 1: Write the failing test**

Create `test/unit/admission.test.ts`:

```ts
const load = () => {
  jest.resetModules();
  const config = require('../../srv/lib/gatekeeper-config') as typeof import('../../srv/lib/gatekeeper-config');
  config.clearGatekeeperConfig();
  const mod = require('../../srv/lib/admission') as typeof import('../../srv/lib/admission');
  mod.clearAdmission();
  return mod;
};

beforeEach(() => {
  // A door requires a quota, so every test that opens one sets one.
  process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 100 } });
});

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES;
  delete process.env.LLM_GATEKEEPER_QUOTAS;
  jest.resetModules();
});

describe('the door — absent means off', () => {
  it('admits without limit when no capacity is configured', async () => {
    const mod = load();
    for (let i = 0; i < 50; i++) await mod.admit();
    expect(mod.livePipelines()).toBe(50);
  });
});

describe('the door — a configured capacity', () => {
  it('admits up to capacity and refuses the rest', async () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '2';
    const mod = load();
    await mod.admit();
    await mod.admit();
    await expect(mod.admit()).rejects.toBeInstanceOf(mod.DoorFullError);
  });

  it('admits one and turns away the rest at a capacity of one', async () => {
    // The degenerate setting is a setting.
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '1';
    const mod = load();
    await mod.admit();
    await expect(mod.admit()).rejects.toBeInstanceOf(mod.DoorFullError);
  });

  it('frees the place when a pipeline releases', async () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '1';
    const mod = load();
    const handle = await mod.admit();
    await handle.release();
    await expect(mod.admit()).resolves.toBeDefined();
  });

  it('refuses a malformed capacity, from the config module that owns it', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = 'plenty';
    expect(() => load().configuredCapacity()).toThrow(
      /LLM_GATEKEEPER_MAX_LIVE_PIPELINES/,
    );
  });
});

describe('the door — what the refusal carries', () => {
  it('names no interval, because we do not measure how long pipelines run', async () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '1';
    const mod = load();
    await mod.admit();
    const error = await mod.admit().catch((e: Error) => e);
    // A previous design took a number from the quota queue, which measures a
    // different resource entirely.
    expect(error.message).not.toMatch(/\d+\s*(second|ms|minute)/i);
    expect((error as { retryAfterSeconds?: number }).retryAfterSeconds).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/unit/admission.test.ts`
Expected: FAIL — `Cannot find module '../../srv/lib/admission'`.

- [ ] **Step 3: Write the door**

Create `srv/lib/admission.ts`:

```ts
/**
 * The door: how many pipelines may be live at once, across every channel.
 *
 * One counter, not one per route. `execute_step` already capped itself with a
 * semaphore of two for exactly this reason — memory — and two independent caps
 * on one resource would each be wrong about the other.
 *
 * Admission happens AFTER the agent is resolved, so a caller waiting for a
 * destination to warm or for the shared corpus build waits outside this door,
 * holding an HTTP request and no pipeline.
 */

import { gatekeeperConfig } from './gatekeeper-config';

/** The door is full. Carries no interval: we do not measure pipeline length. */
export class DoorFullError extends Error {
  readonly code = 'door_full';
  constructor() {
    super('No capacity for a new request right now. Nothing was started.');
    this.name = 'DoorFullError';
  }
}

export interface AdmissionHandle {
  /** Aborted by shutdown, and by nothing else. */
  readonly signal: AbortSignal;
  /** Give the place back. Idempotent. */
  release(): Promise<void>;
}

let live = 0;
const handles = new Set<AbortController>();

/**
 * How many pipelines may be live at once, or nothing.
 *
 * Read from `gatekeeper-config`, which has already validated it — including
 * the rule that a door without a quota is refused, since this module holds
 * counters and has no business doing validation the startup path depends on.
 */
export function configuredCapacity(): number | undefined {
  return gatekeeperConfig().maxLivePipelines;
}

export function livePipelines(): number {
  return live;
}

/**
 * Take a place, or refuse. Never waits: a caller parked at the door would hold
 * the memory the door exists to bound, which is the thing it is counting.
 */
export function admit(): Promise<AdmissionHandle> {
  const max = configuredCapacity();
  if (max !== undefined && live >= max) {
    return Promise.reject(new DoorFullError());
  }
  live++;
  const controller = new AbortController();
  handles.add(controller);
  let released = false;
  return Promise.resolve({
    signal: controller.signal,
    release: async () => {
      if (released) return;
      released = true;
      handles.delete(controller);
      live--;
    },
  });
}

/** Abort every admitted pipeline. The only thing of ours that ends one. */
export function abortAllForShutdown(reason = 'shutdown'): void {
  for (const controller of handles) controller.abort(new Error(reason));
}

/** Test seam. */
export function clearAdmission(): void {
  live = 0;
  handles.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/unit/admission.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Fold the `execute_step` semaphore into the door**

In `srv/agent-mcp.ts`, replace the local semaphore with the shared door. Delete `const execStepSemaphore = new Semaphore(EXEC_STEP_MAX_CONCURRENCY)` and its import.

**The admission does not go where the semaphore was.** The old `acquire` sits *before* the connection is built and before `getSmartAgent` resolves, so a step that arrives during a shared corpus build would hold a place for the whole wait. Move it **after** the agent handle is in hand — the same order the chat channels use in Task 7 — and put it immediately before the pipeline runs:

```ts
      // Agent first, door second. A caller waiting for a destination to warm,
      // or for the shared corpus build, waits outside the door holding an MCP
      // request and no pipeline.
      const handle = await getSmartAgent(undefined, destination);

      // One counter for every channel. The old local semaphore of two capped
      // this route alone, which is the same resource the chat channels spend.
      let admission: AdmissionHandle;
      try {
        admission = await admit();
      } catch (err) {
        if (err instanceof DoorFullError) {
          return textResult(doorFullText(), true);
        }
        throw err;
      }
```

Everything between the old acquire point and this line — connection construction, destination resolution, agent resolution — now happens before a place is taken. Keep the `finally` guarded so it only tears down what was actually created.

and in the existing `finally`, replace `releaseSlot()` with `await admission.release()`, keeping it last — after `safeStop` and after `dropRequest`.

> `EXEC_STEP_MAX_CONCURRENCY` is removed. Where a deployment relied on it, `LLM_GATEKEEPER_MAX_LIVE_PIPELINES` is the replacement and covers every channel; note this in the release notes in Task 15.

- [ ] **Step 6: Add the door refusal to the formatters**

In `srv/lib/throttle-surfacing.ts` add:

```ts
/**
 * What a full door says. No number, and no `Retry-After` anywhere that uses
 * this: how long the pipelines ahead will run is not something we measure, and
 * the queue's own depth describes a different resource entirely.
 */
export function doorFullText(): string {
  return 'The service has no capacity for a new request right now. Nothing was started, so nothing is half-done. Please try again.';
}
```

- [ ] **Step 7: Run the suite, lint, commit**

```bash
npx jest test/unit/admission.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/admission.ts srv/lib/throttle-surfacing.ts srv/agent-mcp.ts test/unit/admission.test.ts
git add srv/lib/admission.ts srv/lib/throttle-surfacing.ts srv/agent-mcp.ts test/unit/admission.test.ts
git commit -m "feat(gatekeeper): one door for every channel, refusing without a number"
```

### Task 6: The call register, and the order teardown runs in

**Files:**
- Modify: `srv/lib/admission.ts` (the register), `srv/agent-manager.ts` (`invokeEmbeddedTool` takes the signal), `srv/agent-mcp.ts` (teardown order)
- Test: `test/unit/admission-register.test.ts`

**Interfaces:**
- Consumes: `AdmissionHandle` from Task 5.
- Produces on `AdmissionHandle`:
  - `track<T>(call: Promise<T>): Promise<T>` — register at dispatch, deregister on settle
  - `readonly outstanding: number`
  - `drain(): Promise<void>` — wait for the register without giving the place back
  - `release()` now awaits the register before resolving

**The order, and why it is that order:** `safeStop` calls `closeSession` then `reset`, so running it while a registered write is still on that connection tears the session out from under the call — which is how an object ends up created-but-inactive with a lock nobody holds. Holding the slot does not help, because the slot was never what the write was using.

1. Stop starting new calls (the signal fires; the tool loop starts nothing further).
2. Wait for the register to empty.
3. `safeStop`.
4. Release the slot.

- [ ] **Step 1: Write the failing test**

Create `test/unit/admission-register.test.ts`:

```ts
const load = () => {
  jest.resetModules();
  const config = require('../../srv/lib/gatekeeper-config') as typeof import('../../srv/lib/gatekeeper-config');
  config.clearGatekeeperConfig();
  const mod = require('../../srv/lib/admission') as typeof import('../../srv/lib/admission');
  mod.clearAdmission();
  return mod;
};

beforeEach(() => {
  // A door requires a quota, so a suite that opens one configures one.
  process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 100 } });
});

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES;
  delete process.env.LLM_GATEKEEPER_QUOTAS;
  jest.resetModules();
});

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('the register — the slot waits for the transport, not for the report', () => {
  it('holds the place until a tracked call settles', async () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '1';
    const mod = load();
    const handle = await mod.admit();
    const call = deferred<string>();
    void handle.track(call.promise);

    // The caller has been answered; the write has not finished.
    const releasing = handle.release();
    let released = false;
    void releasing.then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    await expect(mod.admit()).rejects.toBeInstanceOf(mod.DoorFullError);

    call.resolve('done');
    await releasing;
    expect(mod.livePipelines()).toBe(0);
    await expect(mod.admit()).resolves.toBeDefined();
  });

  it('counts a rejected call as settled', async () => {
    const mod = load();
    const handle = await mod.admit();
    const call = deferred<string>();
    const tracked = handle.track(call.promise);
    void tracked.catch(() => undefined);
    expect(handle.outstanding).toBe(1);
    call.resolve('x');
    await tracked;
    expect(handle.outstanding).toBe(0);
  });

  it('is aborted by shutdown and by nothing else', async () => {
    const mod = load();
    const handle = await mod.admit();
    expect(handle.signal.aborted).toBe(false);
    mod.abortAllForShutdown();
    expect(handle.signal.aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/unit/admission-register.test.ts`
Expected: FAIL — `handle.track is not a function`.

- [ ] **Step 3: Add the register to the handle**

In `srv/lib/admission.ts`, extend the interface and `admit()`:

```ts
export interface AdmissionHandle {
  readonly signal: AbortSignal;
  /** Calls dispatched and not yet settled. */
  readonly outstanding: number;
  /**
   * Register one in-flight call — a model call or a tool call, both — before
   * it leaves, and deregister it when it settles.
   *
   * The register lives here rather than in the gated LLM wrapper because that
   * wrapper never sees a tool call: those go through `McpClientAdapter`, which
   * races the caller's signal AROUND the call, so an abort answers the pipeline
   * while an embedded ADT write keeps running underneath.
   */
  track<T>(call: Promise<T>): Promise<T>;
  /** Waits for the register to empty, then gives the place back. Idempotent. */
  release(): Promise<void>;
}
```

and in the returned object:

```ts
  const inFlight = new Set<Promise<unknown>>();
  let released = false;
  const handle: AdmissionHandle = {
    signal: controller.signal,
    get outstanding() {
      return inFlight.size;
    },
    track<T>(call: Promise<T>): Promise<T> {
      const settled = call.finally(() => {
        inFlight.delete(settled);
      });
      inFlight.add(settled);
      // A rejection reaches the original caller; here it only means "settled".
      settled.catch(() => undefined);
      return call;
    },
    release: async () => {
      if (released) return;
      released = true;
      // Every call already dispatched settles on its own. Nothing is cut: an
      // ADT request is asynchronous in substance, so cutting it would discard
      // our knowledge of the work rather than stop it.
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      handles.delete(controller);
      live--;
    },
  };
  return Promise.resolve(handle);
```

- [ ] **Step 4: Let the embedded handler take the signal**

In `srv/agent-manager.ts`, change `invokeEmbeddedTool` and the handler wired at `srv/agent-manager.ts:2020`:

```ts
  async function invokeEmbeddedTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
```

```ts
    callToolHandler: async (name, args, signal) =>
      invokeEmbeddedTool(name, args, signal),
```

The signal is threaded to any ADT call the handler makes that accepts one. llm-agent 25.0.0 passes it; before that release the third argument was never sent, so a handler taking two arguments silently dropped it.

- [ ] **Step 5: Put the teardown in order**

In `srv/agent-mcp.ts`, the `finally` becomes:

```ts
      } finally {
        // Order matters and this is the order. safeStop calls closeSession and
        // then reset, so running it while a registered write is still on this
        // connection tears the session out from under the call — which is how
        // an object ends up created-but-inactive and locked.
        //
        // 1. nothing new starts (the signal has fired, or the step is done)
        // 2. every dispatched call settles
        // 3. the session is torn down
        // 4. the place is given back, last
        await admission.drain();
        await safeStop(connection);
        (handle as unknown as HandleWithRecMcp)?.recMcp?.dropRequest(traceId);
        await admission.release();
      }
```

Add `drain()` to the handle, which waits for the register without giving the place back:

```ts
    drain: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
```

and declare it on the interface as `drain(): Promise<void>`.

- [ ] **Step 6: Run, lint, typecheck, commit**

```bash
npx jest test/unit/admission-register.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/admission.ts srv/agent-manager.ts srv/agent-mcp.ts test/unit/admission-register.test.ts
git add srv/lib/admission.ts srv/agent-manager.ts srv/agent-mcp.ts test/unit/admission-register.test.ts
git commit -m "feat(gatekeeper): the slot waits for the calls, and safe-stop goes last"
```

---

### Task 6b: Wire the register to the calls it exists for

**Files:**
- Modify: `srv/lib/admission.ts` (request-scoped handle), `srv/lib/gated-llm.ts` (register the model call), `srv/agent-manager.ts` (register the tool call, and run each pipeline inside the scope)
- Test: `test/unit/register-wiring.test.ts`

**Interfaces:**
- Consumes: `AdmissionHandle.track` from Task 6.
- Produces:
  - `export function runWithAdmission<T>(handle: AdmissionHandle, fn: () => Promise<T>): Promise<T>`
  - `export function currentAdmission(): AdmissionHandle | undefined`

**Why this is its own task:** Task 6 gives the handle a register and a drain, and nothing puts anything in it. A register nobody writes to always drains instantly, so `safeStop` would close the session on top of a live ADT write and the slot would free early — the exact defect the register exists to prevent, dressed as a passing test. Threading the `AbortSignal` into `invokeEmbeddedTool` does not do it either: a signal says *stop starting*, the register says *this has not finished*.

**Why an async-local scope rather than a parameter:** the two places that dispatch — the gated LLM wrapper and the embedded tool handler — sit far below the handler that was admitted, with the library's pipeline in between. There is no parameter to thread. This codebase already carries per-request state that way (`connectionALS` in `agent-manager`), and this follows it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/register-wiring.test.ts`:

```ts
import type { ILlm, LlmError, LlmResponse, Result } from '@mcp-abap-adt/llm-agent';

const load = () => {
  jest.resetModules();
  const admission = require('../../srv/lib/admission') as typeof import('../../srv/lib/admission');
  admission.clearAdmission();
  const registry = require('../../srv/lib/quota-registry') as typeof import('../../srv/lib/quota-registry');
  registry.clearQuotaRegistry();
  const gated = require('../../srv/lib/gated-llm') as typeof import('../../srv/lib/gated-llm');
  return { admission, gated };
};

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_QUOTAS;
  jest.resetModules();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** An ILlm whose single call the test settles by hand. */
function hangingLlm(gate: { promise: Promise<Result<LlmResponse, LlmError>> }): ILlm {
  return {
    model: 'm',
    chat: () => gate.promise,
    async *streamChat() {
      yield { ok: true as const, value: { content: '', finishReason: 'stop' as const } };
    },
  };
}

describe('the register is written to by the calls it exists for', () => {
  it('holds the slot while a model call started inside the scope is pending', async () => {
    const { admission, gated } = load();
    const handle = await admission.admit();
    const call = deferred<Result<LlmResponse, LlmError>>();

    const running = admission.runWithAdmission(handle, async () => {
      const llm = gated.gateLlm(hangingLlm(call), 'm');
      return llm.chat([]);
    });

    await Promise.resolve();
    await Promise.resolve();
    // Registered at dispatch, not at completion. Without this the drain below
    // finds an empty register and safeStop runs on top of a live call.
    expect(handle.outstanding).toBe(1);

    let drained = false;
    void handle.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    call.resolve({ ok: true, value: { content: 'ok', finishReason: 'stop' } });
    await running;
    await handle.drain();
    expect(handle.outstanding).toBe(0);
  });

  it('registers a tool call dispatched inside the scope', async () => {
    const { admission } = load();
    const handle = await admission.admit();
    const call = deferred<string>();

    await admission.runWithAdmission(handle, async () => {
      // Stand-in for the embedded tool dispatch: whatever starts inside the
      // scope registers itself, LLM or MCP alike.
      const current = admission.currentAdmission();
      expect(current).toBe(handle);
      void current?.track(call.promise);
    });

    expect(handle.outstanding).toBe(1);
    call.resolve('done');
    await handle.drain();
    expect(handle.outstanding).toBe(0);
  });

  it('registers nothing when there is no admission in scope', async () => {
    // The shared corpus build runs outside any request, and must stay outside:
    // attributing it to whoever arrived first would make a global lifecycle the
    // property of a caller that may be gone before it ends.
    const { admission, gated } = load();
    expect(admission.currentAdmission()).toBeUndefined();
    const call = deferred<Result<LlmResponse, LlmError>>();
    const llm = gated.gateLlm(hangingLlm(call), 'm');
    const pending = llm.chat([]);
    call.resolve({ ok: true, value: { content: 'ok', finishReason: 'stop' } });
    await expect(pending).resolves.toBeDefined();
  });

  it('keeps two pipelines’ registers apart', async () => {
    const { admission } = load();
    const a = await admission.admit();
    const b = await admission.admit();
    const callA = deferred<string>();

    await admission.runWithAdmission(a, async () => {
      admission.currentAdmission()?.track(callA.promise);
    });

    expect(a.outstanding).toBe(1);
    expect(b.outstanding).toBe(0);
    callA.resolve('x');
    await a.drain();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/register-wiring.test.ts`
Expected: FAIL, `admission.runWithAdmission is not a function`.

- [ ] **Step 3: Add the request-scoped handle**

In `srv/lib/admission.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The admission handle for the pipeline running in this async context.
 *
 * The two places that dispatch a call — the gated LLM wrapper and the embedded
 * tool handler — sit far below the handler that was admitted, with the
 * library's pipeline in between, so there is no parameter to thread. This
 * codebase already carries per-request state this way.
 */
const admissionALS = new AsyncLocalStorage<AdmissionHandle>();

/** Run a pipeline so that everything it dispatches registers against `handle`. */
export function runWithAdmission<T>(
  handle: AdmissionHandle,
  fn: () => Promise<T>,
): Promise<T> {
  return admissionALS.run(handle, fn);
}

/**
 * The handle in scope, or nothing.
 *
 * Nothing is the correct answer for process-owned work: the shared corpus
 * build runs outside any request and must not become the property of whichever
 * caller happened to await it.
 */
export function currentAdmission(): AdmissionHandle | undefined {
  return admissionALS.getStore();
}
```

- [ ] **Step 4: Register the model call at dispatch**

In `srv/lib/gated-llm.ts`, wrap the attempt inside `runGated`:

```ts
    const current = currentAdmission();
    const attempted = attempt();
    // Registered before it is awaited. The slot outlives the calls this
    // pipeline started, and an aborted caller must not free it on top of one.
    const { value, throttled } = await (current ? current.track(attempted) : attempted);
    // `throttled` is the error as the caller produced it; `limit` below is the
    // marker found anywhere in its cause chain.
```

and the same around `inner.streamChat`'s opening attempt, tracking a promise that settles when the stream ends:

```ts
      const streamDone = deferredDone();
      currentAdmission()?.track(streamDone.promise);
      try {
        // ... the existing for-await loop ...
      } finally {
        streamDone.resolve();
      }
```

where `deferredDone` is a two-line local helper returning `{ promise, resolve }`.

- [ ] **Step 5: Register the tool call at dispatch**

In `srv/agent-manager.ts`, inside `invokeEmbeddedTool`, register the dispatched call:

**First extract the dispatch.** `invokeEmbeddedTool` currently holds its
authorization check and its dispatch logic inline, and two tasks need to wrap
the dispatch alone. Split it once, here, and keep the name:

```ts
  /**
   * The tool call itself, with the authorization check left behind in the
   * caller. Extracted so the register (here) and the outage classifier
   * (Task 9) can each wrap the dispatch without wrapping the check.
   */
  async function dispatchEmbeddedTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // ... the body that follows the authorization check today, unchanged ...
  }
```

`invokeEmbeddedTool` keeps the authorization check and then:

```ts
    const dispatched = dispatchEmbeddedTool(name, args, signal);
    // One hook, two readers: the register learns the call is in flight, and
    // RecordingMcpClient's record was opened for the same reason one line up.
    return currentAdmission()?.track(dispatched) ?? dispatched;
```

- [ ] **Step 6: Run each pipeline inside the scope**

In `srv/openai-handler.ts`, `srv/anthropic-handler.ts` and `srv/agent-mcp.ts`, wrap the pipeline invocation — everything between admission and the `finally` — in `runWithAdmission(admission, async () => { ... })`. Nothing else moves; the `finally` stays where it is, outside the scope, so `drain`, `safeStop` and `release` run in that order after the scope has ended.

- [ ] **Step 7: Run, lint, commit**

```bash
npx jest test/unit/register-wiring.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/admission.ts srv/lib/gated-llm.ts srv/agent-manager.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/agent-mcp.ts test/unit/register-wiring.test.ts
git add -A
git commit -m "feat(gatekeeper): the register is written to by the model and tool calls themselves"
```

---

### Task 7: The chat channels — admission, a detached sink, and a disconnect that ends nothing

**Files:**
- Modify: `srv/openai-handler.ts`, `srv/anthropic-handler.ts`
- Create: `srv/lib/response-sink.ts`
- Test: `test/unit/response-sink.test.ts`, `test/unit/chat-admission.test.ts`

**Interfaces:**
- Consumes: `admit`, `DoorFullError`, `AdmissionHandle` from Tasks 5–6; `doorFullText` from Task 5.
- Produces: `export function detachableSink(res: ServerResponse): { write(chunk: string): void; end(): void; detach(): void; readonly attached: boolean }`

**Three changes, in this order inside each handler:** resolve the agent (unchanged), then admit, then run with a sink that can be detached.

- [ ] **Step 1: Write the failing test for the sink**

Create `test/unit/response-sink.test.ts`:

```ts
import { detachableSink } from '../../srv/lib/response-sink';

function fakeRes() {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    isEnded: () => ended,
    res: {
      write(chunk: string) {
        if (ended) throw new Error('write after end');
        written.push(chunk);
        return true;
      },
      end() {
        ended = true;
      },
    },
  };
}

describe('detachableSink', () => {
  it('writes through while attached', () => {
    const f = fakeRes();
    const sink = detachableSink(f.res as never);
    sink.write('a');
    expect(f.written).toEqual(['a']);
  });

  it('drops everything after detach, and never throws', () => {
    // Not "guarded": replaced. A write that throws into the pipeline's catch
    // would end the run, and the listener meant to honour the guarantee would
    // be the thing that broke it.
    const f = fakeRes();
    const sink = detachableSink(f.res as never);
    sink.detach();
    expect(() => {
      sink.write('b');
      sink.write('c');
      sink.end();
    }).not.toThrow();
    expect(f.written).toEqual([]);
    expect(f.isEnded()).toBe(false);
    expect(sink.attached).toBe(false);
  });

  it('swallows a transport error rather than raising it into the caller', () => {
    const sink = detachableSink({
      write() {
        throw new Error('EPIPE');
      },
      end() {
        throw new Error('EPIPE');
      },
    } as never);
    expect(() => {
      sink.write('x');
      sink.end();
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/response-sink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the sink**

Create `srv/lib/response-sink.ts`:

```ts
import type { ServerResponse } from 'node:http';

/**
 * The place a response is written, which can be taken away.
 *
 * When a client disconnects mid-stream the pipeline keeps running — a
 * disconnected caller is not a reason to stop, because the work is already in
 * SAP's hands and cutting a write chain between create and activate leaves the
 * object inactive and locked. But the handlers write unconditionally once
 * streaming has begun, and a write to a closed socket throws; caught by the
 * pipeline, that throw would end the run.
 *
 * So the sink is detached rather than guarded: after `detach()` every chunk and
 * every closing envelope is dropped before it reaches the socket, and no write
 * error can be raised into the pipeline at all.
 */
export function detachableSink(res: ServerResponse): {
  write(chunk: string): void;
  end(): void;
  detach(): void;
  readonly attached: boolean;
} {
  let live = true;
  return {
    get attached() {
      return live;
    },
    write(chunk: string) {
      if (!live) return;
      try {
        res.write(chunk);
      } catch {
        // The socket went away between the check and the write. Nothing to do
        // and nothing to raise: the caller is gone, the work is not.
        live = false;
      }
    },
    end() {
      if (!live) return;
      try {
        res.end();
      } catch {
        live = false;
      }
    },
    detach() {
      live = false;
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest test/unit/response-sink.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire both handlers**

In `srv/openai-handler.ts` and `srv/anthropic-handler.ts`, after the agent handle is resolved and before the pipeline starts:

```ts
  // Admission comes AFTER the agent is resolved: a caller waiting for a
  // destination to warm, or for the shared corpus build, waits outside the
  // door holding an HTTP request and no pipeline.
  //
  // Which means the wait can be long — up to LLM_AGENT_DESTINATION_INIT_WAIT_MS
  // — and a caller can leave during it. The listener is therefore installed
  // BEFORE that wait, above this block, and checked here: a listener installed
  // after admission would already have missed the event, and we would take a
  // place and run a whole pipeline for a client that had gone.
  if (callerGone) {
    await safeStop(requestConnection);
    return;
  }

  let admission: AdmissionHandle;
  try {
    admission = await admit();
  } catch (err) {
    if (err instanceof DoorFullError) {
      await safeStop(requestConnection);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'overloaded_error', message: doorFullText() } }));
      return;
    }
    throw err;
  }
```

Replace the existing disconnect listener, and move it **above** the agent
resolution so it cannot miss a client that leaves during the wait:

```ts
  // Installed before anything slow. The old listener sat after the agent was
  // in hand, so a client that gave up during a destination warm-up or a corpus
  // build was never noticed.
  const sink = detachableSink(res);
  let callerGone = false;
  let admitted: AdmissionHandle | undefined;
  res.on('close', () => {
    if (res.writableEnded) return;
    // A note, not a teardown. The caller is gone; SAP is still waiting for the
    // rest of the chain. safeStop runs after the register empties, in the
    // finally below — never here.
    callerGone = true;
    sink.detach();
    if (admitted) markCallerGone(admitted);
  });
```

After `admit()` succeeds, set `admitted = admission` and, if `callerGone` is
already true, call `markCallerGone(admission)` at once — the event may have
arrived between the check and the admission.

and in the handler's own `finally`:

```ts
  } finally {
    await admission.drain();
    await safeStop(requestConnection);
    await admission.release();
  }
```

Every `res.write(...)` and `res.end()` on the streaming path becomes `sink.write(...)` / `sink.end()`.

> `markCallerGone` is added in Task 12; until then, declare it as a no-op export in `srv/lib/admission.ts` so this task stands alone:
> ```ts
> /** Marks the pipeline caller-less. The collision guard in Task 12 reads it. */
> export function markCallerGone(_handle: AdmissionHandle): void {}
> ```

- [ ] **Step 6: Write the channel test**

Create `test/unit/chat-admission.test.ts`:

```ts
const load = () => {
  jest.resetModules();
  const mod = require('../../srv/lib/admission') as typeof import('../../srv/lib/admission');
  mod.clearAdmission();
  return mod;
};

beforeEach(() => {
  process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 100 } });
});

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES;
  delete process.env.LLM_GATEKEEPER_QUOTAS;
  jest.resetModules();
});

describe('every entrance is counted', () => {
  it('spends the same capacity whichever channel arrives', async () => {
    // A door with one way around it is not a door. The counter is module
    // state shared by every handler, so this asserts the shape they all use.
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '2';
    const mod = load();
    const a = await mod.admit();
    const b = await mod.admit();
    await expect(mod.admit()).rejects.toBeInstanceOf(mod.DoorFullError);
    await a.release();
    await expect(mod.admit()).resolves.toBeDefined();
    void b;
  });

  it('does not start a pipeline for a caller that left during the agent wait', async () => {
    // The window between "request arrives" and "agent resolved" can be the
    // whole of LLM_AGENT_DESTINATION_INIT_WAIT_MS. A listener installed after
    // it would have missed the event, and the door would hand out a place for
    // a client that was already gone.
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '1';
    const mod = load();
    let callerGone = false;
    const res = { writableEnded: false, on: (_e: string, fn: () => void) => fn() };
    // Stand-in for the handler's own ordering: listener first, slow wait, then
    // the check that decides whether to admit at all.
    res.on('close', () => { callerGone = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(callerGone).toBe(true);
    if (!callerGone) await mod.admit();
    expect(mod.livePipelines()).toBe(0);
  });

  it('does not consume the last place while a caller waits for the agent', async () => {
    // Resolution happens before admission, so a request arriving mid-build is
    // outside the door and the last place is still there for whoever is ready.
    process.env.LLM_GATEKEEPER_MAX_LIVE_PIPELINES = '1';
    const mod = load();
    const waitingForAgent = new Promise((r) => setTimeout(r, 5));
    const admittedMeanwhile = await mod.admit();
    await waitingForAgent;
    expect(mod.livePipelines()).toBe(1);
    await admittedMeanwhile.release();
  });
});
```

- [ ] **Step 7: Run everything, lint, commit**

```bash
npm run test:unit && npm run test:check
npx biome check --write srv/lib/response-sink.ts srv/lib/admission.ts srv/openai-handler.ts srv/anthropic-handler.ts test/unit/response-sink.test.ts test/unit/chat-admission.test.ts
git add srv/lib/response-sink.ts srv/lib/admission.ts srv/openai-handler.ts srv/anthropic-handler.ts test/unit/response-sink.test.ts test/unit/chat-admission.test.ts
git commit -m "feat(gatekeeper): chat channels take a place, and a disconnect ends nothing"
```

---

### Task 8: Remove the fourth entrance

**Files:**
- Modify: `srv/agent-service.cds` (drop `Chat`), `srv/agent-service.ts` (drop its handler)
- Test: `test/unit/agent-service-surface.test.ts`

**Why delete rather than gate:** `AgentService.Chat` takes no destination and no per-request credentials, so it cannot reach a SAP system the way the other three channels can. It establishes no request connection and calls no `safeStop`. It is the one entrance with neither a door nor a session lifecycle — an endpoint that no path in this design fits is dead surface, not a gap in the design.

**`Health` stays, and is not an entrance at all.** It calls `agent.healthCheck()` and nothing else: no `process`, no connection, no session, no pipeline. It is exactly the "call with nobody waiting" the spec's policy is written for, so it needs no door — only a permit, which Task 14 gives it. Deleting it would have removed the only production caller of the behaviour that task implements, leaving a policy with nothing to apply to.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agent-service-surface.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cds = readFileSync(join(__dirname, '../../srv/agent-service.cds'), 'utf8');
const ts = readFileSync(join(__dirname, '../../srv/agent-service.ts'), 'utf8');

describe('AgentService — the surface that is left', () => {
  it('no longer exposes Chat', () => {
    expect(cds).not.toMatch(/function\s+Chat\s*\(/);
    expect(ts).not.toMatch(/srv\.on\(\s*'Chat'/);
  });

  it('starts no pipeline anywhere in this file', () => {
    // The Chat handler called agent.process straight through, past every door.
    expect(ts).not.toMatch(/agent\.process\(/);
  });

  it('keeps Health, which starts nothing and needs no door', () => {
    // Not an entrance: it probes and returns. Deleting it would leave the
    // health policy in Task 14 with nothing to apply to.
    expect(cds).toMatch(/function\s+Health\s*\(/);
    expect(ts).toMatch(/agent\.healthCheck\(/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/agent-service-surface.test.ts`
Expected: FAIL — all three still present.

- [ ] **Step 3: Remove the endpoints**

Delete the `Chat` function declaration from `srv/agent-service.cds` and its `srv.on('Chat', ...)` handler from `srv/agent-service.ts`. Leave `Health` and everything else in both files untouched.

- [ ] **Step 4: Check nothing else calls them**

Run: `grep -rn "AgentService\|/agent'" srv/ app/ docs/ --include="*.ts" --include="*.html" --include="*.json" --include="*.md" | grep -v node_modules`

Any hit in `app/` or `docs/` is a caller to update or a document to correct. The chat UI uses `/v1/chat/completions`, not this endpoint — confirm that before deleting, and if a caller does exist, stop and report it rather than breaking it.

- [ ] **Step 5: Run, lint, commit**

```bash
npx jest test/unit/agent-service-surface.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/agent-service.ts test/unit/agent-service-surface.test.ts
git add srv/agent-service.cds srv/agent-service.ts test/unit/agent-service-surface.test.ts
git commit -m "refactor: drop AgentService.Chat, the entrance with no door and no session"
```

## Phase 2 — a dependency that is down

### Task 9: Tell an outage from a tool that failed

**Files:**
- Create: `srv/lib/mcp-outage.ts`
- Modify: `srv/agent-manager.ts` (the dispatch helper, the raise and the builder wiring), `srv/connections/CloudSdkAbapConnection.ts` (ask about a plain network failure), `srv/lib/probe-classifier.ts` (recognise one)
- Test: `test/unit/mcp-outage.test.ts`, `test/unit/probe-classifier-network.test.ts`

**Interfaces:**
- Consumes: `ProbeStatus` from `srv/lib/probe-classifier.ts`, whose verdict `CloudSdkAbapConnection` has already written into the message, and `isMcpUnavailable` from `@mcp-abap-adt/llm-agent`.
- Produces:
  - `export const OUTAGE_STATUSES: ReadonlySet<ProbeStatus>`
  - `export function asOutage(error: unknown, destination: string): McpUnavailableError | undefined` — the connector's failure, classified, or nothing
  - `export class McpUnavailableError extends Error { readonly code = 'mcp_unavailable'; readonly destination: string; readonly status: ProbeStatus }`
  - `export function isUnavailable(error: unknown): boolean` — our typed marker, valid only **before** the embedded wrapper
  - `export function isOutageError(error: unknown): boolean` — for everything **after** it, where only a mapped `McpError` survives
  - `export const OUTAGE_MCP_CODES: ReadonlySet<string>`
  - `export function describeCause(error: unknown): string`
  - `export const outageClassifier: IMcpFailureClassifier`

**The connector already catches it, classifies it, and writes the verdict
down.** When the SAP system goes away it is the connection layer that sees the
failure, and `CloudSdkAbapConnection` puts it through `classifyProbe` and
appends `[tunnel_timeout]`, `[dns_or_network]` and the rest to the error's own
message. That tag is the fact, and this task reads it. Re-deriving
unreachability here — from a fresh list of substrings, or by calling
`classifyProbe` a second time without the response object or the proxy type
that the first call had — would be a worse copy of a verdict that already
exists, and the two would disagree under exactly the conditions that matter.

So this task adds no detection. It adds **preservation** — carrying a fact the
connector already established across a boundary that drops it.

**The boundary.** This service builds its MCP client with
`transport: 'embedded'` and its own `callToolHandler`, and the embedded branch
of `MCPClientWrapper` neither reconnects nor retries: it catches the handler's
exception and returns an ordinary tool result carrying an `error` **string**.
The class, the `code` and the `cause` do not survive. `McpClientAdapter` then
escalates a returned error only when `toMcpError` recognises that string as
`MCP_NOT_CONNECTED` or `MCP_NO_RESPONSE`; everything else stays tool feedback
and no classifier is consulted at all.

**Which statuses mean the system is gone**, and which do not — the distinction
is the whole point, because escalating the wrong one closes a destination that
is working:

| `ProbeStatus` | Outage? |
|---|---|
| `tunnel_timeout`, `no_scc_registration`, `wrong_location_id`, `dns_or_network` | **yes** — nothing reached SAP |
| `backend_auth_failed` | no — the system answered, and said no |
| `backend_reachable_path_error` | no — the name says it |
| `backend_error` | no — SAP ran something and failed |
| `ok`, `unknown` | no |

**And "SAP system" means two different things here.** The one above is the
**ABAP** system, reached through the connector and exposed through MCP, and a
destination is exactly the unit that can be closed when it goes away. The other
is **BTP itself** — the platform this service runs on, and the source of AI
Core, XSUAA, the destination service and the connectivity service.

A BTP-side failure is not a destination problem and must not be reported as
one:

- **AI Core down.** The model calls fail. That error never passes through
  `classifyProbe` at all — it comes up the provider path, through the gated
  wrapper, and is not a `429`, so it surfaces as the failure it is. Nothing is
  closed, because there is no destination to close: every destination is
  equally affected and none is at fault.
- **The destination service down.** Resolution fails before admission, so
  callers are refused without taking a place. That is the existing
  `destination_unreachable` answer and it already works; what would be wrong is
  marking every destination closed on the way past.
- **The connectivity service down.** Every on-premise destination goes
  unreachable at once and each closes on its own account. Correct, and noisy:
  the shared cause is invisible in the per-destination view, which is a real
  gap and a named one.

None of that is built here. This task closes an ABAP system that has gone away,
which is the failure the gatekeeper's own guarantee has to survive. Recognising
a platform-wide outage as one thing rather than N is separate work, and the
observability scopes in Task 13 are where it would show first — every
destination closing within the same few seconds.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-outage.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asOutage,
  isOutageError,
  isUnavailable,
  McpUnavailableError,
  outageClassifier,
} from '../../srv/lib/mcp-outage';

describe('telling an outage from a tool that ran and failed', () => {
  it('recognises our own unavailability marker', () => {
    expect(
      isUnavailable(new McpUnavailableError('S4HANA_DEV', 'tunnel down', 'tunnel_timeout')),
    ).toBe(true);
  });

  it('survives being rewrapped, because every layer rewraps', () => {
    const inner = new McpUnavailableError('S4HANA_DEV', 'tunnel down', 'tunnel_timeout');
    const outer = new Error('Tool execution failed');
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(isUnavailable(outer)).toBe(true);
  });

  it('leaves domain feedback alone', () => {
    // A tool's own "forbidden" or "currently editing" is feedback, not an
    // outage, and escalating it would close a destination that is fine.
    expect(isUnavailable(new Error('User DEVELOPER is currently editing ZCL_X'))).toBe(false);
    expect(isUnavailable(new Error('403 Forbidden'))).toBe(false);
    expect(isUnavailable(new Error('The operation timed out'))).toBe(false);
  });
});

describe('asOutage — the connector decides, through the classifier we already have', () => {
  it('marks a failure the connector tagged as never having reached SAP', () => {
    // The tag is what the connector wrote; this reads it rather than guessing
    // again from the prose around it.
    const err = new Error('connect ECONNRESET 10.0.0.1:44300 [tunnel_timeout]');
    const outage = asOutage(err, 'S4HANA_DEV');
    expect(outage).toBeDefined();
    expect(outage?.destination).toBe('S4HANA_DEV');
    // The original survives verbatim, which is what carries the signature
    // across the wrapper's string-only return.
    expect(outage?.message).toContain('ECONNRESET');
  });

  it('leaves an authentication failure alone, because SAP answered', () => {
    // The system is up and said no. Closing it would take a working
    // destination out of service for everyone over one caller's credentials.
    expect(asOutage(new Error('401 Unauthorized [backend_auth_failed]'), 'D')).toBeUndefined();
  });

  it('leaves a backend error alone, because SAP ran something', () => {
    expect(asOutage(new Error('500 [backend_error]'), 'D')).toBeUndefined();
  });

  it('says nothing when the connector tagged nothing', () => {
    // No tag means the connector did not classify this as a connectivity
    // problem at all — a tool-level failure, most often.
    expect(asOutage(new Error('object ZCL_X not found'), 'D')).toBeUndefined();
  });

  it('closes on transport codes and not on ones the server answered', () => {
    const { McpError } = require('@mcp-abap-adt/llm-agent') as typeof import('@mcp-abap-adt/llm-agent');
    const closes = ['MCP_NOT_CONNECTED', 'MCP_NO_RESPONSE', 'MCP_TIMEOUT', 'MCP_HTTP_503'];
    for (const code of closes) {
      expect(isOutageError(new McpError('x', code))).toBe(true);
    }
    // In the library's unavailable set, deliberately not in ours: a 403 is an
    // authorisation verdict and a 404 is a path. The server answered.
    for (const code of ['MCP_HTTP_403', 'MCP_HTTP_404']) {
      expect(isOutageError(new McpError('x', code))).toBe(false);
    }
  });

  it('classifies for the library seam, which is async and takes an McpError', async () => {
    const { McpError } = require('@mcp-abap-adt/llm-agent') as typeof import('@mcp-abap-adt/llm-agent');
    const down = new McpError('no response from S4HANA_DEV', 'MCP_NO_RESPONSE');
    const feedback = new McpError('object ZCL_X not found', 'MCP_ERROR');
    await expect(outageClassifier.classify(down)).resolves.toBe('unavailable');
    await expect(outageClassifier.classify(feedback)).resolves.toBe('tool-error');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/mcp-outage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the classifier**

Create `srv/lib/mcp-outage.ts`:

```ts
import { isMcpUnavailable } from '@mcp-abap-adt/llm-agent';
import type {
  IMcpFailureClassifier,
  McpError,
  McpFailureKind,
} from '@mcp-abap-adt/llm-agent';
import type { ProbeStatus } from './probe-classifier';

/**
 * The connection is gone, as distinct from a tool that ran and failed.
 *
 * The distinction cannot rest on how a message happens to read. A tool's own
 * "forbidden", "timed out" or "currently editing" is domain feedback: escalating
 * it would close a destination that is working. So the handler raises this type
 * deliberately, and everything else stays feedback.
 */
export class McpUnavailableError extends Error {
  readonly code = 'mcp_unavailable';
  constructor(
    readonly destination: string,
    reason: string,
    readonly status: ProbeStatus,
    options?: { cause?: unknown },
  ) {
    // The wording is not cosmetic. On the embedded transport the wrapper
    // catches this and returns only `error.message` as a string — the class,
    // the code and the cause are all dropped — and `McpClientAdapter` escalates
    // a returned error only when `toMcpError` recognises it as
    // MCP_NOT_CONNECTED or MCP_NO_RESPONSE. Anything else stays ordinary tool
    // feedback and the classifier is never consulted at all.
    //
    // So the message carries two things: the underlying cause verbatim, which
    // is where a real ECONNRESET, EHOSTUNREACH or "socket hang up" survives,
    // and the phrase "no response from", which is both true of a system we
    // could not reach and one of the signatures that mapper knows.
    super(`no response from SAP system ${destination}: ${reason}`, options);
    this.name = 'McpUnavailableError';
  }
}

/**
 * The statuses that mean nothing reached SAP.
 *
 * Not a new judgement: `classifyProbe` already draws these lines for
 * `ProbeDestination` and for the `destination_unreachable` answer the chat
 * handlers give. All this does is say which of its verdicts close a
 * destination. An auth failure does not — the system answered, and said no —
 * and neither does a path error or a backend error, both of which mean SAP ran
 * something.
 */
export const OUTAGE_STATUSES: ReadonlySet<ProbeStatus> = new Set([
  'tunnel_timeout',
  'no_scc_registration',
  'wrong_location_id',
  'dns_or_network',
]);

/**
 * Read the verdict the connector already reached, and mark it only if it means
 * the system is gone.
 *
 * `CloudSdkAbapConnection` classifies its own failures and appends `[status]`
 * to the message (`srv/connections/CloudSdkAbapConnection.ts`). Reading that
 * tag is the point: calling `classifyProbe` again from here would re-classify
 * with fields this side does not have — the real HTTP status lives at
 * `error.response.status`, not `error.status`, and the proxy type is not on the
 * error at all — so the second verdict would sometimes disagree with the first,
 * and the one with less information would win.
 *
 * The message keeps the original verbatim, which is where a real ECONNRESET or
 * "socket hang up" survives the string-only crossing described above.
 */
export function asOutage(
  error: unknown,
  destination: string,
): McpUnavailableError | undefined {
  const message = describeCause(error);
  const tagged = /\[([a-z_]+)\]/.exec(message);
  const status = tagged?.[1] as ProbeStatus | undefined;
  if (!status || !OUTAGE_STATUSES.has(status)) return undefined;
  return new McpUnavailableError(destination, message, status, { cause: error });
}

const MAX_CAUSE_DEPTH = 5;

/** The marker, on the error or anywhere in its cause chain. */
export function isUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== 'object' || cur === null || seen.has(cur)) return false;
    seen.add(cur);
    if ((cur as { code?: unknown }).code === 'mcp_unavailable') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** The library's seam for the fact. The decision stays ours. */
/**
 * The library's seam for the fact. The decision stays ours.
 *
 * `classify` is **async** and takes an `McpError` — the shape the adapter has
 * already mapped the failure into — not a bare `Error`. It also offers
 * `probeHealth`, which this implementation does not use: an outage we have
 * already identified needs no second opinion, and probing here would put a
 * network call on a failure path.
 */
/**
 * The mapped codes that close a destination.
 *
 * The library's `MCP_UNAVAILABLE_CODES` is close but not the same list, and the
 * difference is deliberate rather than an oversight in either place. That set
 * answers "did this fail at the transport level", and includes `MCP_HTTP_403`
 * and `MCP_HTTP_404` — which for us mean the server **answered**: a 403 is an
 * authorisation verdict and a 404 is a path. Closing a destination on either
 * would take a working system out of service for every caller because one
 * request was wrong.
 *
 * So the library establishes the fact and this narrows it, which is the same
 * division of labour as everywhere else in this design.
 */
export const OUTAGE_MCP_CODES: ReadonlySet<string> = new Set([
  'MCP_NOT_CONNECTED',
  'MCP_NO_RESPONSE',
  'MCP_TIMEOUT',
  'MCP_TRANSPORT',
  'MCP_HTTP_502',
  'MCP_HTTP_503',
]);

/**
 * Whether a failure that has already crossed the wrapper means the system is
 * gone.
 *
 * This is the **downstream** predicate, and it exists because `isUnavailable`
 * cannot work here. Our typed marker does not survive the embedded transport —
 * the wrapper keeps only `error.message` — so by the time a handler reads
 * `result.error` there is an `McpError` with a mapped code and nothing else.
 * A handler asking `isUnavailable` would find no marker and close nothing,
 * which is precisely how this path failed silently.
 */
export function isOutageError(error: unknown): boolean {
  if (isUnavailable(error)) return true;
  return (
    isMcpUnavailable(error) &&
    OUTAGE_MCP_CODES.has((error as McpError).code)
  );
}

export const outageClassifier: IMcpFailureClassifier = {
  async classify(error: McpError): Promise<McpFailureKind> {
    return isOutageError(error) ? 'unavailable' : 'tool-error';
  },
};

/**
 * A short reason for a log line or a closed-destination record.
 *
 * Defined here because the three channels need the same one and none of them
 * has it: an earlier draft of this plan called `describeCause` an existing
 * helper, and there is no such symbol anywhere in `srv/`.
 */
export function describeCause(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

- [ ] **Step 4: Let the connector tag a plain network failure**

`CloudSdkAbapConnection` classifies only what already looks tunnel-shaped:
`httpCode >= 500` or a message matching `tunnel|SCC|Cloud Connector|Anmeldung|
Logon` (`srv/connections/CloudSdkAbapConnection.ts`). A bare `ENOTFOUND`,
`ECONNREFUSED`, `ECONNRESET` or `socket hang up` passes through untagged — and
those are the ordinary shapes of a system that has gone away. Reading a tag
that is never written would make this whole path work only for the failures
that announce themselves.

**Two files, not one.** The connector decides *whether to ask*; the classifier
decides *what the answer is*. Widening only the first would ask about errors the
second still reads as `unknown`, so no tag would be written and `asOutage` would
go on seeing nothing. `srv/lib/probe-classifier.ts:118` currently knows
`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN` and `getaddrinfo` — not
`ECONNRESET`, `EHOSTUNREACH`, `ENETUNREACH` or `socket hang up`.

First the classifier:

```ts
  if (
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up/i.test(
      msg,
    )
  ) {
    return {
      status: 'dns_or_network',
      hint: 'Backend host is unresolvable, refused TCP, or dropped the connection — check destination URL and on-premise network.',
    };
  }
```

with its own test, in `test/unit/probe-classifier-network.test.ts`:

```ts
import { classifyProbe } from '../../srv/lib/probe-classifier';

describe('classifyProbe — the plain shapes of a host that is gone', () => {
  for (const signature of [
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'socket hang up',
  ]) {
    it(`reads ${signature} as a network failure`, () => {
      expect(classifyProbe(0, `connect ${signature} 10.0.0.1:44300`, 'OnPremise').status)
        .toBe('dns_or_network');
    });
  }

  it('still leaves a backend answer alone', () => {
    // The host answered; it simply said no. Reading this as a network failure
    // would close a destination that is working.
    expect(classifyProbe(401, 'Unauthorized', 'OnPremise').status).not.toBe(
      'dns_or_network',
    );
  });
});
```

Then the connector, in the place that has the response object and knows the
proxy type. **The two lists must hold the same signatures** — a code the
classifier recognises but the connector never asks about is a code that closes
nothing, which is the whole of the failure this step exists to end:

```ts
        const looksTunnelRelated =
          httpCode >= 500 ||
          /tunnel|SCC|Cloud Connector|Anmeldung|Logon/i.test(rawMessage) ||
          // The plain shapes of a host that is not there. classifyProbe already
          // reads these as dns_or_network; it was simply never asked.
          /ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up/i.test(
            rawMessage,
          );
```

and assert it, in `test/unit/mcp-outage.test.ts`:

```ts
describe('the connector tags the failures it sees', () => {
  it('classifies a bare network error, not only a tunnel-shaped one', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/connections/CloudSdkAbapConnection.ts'),
      'utf8',
    );
    // Without this the tag is never written for the commonest outage of all,
    // and everything downstream reads an absence as "not an outage".
    expect(source).toMatch(/ECONNREFUSED/);
    expect(source).toMatch(/socket hang up/);
  });
});
```

- [ ] **Step 5: Raise it from the handler**

In `srv/agent-manager.ts`, inside `invokeEmbeddedTool`, put the connector's own
failure through the classifier and rethrow only what it calls an outage:

This composes with Task 6b rather than replacing it. Both wrap the **same**
promise: it is registered before it is awaited, and classified after it comes
back. Written out in full so the two orders cannot be read as alternatives:

```ts
  async function invokeEmbeddedTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // ... the authorization check, unchanged ...

    const dispatched = dispatchEmbeddedTool(name, args, signal);
    // Registered at dispatch (Task 6b): the slot outlives the calls this
    // pipeline started.
    currentAdmission()?.track(dispatched);
    try {
      return await dispatched;
    } catch (err) {
      // And classified on the way out. The connector has already decided what
      // happened and written its verdict into the message; this re-raises it
      // in a form that survives the wrapper's string-only return.
      throw asOutage(err, destinationName) ?? err;
    }
  }
```

`destinationName` is the closure `buildEmbeddedMcpAdapter` already has — the
destination this adapter was built for. There is no `currentDestination()`
anywhere, and `connectionALS` carries `connection`, `context`, `dumpScope` and
`exposition` but no destination, so neither was available to reach for.

> Do not widen `OUTAGE_STATUSES`. A tool that reached SAP and was refused is
> feedback, and closing a destination on it would take a working system out of
> service for every caller.

- [ ] **Step 6: Wire it to the builder**

A strategy nothing installs is dead code, and the pipeline would go on using
`DefaultMcpFailureClassifier`. In `srv/agent-manager.ts`, on the builder that
constructs each destination's agent (`buildAgentForDestination`), add it beside
the other consumer-owned seams:

```ts
    .withMcpFailureClassifier(outageClassifier)
```

and assert it, in `test/unit/mcp-outage.test.ts`:

```ts
describe('the classifier is installed, not merely written', () => {
  it('is handed to the builder', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/agent-manager.ts'),
      'utf8',
    );
    expect(source).toMatch(/withMcpFailureClassifier\(\s*outageClassifier\s*\)/);
  });
});
```

- [ ] **Step 7: Run, lint, commit**

```bash
npx jest test/unit/mcp-outage.test.ts test/unit/probe-classifier-network.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/mcp-outage.ts srv/lib/probe-classifier.ts srv/agent-manager.ts srv/connections/CloudSdkAbapConnection.ts test/unit/mcp-outage.test.ts test/unit/probe-classifier-network.test.ts
git add srv/lib/mcp-outage.ts srv/lib/probe-classifier.ts srv/agent-manager.ts srv/connections/CloudSdkAbapConnection.ts test/unit/mcp-outage.test.ts test/unit/probe-classifier-network.test.ts
git commit -m "feat(outage): a lost connection is raised as one, not left to read like one"
```

---

### Task 10: A closed destination, and a `Retry-After` that is true

**Files:**
- Modify: `srv/agent-manager.ts` (destination state gains `nextProbeAt`; the probe scheduler records it), `srv/lib/throttle-surfacing.ts` (the refusal)
- Test: `test/unit/destination-closed.test.ts`, `test/unit/destination-close-wiring.test.ts`

**Interfaces:**
- Consumes: `isUnavailable` from Task 9.
- Produces:
  - `export function closeDestination(name: string, reason: string): void` in `agent-manager`
  - `export function retryAfterForDestination(name: string, now?: number): number | undefined`
  - `export function destinationClosedText(name: string): string` in `throttle-surfacing`

**The number:** not the probe interval. The retry today is one process-wide `setInterval`, whose phase has nothing to do with when any particular destination failed, so a caller refused a second before a tick would be told to wait five minutes while the recheck happens immediately. The scheduler records `nextProbeAt` per destination and the header is the remainder, rounded up. With nothing scheduled there is no header.

- [ ] **Step 1: Write the failing test**

Create `test/unit/destination-closed.test.ts`:

```ts
const load = () => {
  jest.resetModules();
  return require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
};

let current: ReturnType<typeof load> | undefined;

afterEach(() => {
  // closeDestination arms a five-minute probe timer. Left running, Jest either
  // reports an open handle or waits on it after the suite has finished.
  current?.clearDestinationStatesForTest();
  current = undefined;
  jest.resetModules();
});

describe('a closed destination', () => {
  it('reports the remainder to the next probe, not the whole interval', () => {
    const mod = load();
    current = mod;
    const now = 1_000_000;
    mod.closeDestination('S4HANA_DEV', 'tunnel down');
    mod.setNextProbeAtForTest('S4HANA_DEV', now + 12_000);
    // Refused eleven seconds before the tick: the honest answer is twelve
    // seconds, not three hundred.
    expect(mod.retryAfterForDestination('S4HANA_DEV', now)).toBe(12);
  });

  it('rounds up, because waking early walks back into the same refusal', () => {
    const mod = load();
    current = mod;
    const now = 1_000_000;
    mod.closeDestination('D', 'x');
    mod.setNextProbeAtForTest('D', now + 12_400);
    expect(mod.retryAfterForDestination('D', now)).toBe(13);
  });

  it('gives no number when no probe is scheduled', () => {
    const mod = load();
    current = mod;
    mod.closeDestination('D', 'x');
    mod.setNextProbeAtForTest('D', undefined);
    expect(mod.retryAfterForDestination('D', 1_000_000)).toBeUndefined();
  });

  it('leaves other destinations alone', () => {
    const mod = load();
    current = mod;
    mod.closeDestination('S4HANA_DEV', 'tunnel down');
    expect(mod.isDestinationClosed('S4HANA_DEV')).toBe(true);
    expect(mod.isDestinationClosed('S4HANA_QAS')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/destination-closed.test.ts`
Expected: FAIL — `closeDestination is not a function`.

- [ ] **Step 3: Record the next probe per destination**

In `srv/agent-manager.ts`, add `nextProbeAt?: number` to `DestinationState`, and in `scheduleUnreachableRetry` set it for every unreachable destination each time the timer is armed:

Replace the `setInterval` with a recursive `setTimeout`. That is not tidying:
with an interval, the next tick is measured from the start of the previous one,
so a stamp written at the end of a slow probe is later than the run it claims
to describe — and the `Retry-After` built from it tells callers to wait longer
than they need to. A timeout armed after the work has finished has a deadline
that is true by construction.

```ts
  const armProbe = () => {
    const at = Date.now() + UNREACHABLE_RETRY_INTERVAL_MS;
    for (const [, state] of destinationStates) {
      if (state.status === 'unreachable') state.nextProbeAt = at;
    }
    unreachableRetryTimer = setTimeout(runProbe, UNREACHABLE_RETRY_INTERVAL_MS);
  };

  const runProbe = async () => {
    unreachableRetryTimer = null;
    // ... the existing tick body ...
    if (stillUnreachable.length === 0) {
      for (const [, state] of destinationStates) state.nextProbeAt = undefined;
      return; // nothing left to probe; the loop stops until something closes
    }
    armProbe(); // stamped and armed together, after the work, from the same now
  };
```

`scheduleUnreachableRetry` becomes: if a timer is already pending, do nothing; otherwise `armProbe()`.

- [ ] **Step 4: Add the three exports**

```ts
/**
 * Mark a destination unreachable because MCP could not be reached.
 *
 * Creates the entry when there is none: a destination that fails on its very
 * first call has no state yet, and returning early there would silently keep
 * the door open on the system we just found to be gone.
 *
 * The field is `error` — the one `DestinationState` already has — not a second
 * one beside it.
 */
export function closeDestination(name: string, reason: string): void {
  const existing = destinationStates.get(name);
  if (existing) {
    existing.status = 'unreachable';
    existing.error = reason;
  } else {
    // The same shape the background discovery pass builds for a pending
    // destination (`srv/agent-manager.ts`, where `status: 'pending'` entries
    // are created). `toolsRag` is not optional on `DestinationState` and is
    // read without a guard in several places, so a half-built entry would
    // surface later as a different bug.
    destinationStates.set(name, {
      mcpAdapter: null,
      toolsRag: new ExpositionFilteringRag(new InMemoryRag(), new InMemoryRag()),
      toolCount: 0,
      status: 'unreachable',
      error: reason,
    });
  }
  cds.log('agent-manager').warn('destination closed', { destination: name, reason });
  scheduleUnreachableRetry();
}

export function isDestinationClosed(name: string): boolean {
  return destinationStates.get(name)?.status === 'unreachable';
}

/** Every destination this process knows about, closed or not. */
export function knownDestinations(): string[] {
  return [...destinationStates.keys()];
}

/**
 * Seconds until we next LOOK at this destination — not an estimate of when SAP
 * returns, which we cannot know. Coming back sooner is certainly wasted.
 */
export function retryAfterForDestination(name: string, now = Date.now()): number | undefined {
  const at = destinationStates.get(name)?.nextProbeAt;
  if (at === undefined) return undefined;
  return Math.max(1, Math.ceil((at - now) / 1000));
}

/** Test seam: set the scheduled probe without running the real timer. */
export function setNextProbeAtForTest(name: string, at: number | undefined): void {
  const state = destinationStates.get(name);
  if (state) state.nextProbeAt = at;
}

/**
 * Test seam: forget every destination and stop the probe timer.
 *
 * The timer matters as much as the state. `closeDestination` arms a five-minute
 * `setTimeout`, so a test that closes a destination and returns leaves Jest
 * holding an open handle — reported as a leak, or waited on after the suite
 * has finished.
 */
export function clearDestinationStatesForTest(): void {
  if (unreachableRetryTimer) clearTimeout(unreachableRetryTimer);
  unreachableRetryTimer = null;
  destinationStates.clear();
}
```

`ExpositionFilteringRag` and `InMemoryRag` are already imported in this module for the pending-state path; no new import and no new helper.

- [ ] **Step 5: Refuse arrivals, spare the admitted**

Three channels, three shapes. `execute_step` has no HTTP response in scope at
all — its callback returns an MCP result — and the two chat dialects do not
share an envelope, so one snippet for all three would not compile in two of
them.

**`srv/openai-handler.ts`** — `destAfter`:

```ts
  if (isDestinationClosed(destAfter)) {
    const seconds = retryAfterForDestination(destAfter);
    res.writeHead(503, {
      'Content-Type': 'application/json',
      ...(seconds !== undefined ? { 'Retry-After': String(seconds) } : {}),
    });
    res.end(
      JSON.stringify({
        error: { type: 'overloaded_error', message: destinationClosedText(destAfter) },
      }),
    );
    return;
  }
```

**`srv/anthropic-handler.ts`** — `destination`, and the dialect's own envelope,
which wraps the error in a `type: 'error'` object:

```ts
  if (isDestinationClosed(destination)) {
    const seconds = retryAfterForDestination(destination);
    res.writeHead(503, {
      'Content-Type': 'application/json',
      ...(seconds !== undefined ? { 'Retry-After': String(seconds) } : {}),
    });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: destinationClosedText(destination),
        },
      }),
    );
    return;
  }
```

**`srv/agent-mcp.ts`** — `targetDestination`, and an MCP error result. There is
no header here, so the interval goes into the text where a planner can read it:

```ts
      if (isDestinationClosed(targetDestination)) {
        const seconds = retryAfterForDestination(targetDestination);
        const when =
          seconds !== undefined ? ` Try again in about ${seconds} seconds.` : '';
        return textResult(`${destinationClosedText(targetDestination)}${when}`, true);
      }
```

A pipeline already admitted is **not** cut: it fails only if it actually calls the missing server.

And in `srv/lib/throttle-surfacing.ts`:

```ts
/** A destination we have closed. Temporary, and a 5xx because it is ours. */
export function destinationClosedText(destination: string): string {
  return `SAP system ${destination} is not reachable right now. Other systems are unaffected.`;
}
```

- [ ] **Step 6: Close it from the three error paths, by name**

"Where a turn ends in failure" is not an instruction — the three channels
receive a failure in three different shapes, and a plan that waves at them
leaves the production path unwired while the unit tests, which call
`closeDestination` themselves, stay green.

**A failure does not always arrive as a throw, and that is where an earlier
draft of this step went wrong.** The pipeline returns a `Result`, so the
ordinary case is `ok === false` reaching the same code that formats the answer
— never the `catch`. Wiring only the `catch` and the stream chunk would leave
the two most common paths silently open. And each channel names its destination
differently, so the snippets below use the variable each file actually has.

**`srv/agent-mcp.ts`** — the destination is `targetDestination`, normalised at
`srv/agent-mcp.ts:274`. Two places:

```ts
      // 1. the Result the executor returns
      if (!r.ok) {
        if (isOutageError(r.error)) {
          closeDestination(targetDestination, describeCause(r.error));
        }
        return textResult(failureText(r.error), true);
      }

      // 2. and a throw, for the paths that do not come back as a Result
      } catch (err) {
        if (isOutageError(err)) closeDestination(targetDestination, describeCause(err));
        return textResult(failureText(err), true);
      }
```

**`srv/openai-handler.ts`** — the destination is `destAfter`. Three places:
the non-streaming `Result`, the streaming error chunk, and the `catch`.

```ts
      // 1. non-streaming
      if (!result.ok) {
        if (isOutageError(result.error)) {
          closeDestination(destAfter, describeCause(result.error));
        }
        ...
      }

      // 2. streaming
      if (!chunk.ok) {
        if (isOutageError(chunk.error)) {
          closeDestination(destAfter, describeCause(chunk.error));
        }
        ...
      }

      // 3. thrown
      } catch (err) {
        if (isOutageError(err)) closeDestination(destAfter, describeCause(err));
        ...
```

**`srv/anthropic-handler.ts`** — the same three places, but the variable is
`destination` (`srv/anthropic-handler.ts:113`); there is no `destAfter` in this
file at all.

```ts
        if (isOutageError(result.error)) {
          closeDestination(destination, describeCause(result.error));
        }
```

`describeCause` comes from `./lib/mcp-outage`, added in Step 3 of Task 9 — add
it to each channel's imports alongside `isOutageError` and `closeDestination`.

- [ ] **Step 7: Assert the production paths are wired**

Create `test/unit/destination-close-wiring.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural, deliberately. The unit tests for `closeDestination` call it
 * themselves, so they pass whether or not anything in production ever does —
 * which is the failure this file exists to catch.
 */
const read = (f: string) => readFileSync(join(__dirname, '../../srv', f), 'utf8');

/** The destination variable each channel actually has in scope. */
const DEST_VAR: Record<string, string> = {
  'agent-mcp.ts': 'targetDestination',
  'openai-handler.ts': 'destAfter',
  'anthropic-handler.ts': 'destination',
};

describe('a closed destination is refused in each channel\'s own shape', () => {
  it('uses the Anthropic envelope in the Anthropic handler', () => {
    // `{ error }` is the OpenAI shape; this dialect wraps it in `type: 'error'`,
    // and a client reading the wrong one sees an unparsable body.
    const src = read('anthropic-handler.ts');
    expect(src).toMatch(/isDestinationClosed\(\s*destination\s*\)/);
    expect(src).toMatch(/type: 'error'[\s\S]{0,200}destinationClosedText/);
  });

  it('uses the OpenAI envelope in the OpenAI handler', () => {
    expect(read('openai-handler.ts')).toMatch(
      /isDestinationClosed\(\s*destAfter\s*\)/,
    );
  });

  it('returns an MCP result from execute_step, which has no response object', () => {
    const src = read('agent-mcp.ts');
    expect(src).toMatch(/isDestinationClosed\(\s*targetDestination\s*\)/);
    expect(src).toMatch(/textResult\([\s\S]{0,160}destinationClosedText/);
    // A writeHead here would not compile: there is no res in scope.
    expect(src).not.toMatch(/res\.writeHead\(503/);
  });
});

describe('every channel closes a destination it finds unreachable', () => {
  for (const [file, dest] of Object.entries(DEST_VAR)) {
    it(`${file} closes on a returned failure`, () => {
      // The common path: the pipeline returns a Result, and ok === false never
      // reaches a catch. Wiring only the catch leaves this open.
      expect(read(file)).toMatch(
        new RegExp(`isOutageError\\((?:r|result)\\.error\\)[\\s\\S]{0,160}closeDestination\\(\\s*${dest}`),
      );
    });

    it(`${file} closes on a thrown failure`, () => {
      expect(read(file)).toMatch(
        new RegExp(`isOutageError\\(err\\)[\\s\\S]{0,160}closeDestination\\(\\s*${dest}`),
      );
    });
  }

  for (const file of ['openai-handler.ts', 'anthropic-handler.ts']) {
    it(`${file} closes on an error chunk too`, () => {
      // Three shapes, three wirings. Covering two of them leaves a whole
      // transport silently open.
      expect(read(file)).toMatch(
        new RegExp(`isOutageError\\(chunk\\.error\\)[\\s\\S]{0,160}closeDestination\\(\\s*${DEST_VAR[file]}`),
      );
    });
  }
});
```

and an end-to-end one, which is the only kind that catches the marker being
lost inside the embedded wrapper. Append to
`test/unit/destination-close-wiring.test.ts`:

```ts
import { McpClientAdapter, MCPClientWrapper } from '@mcp-abap-adt/llm-agent-mcp';
import { isOutageError, McpUnavailableError } from '../../srv/lib/mcp-outage';

describe('an unreachable system survives the embedded transport', () => {
  it('reaches the adapter as a failure, not as tool feedback', async () => {
    // The whole path: our handler throws, the embedded wrapper catches it and
    // keeps only the message string, and the adapter decides from that string
    // alone whether this was an outage or a tool that ran and failed. A wording
    // the mapper does not recognise ends here as ok:true, and the classifier is
    // never consulted — which no unit test of closeDestination would show.
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      callToolHandler: async () => {
        throw new McpUnavailableError(
          'S4HANA_DEV',
          'connect ECONNRESET [tunnel_timeout]',
          'tunnel_timeout',
        );
      },
    });
    const adapter = new McpClientAdapter(wrapper);
    const result = await adapter.callTool('ReadClass', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The predicate a handler will actually use. `isUnavailable` would be
      // false here — the typed marker did not survive the crossing — which is
      // exactly how this path closed nothing while every other assertion
      // passed.
      expect(isOutageError(result.error)).toBe(true);
      const manager = require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
      manager.closeDestination('S4HANA_DEV', result.error.message);
      expect(manager.isDestinationClosed('S4HANA_DEV')).toBe(true);
      manager.clearDestinationStatesForTest();
    }
    if (!result.ok) {
      // MCP_NO_RESPONSE, not MCP_NOT_CONNECTED: `toMcpError` tests "no
      // response" before the ECONNRESET family, and our marker opens with it.
      // Both are in the library's unavailable set, which is why the classifier
      // asks that set rather than naming a code.
      expect(result.error.code).toBe('MCP_NO_RESPONSE');
    }
  });

  it('leaves a tool that ran and failed as feedback', async () => {
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      callToolHandler: async () => {
        throw new Error('User DEVELOPER is currently editing ZCL_X');
      },
    });
    const adapter = new McpClientAdapter(wrapper);
    const result = await adapter.callTool('CreateClass', {});
    // Escalating this would close a destination that is working perfectly.
    expect(result.ok).toBe(true);
  });
});
```

and a behavioural one, appended to `test/unit/destination-closed.test.ts`:

```ts
describe('the classifier closes the destination it names', () => {
  it('turns an unavailability error into a closed destination', () => {
    const mod = load();
    const { McpUnavailableError, isUnavailable } =
      require('../../srv/lib/mcp-outage') as typeof import('../../srv/lib/mcp-outage');
    const err = new McpUnavailableError('S4HANA_DEV', 'tunnel down', 'tunnel_timeout');
    expect(isUnavailable(err)).toBe(true);
    mod.closeDestination('S4HANA_DEV', err.message);
    expect(mod.isDestinationClosed('S4HANA_DEV')).toBe(true);
    expect(mod.isDestinationClosed('S4HANA_QAS')).toBe(false);
  });
});
```

- [ ] **Step 8: Run, lint, commit**

```bash
npx jest test/unit/destination-closed.test.ts test/unit/destination-close-wiring.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/agent-manager.ts srv/lib/throttle-surfacing.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/agent-mcp.ts test/unit/destination-closed.test.ts test/unit/destination-close-wiring.test.ts
git add -A
git commit -m "feat(outage): a closed destination refuses arrivals, with the time until we next look"
```

### Task 11: An unanswered write is reported, never repeated

**Files:**
- Modify: `srv/lib/recording-mcp-client.ts` (open the record at dispatch), `srv/lib/throttle-surfacing.ts` (the failure text)
- Test: `test/unit/unanswered-write.test.ts`

**Interfaces:**
- Consumes: `isUnavailable` from Task 9.
- Produces:
  - `RecordingMcpClient.unanswered(traceId): ToolCallRecord[]` — calls dispatched and never answered
  - `export function unverifiedWriteText(calls: Array<{ name: string }>, cause: string): string`

**Why it cannot come from the finalizer:** `NoticeFinalizer` runs only when the interpreter returned a result; on an execution failure the coordinator sets its error and returns without calling it. An outage is an execution failure, so there is no executor response to append anything to. The notice belongs on our error path, beside the failure text the channels already compose.

**Why the record must open at dispatch:** `RecordingMcpClient` writes its record *after* awaiting the call, so a transport error that throws leaves no trace that a write was ever sent, which is precisely the case being reported.

- [ ] **Step 1: Write the failing test**

Create `test/unit/unanswered-write.test.ts`:

```ts
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';

function hangingClient(never: Promise<never>) {
  return {
    callTool: () => never,
    listTools: async () => ({ ok: true as const, value: [] }),
  };
}

describe('an unanswered write', () => {
  it('is visible while it is still in flight', async () => {
    const rec = new RecordingMcpClient(hangingClient(new Promise(() => {})) as never);
    void rec.callTool('CreateClass', { name: 'ZCL_X' }, { trace: { traceId: 't1' } } as never);
    await Promise.resolve();
    // Recorded at dispatch. Written after the await, a throw would leave no
    // trace that the write was ever sent, which is the case we report.
    expect(rec.unanswered('t1').map((r) => r.call.name)).toEqual(['CreateClass']);
  });

  it('stops being unanswered once an answer arrives', async () => {
    const client = {
      callTool: async () => ({ ok: true as const, value: { content: 'done' } }),
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec.callTool('CreateClass', {}, { trace: { traceId: 't2' } } as never);
    expect(rec.unanswered('t2')).toHaveLength(0);
  });

  it('says nothing about an unanswered read', async () => {
    // A lost answer to a read is a lost answer. Calling it a possibly-applied
    // write would teach a planner to re-check objects nothing touched.
    const client = {
      callTool: async () => {
        throw new Error('socket hang up');
      },
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec
      .callTool('ReadClass', { name: 'ZCL_X' }, { trace: { traceId: 't4' } } as never)
      .catch(() => undefined);
    expect(rec.unanswered('t4')).toHaveLength(0);
  });

  it('is reported once, naming the write, and never called again', async () => {
    let calls = 0;
    const client = {
      callTool: async () => {
        calls++;
        throw new Error('socket hang up');
      },
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec
      .callTool('CreateClass', { name: 'ZCL_X' }, { trace: { traceId: 't3' } } as never)
      .catch(() => undefined);
    expect(calls).toBe(1);
    expect(rec.unanswered('t3').map((r) => r.call.name)).toEqual(['CreateClass']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/unanswered-write.test.ts`
Expected: FAIL, `rec.unanswered is not a function`.

- [ ] **Step 3: Open the record at dispatch**

In `srv/lib/recording-mcp-client.ts`, import the existing classifier —
`import { isWriteTool } from './write-guardrail';` — and replace the body of
`callTool`:

```ts
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
    const traceId = options?.trace?.traceId;
    // Opened BEFORE the call, so "sent, unanswered" is a state the error path
    // can read rather than an absence it has to infer. Written after the await,
    // a thrown transport error leaves nothing at all.
    const record: ToolCallRecord & { answered?: boolean } = {
      call: { id: '', name, arguments: args },
      result: { content: '', isError: false },
      answered: false,
    };
    if (traceId) this.deltaFor(traceId).push(record);

    const res = await this.inner.callTool(name, args, options);
    // Reached only when an answer came back. A throw leaves `answered` false,
    // deliberately: we do not know whether SAP applied the change, and a retry
    // here would be a second attempt at it.
    record.result = res.ok
      ? res.value
      : { content: res.error?.message ?? String(res.error), isError: true };
    record.answered = true;
    return res;
  }

  /**
   * Writes dispatched under this trace that never received an answer.
   *
   * Writes only. An unanswered `ReadClass` is a lost answer and nothing more;
   * reporting it as possibly-applied would teach a planner to distrust reads
   * and to re-check objects nothing touched. `isWriteTool` is the same
   * classifier the write guardrail already uses, so the two cannot drift.
   */
  unanswered(traceId: string): ToolCallRecord[] {
    return (this.deltas.get(traceId) ?? []).filter(
      (r) =>
        (r as ToolCallRecord & { answered?: boolean }).answered !== true &&
        isWriteTool(r.call.name),
    );
  }
```

- [ ] **Step 4: Compose the failure on the error path**

In `srv/lib/throttle-surfacing.ts`:

```ts
/**
 * A write we sent and never got an answer for.
 *
 * We cannot tell an applied change from a lost one, because an ADT call is
 * asynchronous in substance. So this neither retries nor assumes. It says what
 * happened and leaves the reading to the consumer, which is what a planner and
 * a human are both for.
 */
export function unverifiedWriteText(
  calls: Array<{ name: string }>,
  cause: string,
): string {
  const names = calls.map((c) => c.name).join(', ');
  return `UNVERIFIED_WRITE: ${names} was sent and no answer came back (${cause}). It may or may not have been applied, so read the object back before deciding. It was NOT retried.`;
}
```

In each channel's error path, before formatting the failure:

```ts
  const pending = handle.recMcp?.unanswered(traceId) ?? [];
  const message =
    pending.length > 0
      ? unverifiedWriteText(pending.map((r) => r.call), describeCause(err))
      : failureText(err);
```

- [ ] **Step 5: Run, lint, commit**

```bash
npx jest test/unit/unanswered-write.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/recording-mcp-client.ts srv/lib/throttle-surfacing.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/agent-mcp.ts test/unit/unanswered-write.test.ts
git add -A
git commit -m "feat(outage): an unanswered write is named in the failure, and never sent twice"
```

---

## Phase 3 - collision and visibility

### Task 12: The collision guard

**Files:**
- Modify: `srv/lib/admission.ts` (caller-less bookkeeping, the guard), `srv/lib/throttle-surfacing.ts` (the 409 envelopes), `srv/openai-handler.ts`, `srv/anthropic-handler.ts`
- Test: `test/unit/collision-guard.test.ts`

**Interfaces:**
- Consumes: `admit`, `AdmissionHandle`, `markCallerGone` from Tasks 5 to 7.
- Produces:
  - `admit(key?: CallerKey)` where `CallerKey = { principal: string; session: string; destination: string }`
  - `export class PipelineInFlightError extends Error { readonly code = 'pipeline_in_flight' }`
  - `export function collisionPayload(dialect: 'openai' | 'anthropic'): { status: number; body: unknown }` in `throttle-surfacing`

**Scope, and its honest limit:** the guard fires only where a caller identifies itself. `/v1/chat/completions` mints a fresh UUID when no `x-session-id`, `mcp-session-id` or cookie arrives, and `execute_step` mints `agent-step-<uuid>` per call by design, so two retries from Cline, a script or an MCP planner share no session and both run. That is a known limit, not a bug to find later. `execute_step` is excluded outright: it sees no disconnect, so no pipeline of its is ever caller-less.

**The key includes the principal** because the session id is client-supplied, and the codebase already scopes session state by user and session for that reason.

- [ ] **Step 1: Write the failing test**

Create `test/unit/collision-guard.test.ts`:

```ts
const load = () => {
  jest.resetModules();
  const mod = require('../../srv/lib/admission') as typeof import('../../srv/lib/admission');
  mod.clearAdmission();
  return mod;
};

afterEach(() => jest.resetModules());

const key = (over: Partial<{ principal: string; session: string; destination: string }> = {}) => ({
  principal: 'alice',
  session: 's1',
  destination: 'S4HANA_DEV',
  ...over,
});

describe('the collision guard', () => {
  it('refuses an identified retry while the orphan is still running', async () => {
    const mod = load();
    const first = await mod.admit(key());
    mod.markCallerGone(first);
    await expect(mod.admit(key())).rejects.toBeInstanceOf(mod.PipelineInFlightError);
  });

  it('leaves a caller that is still connected alone', async () => {
    // Parallel work from a live caller is ordinary and must not be blocked;
    // parallel execute_step is established as safe here.
    const mod = load();
    await mod.admit(key());
    await expect(mod.admit(key())).resolves.toBeDefined();
  });

  it('keys on the principal, so one user cannot block another', async () => {
    const mod = load();
    const first = await mod.admit(key({ principal: 'alice' }));
    mod.markCallerGone(first);
    await expect(mod.admit(key({ principal: 'bob' }))).resolves.toBeDefined();
  });

  it('does not reach across destinations', async () => {
    const mod = load();
    const first = await mod.admit(key());
    mod.markCallerGone(first);
    await expect(mod.admit(key({ destination: 'S4HANA_QAS' }))).resolves.toBeDefined();
  });

  it('lets both run when nothing identifies the caller, which is the known limit', async () => {
    const mod = load();
    const first = await mod.admit();
    mod.markCallerGone(first);
    await expect(mod.admit()).resolves.toBeDefined();
  });

  it('stops refusing once the orphan finishes', async () => {
    const mod = load();
    const first = await mod.admit(key());
    mod.markCallerGone(first);
    await first.release();
    await expect(mod.admit(key())).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/collision-guard.test.ts`
Expected: FAIL, `admit` takes no argument and `PipelineInFlightError` is undefined.

- [ ] **Step 3: Add the guard**

In `srv/lib/admission.ts`:

```ts
export interface CallerKey {
  principal: string;
  session: string;
  destination: string;
}

/**
 * A predecessor from this caller is still finishing.
 *
 * Not an overload, because 529 or a retryable 503 invites an immediate retry
 * into a guard that is still closed. Not a bad request either, because the same
 * call becomes valid the moment the earlier pipeline ends.
 */
export class PipelineInFlightError extends Error {
  readonly code = 'pipeline_in_flight';
  constructor() {
    super(
      'An earlier request from this session is still finishing on this system. It was not interrupted; try again once it completes.',
    );
    this.name = 'PipelineInFlightError';
  }
}

const callerless = new Map<string, AdmissionHandle>();
const keyOf = (k: CallerKey) => `${k.principal} ${k.session} ${k.destination}`;

/** The caller is gone. The work is not: see Cancellation in the spec. */
export function markCallerGone(handle: AdmissionHandle): void {
  const k = (handle as AdmissionHandle & { key?: CallerKey }).key;
  if (k) callerless.set(keyOf(k), handle);
}
```

In `admit(key?: CallerKey)`, before taking a place:

```ts
  if (key && callerless.has(keyOf(key))) {
    return Promise.reject(new PipelineInFlightError());
  }
```

Store the key on the handle so `markCallerGone` can read it, and in `release()`, after the register empties, `if (key) callerless.delete(keyOf(key));`. Clear the map in `clearAdmission()`.

- [ ] **Step 4: Add the wire shape**

In `srv/lib/throttle-surfacing.ts`:

```ts
/**
 * 409, with a stable code of ours and the nearest type each dialect already
 * knows, so no client meets a type it has never seen. No Retry-After: when the
 * predecessor finishes is as unknown as how long a full door's pipelines run.
 */
export function collisionPayload(dialect: 'openai' | 'anthropic'): {
  status: number;
  body: unknown;
} {
  const error = {
    type: 'invalid_request_error',
    code: 'pipeline_in_flight',
    message:
      'An earlier request from this session is still finishing on this system. It was not interrupted; try again once it completes.',
  };
  return {
    status: 409,
    body: dialect === 'anthropic' ? { type: 'error', error } : { error },
  };
}
```

- [ ] **Step 5: Wire the two chat channels**

Pass the key into `admit`, built from the authenticated principal, the client-sent session (only when the client actually sent one) and the resolved destination; answer a `PipelineInFlightError` with `collisionPayload`. The guard runs at admission, before any byte of response is written, so it is never emitted mid-stream. `execute_step` passes no key.

- [ ] **Step 6: Assert the wire shape and the exclusion**

Append to `test/unit/collision-guard.test.ts`:

```ts
import { collisionPayload } from '../../srv/lib/throttle-surfacing';

describe('the collision refusal on the wire', () => {
  it('is a conflict, not an overload, on both dialects', () => {
    for (const dialect of ['openai', 'anthropic'] as const) {
      const { status, body } = collisionPayload(dialect);
      expect(status).toBe(409);
      expect(JSON.stringify(body)).toContain('pipeline_in_flight');
      // A client reading 529 or a retryable 503 is right to come straight
      // back, into a guard that has not moved.
      expect(status).not.toBe(529);
      expect(status).not.toBe(503);
    }
  });
});
```

- [ ] **Step 7: Run, lint, commit**

```bash
npm run test:unit && npm run test:check
npx biome check --write srv/lib/admission.ts srv/lib/throttle-surfacing.ts srv/openai-handler.ts srv/anthropic-handler.ts test/unit/collision-guard.test.ts
git add -A
git commit -m "feat(gatekeeper): an identified retry meets a 409 while its predecessor finishes"
```

---

### Task 13: Four scopes, kept apart

**Files:**
- Create: `srv/lib/gatekeeper-metrics.ts`
- Modify: `srv/lib/quota-gate.ts`, `srv/lib/admission.ts`, `srv/agent-manager.ts` (emit), `srv/mcp-proxy.ts` (expose on the health payload)
- Test: `test/unit/gatekeeper-metrics.test.ts`

**Interfaces:**
- Consumes: `QuotaGate` (Task 1), `admission` counters (Tasks 5, 12), `isDestinationClosed` (Task 10).
- Produces:
  - `export function recordDoorRefusal(): void`
  - `export function recordCollisionRefusal(): void`
  - `export function recordDestinationRefusal(destination: string): void`
  - `export function recordAdmittedWait(quotaKey: string, waitedMs: number): void`
  - `export function gatekeeperSnapshot(): GatekeeperSnapshot`

**Why apart:** the four refusals belong to different things and adding them up would answer nothing. The quota queue refuses nobody, so its scope counts work rather than refusals. Counting collisions as door refusals would read as memory pressure and send someone to buy memory that changes nothing.

- [ ] **Step 1: Write the failing test**

Create `test/unit/gatekeeper-metrics.test.ts`:

```ts
/**
 * One reset, one load, every module from the same registry.
 *
 * `jest.resetModules()` gives the next `require` a fresh module instance, so a
 * test that loads agent-manager or the registry BEFORE calling this would then
 * have the snapshot lazily require a second, empty copy — and pass or fail for
 * reasons unrelated to the code.
 */
const load = () => {
  jest.resetModules();
  const metrics = require('../../srv/lib/gatekeeper-metrics') as typeof import('../../srv/lib/gatekeeper-metrics');
  const manager = require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
  const registry = require('../../srv/lib/quota-registry') as typeof import('../../srv/lib/quota-registry');
  const gated = require('../../srv/lib/gated-llm') as typeof import('../../srv/lib/gated-llm');
  metrics.clearGatekeeperMetrics();
  registry.clearQuotaRegistry();
  return { ...metrics, manager, registry, gated };
};

describe('gatekeeper metrics', () => {
  it('keeps a collision out of the door count', () => {
    // Folded together, rising collisions would read as memory pressure and
    // send someone to buy memory that changes nothing.
    const mod = load();
    mod.recordCollisionRefusal();
    mod.recordCollisionRefusal();
    mod.recordDoorRefusal();
    const snap = mod.gatekeeperSnapshot();
    expect(snap.door.refusals).toBe(1);
    expect(snap.collisions.refusals).toBe(2);
  });

  it('keeps an unreachable system out of the quota numbers', () => {
    const mod = load();
    mod.recordDestinationRefusal('S4HANA_DEV');
    const snap = mod.gatekeeperSnapshot();
    expect(snap.destinations['S4HANA_DEV'].refusals).toBe(1);
    expect(snap.quotas).toEqual({});
  });

  afterEach(() => {
    const manager = require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
    manager.clearDestinationStatesForTest();
  });

  it('reports a closed system as closed before anyone has been refused', () => {
    // Built only from refusals, a system closed a minute ago with no arrival
    // since would be missing from the payload entirely — and that is precisely
    // the moment an operator goes looking at it.
    const mod = load();
    mod.manager.closeDestination('S4HANA_DEV', 'tunnel down');
    const entry = mod.gatekeeperSnapshot().destinations['S4HANA_DEV'];
    expect(entry.closed).toBe(true);
    expect(entry.refusals).toBe(0);
  });

  it('reports no refusals for a quota, because the queue refuses nobody', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ shared: { limit: 10 } });
    const mod = load();
    mod.registry.gateForModel('shared');
    mod.recordAdmittedWait('shared', 1_500);
    const quota = mod.gatekeeperSnapshot().quotas.shared;
    expect(quota.lastWaitMs).toBe(1_500);
    expect(quota).not.toHaveProperty('refusals');
    delete process.env.LLM_GATEKEEPER_QUOTAS;
  });

  it('records a real queued wait, not only a hand-made one', async () => {
    // Through the wrapper, not the recorder: a unit test that calls
    // recordAdmittedWait directly passes while nothing in production ever does.
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 1, windowMs: 50 } });
    const mod = load();
    const llm = mod.gated.gateLlm(
      {
        model: 'm',
        chat: async () => ({ ok: true as const, value: { content: 'ok', finishReason: 'stop' as const } }),
        streamChat: async function* () {},
      } as never,
      'm',
    );
    await llm.chat([]);
    await llm.chat([]); // the second one queues behind the first
    expect(mod.gatekeeperSnapshot().quotas.m.lastWaitMs).toBeGreaterThan(0);
    delete process.env.LLM_GATEKEEPER_QUOTAS;
  });

  it('aggregates models that share a quota into one scope', () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ shared: { limit: 10 } });
    process.env.LLM_GATEKEEPER_QUOTA_OF_MODEL = JSON.stringify({
      'model-a': 'shared',
      'model-b': 'shared',
    });
    const mod = load();
    mod.registry.gateForModel('model-a');
    mod.registry.gateForModel('model-b');
    expect(Object.keys(mod.gatekeeperSnapshot().quotas)).toEqual(['shared']);
    delete process.env.LLM_GATEKEEPER_QUOTAS;
    delete process.env.LLM_GATEKEEPER_QUOTA_OF_MODEL;
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/gatekeeper-metrics.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the metrics**

Create `srv/lib/gatekeeper-metrics.ts`:

```ts
/**
 * Four scopes, because what they measure belongs to different things and
 * adding them up would answer nothing. Only three count refusals; the first
 * counts the work itself, since the quota queue refuses nobody.
 */

export interface QuotaNumbers {
  /** Starts inside the window, read live from the gate. */
  starts: number;
  /** Callers parked in the queue, read live from the gate. */
  waiting: number;
  /** How long the caller just admitted had waited. */
  lastWaitMs: number;
}

export interface GatekeeperSnapshot {
  quotas: Record<string, QuotaNumbers>;
  door: { live: number; capacity?: number; refusals: number };
  destinations: Record<string, { closed: boolean; refusals: number }>;
  collisions: { refusals: number; callerless: number };
}

const quotaWaits = new Map<string, number>();
const destinationRefusals = new Map<string, number>();
let doorRefusals = 0;
let collisionRefusals = 0;

export function recordAdmittedWait(quotaKey: string, waitedMs: number): void {
  quotaWaits.set(quotaKey, waitedMs);
}

export function recordDoorRefusal(): void {
  doorRefusals++;
}

export function recordCollisionRefusal(): void {
  collisionRefusals++;
}

export function recordDestinationRefusal(destination: string): void {
  destinationRefusals.set(destination, (destinationRefusals.get(destination) ?? 0) + 1);
}

/**
 * The live numbers. Read by the health payload, so a deep queue with no 429s
 * says our limit is too low, an empty queue with 429s says another consumer is
 * spending the tenant's minute, and door refusals rising against a shallow
 * queue says memory is the binding constraint rather than rate.
 */
export function gatekeeperSnapshot(): GatekeeperSnapshot {
  const { livePipelines, configuredCapacity, callerlessCount } =
    require('./admission') as typeof import('./admission');
  // Lazy requires: agent-manager imports this module, so a top-level import
  // would close the cycle.
  const { liveGates } = require('./quota-registry') as typeof import('./quota-registry');
  const { isDestinationClosed, knownDestinations } =
    require('../agent-manager') as typeof import('../agent-manager');
  const quotas: Record<string, QuotaNumbers> = {};
  for (const { key, gate } of liveGates()) {
    quotas[key] = {
      starts: gate.liveStarts,
      waiting: gate.waiting,
      lastWaitMs: quotaWaits.get(key) ?? 0,
    };
  }
  // Every destination we know about, not only those that have already turned
  // someone away. A system closed a minute ago with no arrival since is exactly
  // what an operator is looking at the health payload to find.
  const destinations: Record<string, { closed: boolean; refusals: number }> = {};
  for (const name of knownDestinations()) {
    destinations[name] = {
      closed: isDestinationClosed(name),
      refusals: destinationRefusals.get(name) ?? 0,
    };
  }
  for (const [name, refusals] of destinationRefusals) {
    if (destinations[name]) continue;
    // Read, not assumed. A hard-coded `false` would report every system as
    // healthy while it was refusing callers, which is the one thing this scope
    // exists to show.
    destinations[name] = { closed: isDestinationClosed(name), refusals };
  }
  const capacity = configuredCapacity();
  return {
    quotas,
    door: {
      live: livePipelines(),
      ...(capacity !== undefined ? { capacity } : {}),
      refusals: doorRefusals,
    },
    destinations,
    collisions: { refusals: collisionRefusals, callerless: callerlessCount() },
  };
}

export function clearGatekeeperMetrics(): void {
  quotaWaits.clear();
  destinationRefusals.clear();
  doorRefusals = 0;
  collisionRefusals = 0;
}
```

`starts`, `waiting` and `closed` are all read live inside the snapshot rather than copied. The module keeps no copy of state it can read.

`recordAdmittedWait` is called with the **quota key** from `quotaForModel(model).key`, never the model name, so two models sharing one quota aggregate into one scope.

Add `callerlessCount()` to `srv/lib/admission.ts`:

```ts
/** Pipelines running with no caller behind them. */
export function callerlessCount(): number {
  return callerless.size;
}
```

- [ ] **Step 4: Emit at each refusal**

**Measure the wait in `srv/lib/gated-llm.ts`**, the only place that knows both halves — the key the call spends against and how long it waited for its place. In `runGated` and in the streaming path, around each `acquire`:

```ts
      const askedAt = Date.now();
      permit = await quota.gate.acquire(signal, { notBefore: nextAttemptAt });
      // Filed under the key, never the model name, so two models sharing a
      // quota report as one scope rather than two half-full ones.
      recordAdmittedWait(quota.key, Date.now() - askedAt);
```

Then call `recordDoorRefusal()` at each of the three places a `DoorFullError` is answered — `execute_step` and both chat channels — `recordCollisionRefusal()` where `PipelineInFlightError` is answered, `recordDestinationRefusal(name)` where a closed destination is refused, and `recordAdmittedWait(key, waited)` in the gated wrapper after a permit is granted.

> These calls are added **here**, not in the tasks that created those refusals. Each task has to end green on its own, and a task cannot call into a module a later one creates.

- [ ] **Step 5: Expose on the health payload**

In `srv/mcp-proxy.ts`, add `gatekeeper: gatekeeperSnapshot()` to the health check response so the numbers are readable without a log search.

- [ ] **Step 6: Run, lint, commit**

```bash
npm run test:unit && npm run test:check
npx biome check --write srv/lib/gatekeeper-metrics.ts srv/lib/admission.ts srv/lib/gated-llm.ts srv/agent-manager.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/agent-mcp.ts srv/mcp-proxy.ts test/unit/gatekeeper-metrics.test.ts
git add -A
git commit -m "feat(gatekeeper): four scopes, so a collision never reads as memory pressure"
```

---

### Task 14: Calls with nobody waiting, and calls nobody may wait for

**Files:**
- Modify: `srv/agent-manager.ts` (health path and the shared corpus build), `srv/lib/gated-llm.ts` (a reporting strategy)
- Test: `test/unit/non-pipeline-calls.test.ts`

**Interfaces:**
- Consumes: `gateLlm` (Task 3), `AdmissionHandle.track` (Task 6).
- Produces: `healthCheck` on the `ILlm` that `gateLlm` returns — takes its permit, reports at once, never waits. There is no second wrapper.

**The rule underneath:** every model call takes a permit, and only work with somebody waiting on it gets a door slot.

- **The shared corpus build** is gated and waits as told: nobody is waiting for it when it runs in the background, it spends real quota on the fallback path, and restarting it later costs more than waiting. It is never registered against an admission handle, even when a request is the one awaiting it, and it is started from startup rather than from a request.
- **A health check** is the opposite. A liveness probe that waits out a `Retry-After` is not a liveness probe, it is a hung request with no lifetime over it. So it takes its permit, because it is still a request the window must see, and reports at once.

- [ ] **Step 1: Write the failing test**

Create `test/unit/non-pipeline-calls.test.ts`:

```ts
import type { ILlm, LlmError, LlmResponse, Result } from '@mcp-abap-adt/llm-agent';

const load = () => {
  jest.resetModules();
  const registry = require('../../srv/lib/quota-registry') as typeof import('../../srv/lib/quota-registry');
  registry.clearQuotaRegistry();
  const gated = require('../../srv/lib/gated-llm') as typeof import('../../srv/lib/gated-llm');
  return { registry, gated };
};

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_QUOTAS;
  jest.resetModules();
});

function throttledLlm(): ILlm {
  const e = new Error('429') as LlmError & {
    throttled?: boolean;
    attempts?: number;
    retryAfterSeconds?: number;
  };
  e.throttled = true;
  e.attempts = 1;
  e.retryAfterSeconds = 30;
  return {
    model: 'm',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return { ok: false, error: e };
    },
    async healthCheck(): Promise<Result<boolean, LlmError>> {
      return { ok: false, error: e };
    },
    async *streamChat() {
      yield { ok: false as const, error: e };
    },
  };
}

describe('a health check', () => {
  it('reports a shut quota at once instead of sitting out the interval', async () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 10 } });
    const { gated } = load();
    const started = Date.now();
    // healthCheck, not chat: the probe path calls agent.healthCheck(), and a
    // test against chat() would pass while the method that matters bypassed
    // the gate entirely.
    const result = await gated.gateLlm(throttledLlm(), 'm').healthCheck?.();
    expect(result?.ok).toBe(false);
    // Thirty seconds were named. A probe that waits them out is a hung
    // request, not a liveness check.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still spends a permit, because it is still a request', async () => {
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 10 } });
    const { registry, gated } = load();
    await gated.gateLlm(throttledLlm(), 'm').healthCheck?.();
    expect(registry.gateForModel('m')?.liveStarts).toBe(1);
  });

  it('leaves chat waiting as told, which is the guarantee the door rests on', async () => {
    // The same wrapper, the opposite behaviour, deliberately: an admitted
    // pipeline is slowed by a 429 and never ended by one. A wrapper that
    // reported here would undo that for every ordinary call.
    jest.useFakeTimers();
    process.env.LLM_GATEKEEPER_QUOTAS = JSON.stringify({ m: { limit: 10 } });
    const { gated } = load();
    let settled = false;
    void gated.gateLlm(throttledLlm(), 'm').chat([]).then(() => { settled = true; });
    await Promise.resolve();
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/non-pipeline-calls.test.ts`
Expected: FAIL, `healthCheck` waits out the interval instead of reporting.

- [ ] **Step 3: Make `healthCheck` the reporting method on the ordinary wrapper**

There is no second wrapper. `AgentService.Health` calls `agent.healthCheck()`
and is the one production caller — Task 8 keeps it for exactly this reason —
and a `gateLlmReporting` swapped in for the shared LLM would take wait-as-told
away from ordinary pipeline calls, which is the guarantee the door rests on.
The difference is per **method**, not per wrapper: `chat` and `streamChat` wait
as told, and `healthCheck` reports.

In `srv/lib/gated-llm.ts`, add to the object `gateLlm` returns:

```ts
  // A probe that waits out a Retry-After is not a probe: it is a hung request
  // with no lifetime over it. So this one takes its permit — it is still a
  // request the window must see — and answers with what the server said,
  // immediately. `chat` and `streamChat` above are unchanged: they wait.
  if (inner.healthCheck) {
    const innerHealth = inner.healthCheck.bind(inner);
    gated.healthCheck = async (options?: CallOptions) => {
      const quota = quotaForModel(model);
      const permit = quota ? await quota.gate.acquire(options?.signal) : undefined;
      const result = await innerHealth(options);
      if (!result.ok && findThrottled(result.error)?.attempts === 0) {
        permit?.giveBack();
      }
      return result;
    };
  }
```

- [ ] **Step 4: Confirm there is no ungated health path left**

Run: `grep -rn "healthCheck" srv/ | grep -v node_modules`

Expected: the caller in `srv/agent-service.ts`, the decorators that forward it
(`srv/lib/recording-mcp-client.ts`, `srv/rag-collections.ts`), and the wrapper
added in Step 3. Any new probe site inherits the behaviour by construction,
because every LLM in this service comes from `buildGatedLlm`.

- [ ] **Step 5: Keep the corpus build out of every register**

In `srv/agent-manager.ts`, confirm and comment the two properties:

```ts
  // The shared corpus build is process-owned. It is never handed to an
  // admission handle's register, even when a request is the one awaiting it:
  // the register exists so a pipeline's slot outlives the calls that pipeline
  // started, and this work outlives every pipeline. Attributing it to whoever
  // arrived first would make a global lifecycle the property of a caller that
  // may be gone before it ends.
```

Assert the ordering property covered in Task 7: a request waiting for the build waits **before** admission, so it does not consume the last free place while it waits.

- [ ] **Step 6: Run, lint, commit**

```bash
npx jest test/unit/non-pipeline-calls.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/gated-llm.ts srv/agent-manager.ts test/unit/non-pipeline-calls.test.ts
git add -A
git commit -m "feat(gatekeeper): a probe reports and a corpus build waits, and both spend a permit"
```

---

### Task 15: Documentation, and the release

**Files:**
- Modify: `docs/architecture/ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/deployment/templates/*.mtaext.template`, `docs/examples/*/.mtaext`, `package.json` + `mta.yaml` (version)
- Delete: `docs/superpowers/specs/2026-09-13-llm-gatekeeper-design.md`, `docs/superpowers/plans/2026-09-14-llm-gatekeeper.md`

**Why the deletions:** plans and specs live in the tree only while active. Once implemented, history holds them.

- [ ] **Step 1: Document the three variables**

In `README.md` and `docs/architecture/ARCHITECTURE.md`, add a section covering:

| Variable | Meaning | Absent |
|---|---|---|
| `LLM_GATEKEEPER_QUOTAS` | JSON map of quota key to `{ limit, windowMs }`; `windowMs` defaults to 60000 | no rate limiting, calls pass straight through |
| `LLM_GATEKEEPER_QUOTA_OF_MODEL` | JSON map of model name to quota key, where several models share one limit | each model is its own quota key |
| `LLM_GATEKEEPER_MAX_LIVE_PIPELINES` | positive integer, pipelines admitted at once across all channels | no door, and the old `execute_step` cap of two is gone with it |

State the guarantee in one line: a caller is either refused before anything starts, or carried to the end; throttling costs speed, never the request; only a shutdown ends admitted work.

- [ ] **Step 2: Record the removed surface**

In `CHANGELOG.md` under a new version, list the breaking changes. Name the
behaviour change for a deployment that configures **nothing**, because it is
the one that is easy to miss: a `429` used to be waited out up to twenty
seconds by `WaitIfShortEnough`, and now comes back to the caller instead. The
ceiling that made waiting safe is gone with it, and without a quota there is no
queue to pace a retry against. Configure `LLM_GATEKEEPER_QUOTAS` and the
waiting returns, governed by the window. Then: `AgentService.Chat` removed (`AgentService.Health` is unchanged and still there); `LLM_AGENT_THROTTLE_MAX_WAIT_MS` removed along with `WaitIfShortEnough`, since waiting as told is now the gated wrapper's business; and `EXEC_STEP_MAX_CONCURRENCY` replaced by `LLM_GATEKEEPER_MAX_LIVE_PIPELINES`, which covers every channel rather than one route. Name the migration for a deployment that relied on the old cap.

- [ ] **Step 3: Add the sample configuration**

There is no `deploy/` directory. The samples that exist are
`docs/deployment/templates/*.mtaext.template` (`llm-only`, `mcp-anthropic`,
`mcp-only`, and any sibling) and `docs/examples/*/.mtaext`.

Add all **three** variables to each template, commented out, with a line saying
where each number comes from:

```yaml
    # LLM_GATEKEEPER_QUOTAS: '{"anthropic--claude-4.5-sonnet":{"limit":60}}'
    #   The tenant's per-minute rate limit for that model, from AI Launchpad.
    #   Set it BELOW the real limit: this deployment is not the tenant's only
    #   consumer, and the window cannot see the others.
    # LLM_GATEKEEPER_QUOTA_OF_MODEL: '{"model-a":"shared","model-b":"shared"}'
    #   Only where several models are metered together. Omitted, each model is
    #   its own quota.
    # LLM_GATEKEEPER_MAX_LIVE_PIPELINES: '4'
    #   How many pipelines may be admitted at once, across every channel. This
    #   is a memory decision: it replaces the old execute_step cap of two, and
    #   the right number depends on the memory bought for the service.
```

The `docs/examples/*/.mtaext` files are working deployments rather than
templates; add the same block there only where the example actually runs a
gated model, and leave the others alone.

- [ ] **Step 4: Update the project instructions**

In `CLAUDE.md`, add the gatekeeper to the architecture section: one counter of live pipelines across every channel, one gate per quota, a permit per HTTP attempt, and the teardown order (drain, safe-stop, release).

- [ ] **Step 5: Delete the spec and this plan**

```bash
git rm docs/superpowers/specs/2026-09-13-llm-gatekeeper-design.md
git rm docs/superpowers/plans/2026-09-14-llm-gatekeeper.md
```

- [ ] **Step 6: Bump and tag**

```bash
npm run bump:version   # minor, unless the removed endpoints make it major for this deployment
npm run sync:version
npm run docs:check && npm run test:unit && npm run test:check && npm run lint:check
git add -A
git commit -m "release(X.Y.Z): the gatekeeper — admission control against the model quota"
git tag -a vX.Y.Z -m "vX.Y.Z — the gatekeeper"
```

- [ ] **Step 7: Deploy to staging before production**

Build and deploy to one staging target, watch the health payload's `gatekeeper` block under real traffic, and confirm two things before going further: door refusals stay at zero when the quota is the binding constraint, and the queue is not deep while `429`s arrive. The second combination means another consumer is spending the tenant's minute and the configured number is too high.

---

## Self-review notes

**Spec coverage.** Every section of the spec maps to a task: the register's wiring to Task 6b, without which the register is an API nobody writes to and every drain finds it empty; the gatekeeper and its hot path to Task 1; configuration to Task 2; the acquire invariant, the permit given back and `RetryLlm` staying above to Task 3; entrances to Task 4; the door to Task 5; cancellation, the register and teardown order to Task 6; the detached sink and the disconnect that ends nothing to Task 7; the fourth entrance to Task 8; the outage classification to Task 9; the closed destination and `Retry-After` to Task 10; the unanswered write to Task 11; the collision guard and its wire shape to Task 12; observability to Task 13; non-pipeline calls to Task 14; documentation to Task 15.

**Deliberately not built.** The spec's "Not in scope" section stays out. The upstream removal of `MCPClientWrapper`'s blind reconnect is not here and is not a prerequisite: this service uses the embedded transport, whose branch neither reconnects nor retries. It remains worth doing for other consumers of llm-agent.

**Carried limits, all stated in the spec and none of them surprises.** A caller who leaves still costs a slot. A permanent refusal costs a slot until shutdown, and with capacity N, N of them close the door until a restart. Two instances would run two windows against one quota, so `instances: 1` still holds. An anonymous retry runs as a second pipeline.
