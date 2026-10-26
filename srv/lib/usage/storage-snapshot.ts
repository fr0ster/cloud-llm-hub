export interface UsageSession {
  userId: string;
  sessionId: string;
  destination?: string;
}
export interface StorageSnapshot {
  storageSnapshotAt: number;
  [measure: string]: number | boolean;
}
export function unknownStorageSnapshot(): StorageSnapshot {
  return {
    storageSnapshotAt: Date.now(),
    stateBytesUnknown: true,
    outboxBytesUnknown: true,
    historyBytesUnknown: true,
    sessionCollectionDocumentsUnknown: true,
    sessionCollectionTextBytesUnknown: true,
    sessionCollectionVectorBytesUnknown: true,
  };
}
export interface StorageSnapshots {
  trackUser?(userId: string, eligible: boolean): void;
  invalidateDialogue?(id: string): void;
  update?(
    session: UsageSession,
    values: Record<string, number | boolean>,
  ): void;
  retain?(session: UsageSession): void;
  release?(session: UsageSession): void;
  measure(session: UsageSession): Promise<StorageSnapshot | undefined>;
  cached(session: UsageSession): StorageSnapshot | undefined;
}
const empty: StorageSnapshots = {
  async measure(): Promise<undefined> {
    return undefined;
  },
  cached(): undefined {
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
