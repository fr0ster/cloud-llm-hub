import { getCollectionRegistry } from '../../agent-manager';
import { sessionHistoryBytes } from '../../session-store';
import { getDialogueStoreBackend } from '../dialogue-store';
import { storageAggregates } from './storage-aggregates';

import {
  collectionUnknown,
  type StorageValues,
  storageEnabled,
} from './storage-values';

export {
  type DialogueBytes,
  type StorageValues,
  storageEnabled,
} from './storage-values';

export async function measureSession(
  sessionId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<StorageValues> {
  if (!storageEnabled()) return {};
  const bytes = getDialogueStoreBackend().storageBytes?.(userId, sessionId);
  const historyBytes = await sessionHistoryBytes(userId, sessionId, signal);
  let collections: StorageValues;
  try {
    collections = await measureCollections(userId, sessionId, signal);
  } catch {
    collections = collectionUnknown('sessionCollection');
  }
  return {
    ...(bytes ?? { stateBytesUnknown: true, outboxBytesUnknown: true }),
    ...(historyBytes === undefined
      ? { historyBytesUnknown: true }
      : { historyBytes }),
    ...collections,
  };
}

export async function measureUser(
  userId: string,
  signal?: AbortSignal,
): Promise<StorageValues> {
  if (!storageEnabled()) return {};
  try {
    return await measureCollections(userId, undefined, signal);
  } catch {
    return collectionUnknown('userCollection');
  }
}

async function measureCollections(
  userId: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<StorageValues> {
  const registry = getCollectionRegistry();
  const values = registry.storageMeasures(userId, sessionId);
  const reader = storageAggregates();
  if (!reader) return values;
  const targets = registry.storageTargets(userId, sessionId);
  const first = targets[0];
  if (
    !first ||
    !targets.every(
      (target: { backend: string; store: string }): boolean =>
        target.backend === first.backend,
    )
  )
    return values;
  const prefix =
    sessionId === undefined ? 'userCollection' : 'sessionCollection';
  try {
    const aggregate = await reader.measure(
      first.backend,
      targets.map(
        (target: { backend: string; store: string }): string => target.store,
      ),
      signal,
    );
    if (!aggregate) return values;
    values[`${prefix}Documents`] = aggregate.documents;
    values[`${prefix}VectorBytes`] = aggregate.vectorBytes;
    delete values[`${prefix}DocumentsUnknown`];
    delete values[`${prefix}VectorBytesUnknown`];
    if (aggregate.textBytes !== undefined) {
      values[`${prefix}TextBytes`] = aggregate.textBytes;
      delete values[`${prefix}TextBytesUnknown`];
    }
  } catch {
    // Keep exact logical write counters if the aggregate backend is unavailable.
  }
  return values;
}
