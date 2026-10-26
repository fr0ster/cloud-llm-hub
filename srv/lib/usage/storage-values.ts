import { usageRuntime } from './runtime-state';

export interface StorageSnapshotValues {
  stateBytes?: number;
  stateBytesUnknown?: boolean;
  outboxBytes?: number;
  outboxBytesUnknown?: boolean;
  historyBytes?: number;
  historyBytesUnknown?: boolean;
  sessionCollectionDocuments?: number;
  sessionCollectionDocumentsUnknown?: boolean;
  sessionCollectionTextBytes?: number;
  sessionCollectionTextBytesUnknown?: boolean;
  sessionCollectionVectorBytes?: number;
  sessionCollectionVectorBytesUnknown?: boolean;
  userCollectionDocuments?: number;
  userCollectionDocumentsUnknown?: boolean;
  userCollectionTextBytes?: number;
  userCollectionTextBytesUnknown?: boolean;
  userCollectionVectorBytes?: number;
  userCollectionVectorBytesUnknown?: boolean;
}
export type StorageValues = StorageSnapshotValues &
  Record<string, number | boolean>;

export function storageEnabled(): boolean {
  return usageRuntime()?.enabled('storage') ?? false;
}

/** Write-time counters are optional: pre-existing payloads remain unknown. */
export interface DialogueBytes {
  stateBytes: number;
  outboxBytes: number;
}

export function collectionUnknown(prefix: string): StorageValues {
  return {
    [`${prefix}DocumentsUnknown`]: true,
    [`${prefix}TextBytesUnknown`]: true,
    [`${prefix}VectorBytesUnknown`]: true,
  };
}
