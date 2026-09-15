/**
 * The gatekeeper's configuration: read from the environment, validated, and
 * holding nothing that changes at runtime.
 *
 * Absent means off. Malformed means refuse to start, naming the variable:
 * somebody intending a limit and not getting one is the failure this design
 * exists to make visible. The precedent is `LLM_AGENT_THROTTLE_MAX_WAIT_MS`.
 */

const LIVE = 'LLM_GATEKEEPER_MAX_LIVE_SESSIONS';
const QUEUE = 'LLM_GATEKEEPER_QUEUE_LENGTH';
const RETAINED = 'LLM_GATEKEEPER_MAX_RETAINED_SESSIONS';

export interface GatekeeperConfig {
  /** Sessions that may be live at once, across every channel. Absent: no door. */
  maxLiveSessions?: number;
  /** Callers that may wait to be admitted. The capacity when a capacity is set. */
  queueLength?: number;
  /** Sessions that may hold state. Absent: unbounded. */
  maxRetainedSessions?: number;
}

function readPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  // Digits and nothing else. `Number()` alone reads "0x10" as sixteen, "1e3" as
  // a thousand and " 5" as five: a limit configured by accident is the failure
  // refusing to start exists to prevent.
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `Invalid ${name}: expected a positive whole number, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export function loadGatekeeperConfig(): GatekeeperConfig {
  const maxLiveSessions = readPositiveInt(LIVE);
  const queue = readPositiveInt(QUEUE);
  const maxRetainedSessions = readPositiveInt(RETAINED);

  if (queue !== undefined && maxLiveSessions === undefined) {
    // A queue waits for a slot. With no door there is no slot and nothing to
    // wait for, so the setting would do nothing while looking like a limit.
    throw new Error(
      `Invalid ${QUEUE}: a queue needs a door in front of it. Set ${LIVE} as well, or unset ${QUEUE}.`,
    );
  }

  if (maxRetainedSessions !== undefined) {
    if (maxLiveSessions === undefined) {
      // With chat concurrency unbounded, any number of sessions can be live at
      // once and none of them may be evicted, so the cap would be exceeded by
      // sessions the design forbids touching.
      throw new Error(
        `Invalid ${RETAINED}: retention cannot be bounded without bounding how many sessions run. Set ${LIVE} as well, or unset ${RETAINED}.`,
      );
    }
    if (maxRetainedSessions < maxLiveSessions) {
      // Five slots and room for two histories has no correct behaviour: the
      // third admitted session would need a place while none is idle.
      throw new Error(
        `Invalid ${RETAINED}: ${maxRetainedSessions} is smaller than ${LIVE}=${maxLiveSessions}. You cannot retain fewer sessions than you can run at once.`,
      );
    }
  }

  return {
    maxLiveSessions,
    queueLength:
      maxLiveSessions === undefined ? undefined : (queue ?? maxLiveSessions),
    maxRetainedSessions,
  };
}

let cached: GatekeeperConfig | undefined;

export function gatekeeperConfig(): GatekeeperConfig {
  if (!cached) cached = loadGatekeeperConfig();
  return cached;
}

/** For the startup log. A limit only shows itself under load, and by then nobody remembers what was set. */
export function describeGatekeeperConfig(
  cfg: GatekeeperConfig = gatekeeperConfig(),
): Record<string, number | string> {
  return {
    door:
      cfg.maxLiveSessions ?? 'off (execute_step keeps its semaphore of two)',
    queueLength: cfg.queueLength ?? 'none',
    retainedSessions: cfg.maxRetainedSessions ?? 'unbounded',
  };
}

/** Test seam. */
export function clearGatekeeperConfig(): void {
  cached = undefined;
}
