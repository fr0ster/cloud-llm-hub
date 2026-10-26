import { usageRuntime } from './runtime-state';

export type StorageValues = Record<string, number | boolean>;

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
