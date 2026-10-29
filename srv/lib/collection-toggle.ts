import type { CollectionMeta, CollectionRegistry } from '../rag-collections';

const overrides = new Map<string, Record<string, boolean>>();
const slot = (userId: string, sessionId: string) =>
  JSON.stringify([userId, sessionId]);

export function sessionCollectionOverrides(
  userId: string,
  sessionId: string,
): Record<string, boolean> | undefined {
  const value = overrides.get(slot(userId, sessionId));
  return value ? { ...value } : undefined;
}
export function restoreCollectionOverrides(
  userId: string,
  sessionId: string,
  value: Record<string, boolean>,
): void {
  overrides.set(slot(userId, sessionId), { ...value });
}
export function setCollectionOverride(
  userId: string,
  sessionId: string,
  id: string,
  enabled: boolean,
): void {
  const key = slot(userId, sessionId);
  overrides.set(key, { ...overrides.get(key), [id]: enabled });
}
export function deleteCollectionOverrides(
  userId: string,
  sessionId: string,
): void {
  overrides.delete(slot(userId, sessionId));
}
export function collectionDefault(
  registry: CollectionRegistry,
  userId: string,
  meta: CollectionMeta,
): boolean {
  return registry.getEnabled(userId, meta.id) ?? !meta.preset;
}
export function collectionEnabled(
  registry: CollectionRegistry,
  userId: string,
  sessionId: string | undefined,
  meta: CollectionMeta,
): boolean {
  return (
    (sessionId
      ? overrides.get(slot(userId, sessionId))?.[meta.id]
      : undefined) ?? collectionDefault(registry, userId, meta)
  );
}

let persist: (userId: string, sessionId: string) => Promise<void> =
  async () => {};
export function configureCollectionOverridePersistence(
  writer: (userId: string, sessionId: string) => Promise<void>,
): void {
  persist = writer;
}
export function persistCollectionOverrides(
  userId: string,
  sessionId: string,
): Promise<void> {
  return persist(userId, sessionId);
}
export function hasCollectionOverrides(
  userId: string,
  sessionId: string,
): boolean {
  return overrides.has(slot(userId, sessionId));
}
