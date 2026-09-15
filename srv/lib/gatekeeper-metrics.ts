import {
  setThrottleObserver,
  type ThrottleEvent,
} from '@mcp-abap-adt/llm-agent';
import { isDestinationClosed, knownDestinations } from '../agent-manager';
import { collectionRemovalFailureCount } from '../rag-collections';
import type { DoorSnapshot } from './door';
import { theDoor, theRetention } from './gatekeeper';
import type { RetentionSnapshot } from './session-retention';

/**
 * Four scopes, because they answer different questions and adding them up
 * answers none. A closed SAP system counted as a door refusal would look like
 * a full container and send someone to buy memory that changes nothing.
 */
export interface GatekeeperSnapshot {
  door: DoorSnapshot | { configured: false };
  retention: RetentionSnapshot;
  destinations: Array<{ name: string; closed: boolean; refusals: number }>;
  throttling: {
    events: number;
    gaveUp: number;
    /** A server refusal that named no interval: the one case an admitted session cannot survive. */
    noInterval: number;
    byQuota: Record<string, number>;
  };
}

const destinationRefusals = new Map<string, number>();
const throttling = {
  events: 0,
  gaveUp: 0,
  noInterval: 0,
  byQuota: new Map<string, number>(),
};

export function recordDestinationRefusal(destination: string): void {
  destinationRefusals.set(
    destination,
    (destinationRefusals.get(destination) ?? 0) + 1,
  );
}

/** Watch the provider's throttling. Since nothing here tries to stay inside the tenant's limit, this is how anyone would know it binds. */
export function installThrottleObserver(): void {
  setThrottleObserver((e: ThrottleEvent) => {
    throttling.events++;
    if (!e.willRetry) throttling.gaveUp++;
    if (e.source === 'response' && e.retryAfterSeconds === undefined)
      throttling.noInterval++;
    throttling.byQuota.set(e.key, (throttling.byQuota.get(e.key) ?? 0) + 1);
  });
}

/**
 * Retention as Health reports it. A collection removal never throws into
 * retention any more — the registry reports and counts what it could not clear —
 * so those failures are added to the ones retention counted itself.
 */
function retentionScope(): RetentionSnapshot {
  const r = theRetention().snapshot();
  return {
    ...r,
    cleanupFailed: r.cleanupFailed + collectionRemovalFailureCount(),
  };
}

export function gatekeeperSnapshot(): GatekeeperSnapshot {
  const names = new Set([
    ...knownDestinations(),
    ...destinationRefusals.keys(),
  ]);
  return {
    door: theDoor()?.snapshot() ?? { configured: false },
    retention: retentionScope(),
    destinations: [...names].sort().map((name) => ({
      name,
      closed: isDestinationClosed(name),
      refusals: destinationRefusals.get(name) ?? 0,
    })),
    throttling: {
      events: throttling.events,
      gaveUp: throttling.gaveUp,
      noInterval: throttling.noInterval,
      byQuota: Object.fromEntries(throttling.byQuota),
    },
  };
}

/** Test seam. */
export function clearGatekeeperMetrics(): void {
  destinationRefusals.clear();
  throttling.events = 0;
  throttling.gaveUp = 0;
  throttling.noInterval = 0;
  throttling.byQuota.clear();
}
