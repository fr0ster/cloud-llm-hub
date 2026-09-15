import { AsyncLocalStorage } from 'node:async_hooks';

/** What a dispatched call needs from the admission it runs under. */
export interface CallRegister {
  track<T>(p: Promise<T>): Promise<T>;
}

const als = new AsyncLocalStorage<CallRegister>();

/** Run a pipeline so that every call it dispatches registers against `register`. */
export function runWithAdmission<T>(register: CallRegister, fn: () => T): T {
  return als.run(register, fn);
}

/** The register in scope, or nothing — the correct answer for process-owned work. */
export function currentAdmission(): CallRegister | undefined {
  return als.getStore();
}

/** Register `p` against the admission in scope, if any, and return it. */
export function trackCall<T>(p: Promise<T>): Promise<T> {
  return currentAdmission()?.track(p) ?? p;
}

/**
 * Run `fn` outside any admission scope, even when called from inside one.
 *
 * For process-owned work that a request may happen to start — the shared tool
 * corpus build, a destination's first initialisation. Started inside a scope,
 * AsyncLocalStorage would hand that request's register to the whole
 * single-flight chain, and the caller's slot would wait on a build it does not
 * own.
 */
export function runOutsideAdmission<T>(fn: () => T): T {
  return als.exit(fn);
}

/** A register that can say when everything it holds has settled. */
export interface DrainableRegister extends CallRegister {
  readonly outstanding: number;
  drain(): Promise<void>;
}

export function createCallRegister(): DrainableRegister {
  const inFlight = new Set<Promise<unknown>>();
  let drainers: Array<() => void> = [];
  const settle = (p: Promise<unknown>) => {
    inFlight.delete(p);
    if (inFlight.size > 0) return;
    const waiting = drainers;
    drainers = [];
    for (const d of waiting) d();
  };
  return {
    get outstanding() {
      return inFlight.size;
    },
    track<T>(p: Promise<T>): Promise<T> {
      inFlight.add(p);
      p.then(
        () => settle(p),
        () => settle(p),
      );
      return p;
    },
    drain: () =>
      inFlight.size === 0
        ? Promise.resolve()
        : new Promise<void>((r) => {
            drainers.push(r);
          }),
  };
}
