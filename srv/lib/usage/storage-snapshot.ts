/** Task 4 supplies fresh measurements and keeps the latest snapshot per session. */
export interface UsageSession {
  userId: string;
  sessionId: string;
  destination?: string;
}
export interface StorageSnapshot {
  storageSnapshotAt: number;
  [measure: string]: number | boolean;
}
export interface StorageSnapshots {
  measure(session: UsageSession): Promise<StorageSnapshot | undefined>;
  cached(session: UsageSession): StorageSnapshot | undefined;
}
const empty: StorageSnapshots = {
  async measure() {
    return undefined;
  },
  cached() {
    return undefined;
  },
};
let snapshots: StorageSnapshots = empty;
export function storageSnapshots(): StorageSnapshots {
  return snapshots;
}
export function setStorageSnapshots(provider: StorageSnapshots = empty): void {
  snapshots = provider;
}
