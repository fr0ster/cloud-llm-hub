/**
 * The direct (`x-sap-url`) connectors, as the hub builds them: connection 10's
 * `AdtOnPremConnector` / `AdtCloudConnector`, plus one guarantee the base
 * classes do not give — **teardown never cuts LOCK..UNLOCK**.
 *
 * connection 10's `disconnect()` closes admission and moves the generation at
 * once (`beginTeardown`), whatever the connection is doing. Called from a
 * client-abort listener in the middle of a write chain, it would refuse the
 * chain's next request (UNLOCK, activate) and log the session off, leaving the
 * object locked. A client disconnect ends nothing here: `endSession()` first
 * waits for the critical section (`beginCriticalSection` …
 * `endCriticalSection`, which lib enters around every lock) to end, then
 * disconnects. No deadline on the wait — the write in between is short, and
 * cutting it is exactly what this prevents. `CloudSdkAbapConnection.closeSession`
 * keeps the same rule for destination connections.
 */

import type {
  BasicAuthProvider,
  TokenAuthProvider,
} from '@mcp-abap-adt/auth-providers';
import {
  AdtCloudConnector,
  AdtOnPremConnector,
  type CloudHttpTransport,
  type OnPremHttpTransport,
} from '@mcp-abap-adt/connection';

export type DirectCredential = BasicAuthProvider | TokenAuthProvider;

/** Resolves when no critical section is open; re-entrant like the base count. */
class CriticalSectionGate {
  private depth = 0;
  private ended: Promise<void> | null = null;
  private release: (() => void) | null = null;

  enter(): void {
    if (this.depth === 0) {
      this.ended = new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    this.depth++;
  }

  leave(): void {
    if (this.depth > 0) this.depth--;
    if (this.depth === 0 && this.release) {
      const release = this.release;
      this.ended = null;
      this.release = null;
      release();
    }
  }

  /** Resolves when the section open now ends; null when none is open. */
  get openSection(): Promise<void> | null {
    return this.ended;
  }
}

/**
 * Wait until no section is open, then start the teardown IN THE SAME
 * synchronous step as the last check: `disconnect()` closes admission at its
 * call, so no handler can open a section between "none open" and "teardown
 * started". A section opened while we wait is waited for too.
 */
async function endAfterSections(
  gate: CriticalSectionGate,
  teardown: () => Promise<void>,
): Promise<void> {
  for (let open = gate.openSection; open; open = gate.openSection) {
    await open;
  }
  return teardown();
}

export class HubOnPremConnector extends AdtOnPremConnector<
  DirectCredential,
  OnPremHttpTransport
> {
  private readonly gate = new CriticalSectionGate();

  override beginCriticalSection(): void {
    super.beginCriticalSection();
    this.gate.enter();
  }

  override endCriticalSection(): void {
    try {
      super.endCriticalSection();
    } finally {
      // Released whatever the base does: a gate left closed would hold the
      // teardown forever.
      this.gate.leave();
    }
  }

  /** Log the session off — after any open critical section has ended. */
  async endSession(): Promise<void> {
    await endAfterSections(this.gate, () => this.disconnect());
  }
}

export class HubCloudConnector extends AdtCloudConnector<
  DirectCredential,
  CloudHttpTransport
> {
  private readonly gate = new CriticalSectionGate();

  override beginCriticalSection(): void {
    super.beginCriticalSection();
    this.gate.enter();
  }

  override endCriticalSection(): void {
    try {
      super.endCriticalSection();
    } finally {
      // Released whatever the base does: a gate left closed would hold the
      // teardown forever.
      this.gate.leave();
    }
  }

  /** Log the session off — after any open critical section has ended. */
  async endSession(): Promise<void> {
    await endAfterSections(this.gate, () => this.disconnect());
  }
}
