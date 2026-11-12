import { AsyncLocalStorage } from 'node:async_hooks';
export type WriteScope =
  | { origin: 'tool' }
  | { origin: 'rest'; userId: string; admin: boolean };
const writes = new AsyncLocalStorage<WriteScope>();

/** Covers indirect registry mutations throughout an awaited MCP/tool call. */
export function withCollectionToolScope<T>(operation: () => T): T {
  return writes.run({ origin: 'tool' }, operation);
}
export function withCollectionRestScope<T>(
  userId: string,
  admin: boolean,
  operation: () => T,
): T {
  return writes.run({ origin: 'rest', userId, admin }, operation);
}

export function collectionWriteScope() {
  return writes.getStore();
}

export interface CollectionWriteTarget {
  id: string;
  collectionKind?: string;
  scope?: string;
  owner?: string;
}
const targets = new AsyncLocalStorage<CollectionWriteTarget>();
/** Keep the resolved catalog entry available to the library write decision. */
export function withCollectionAccessTarget<T>(
  meta: CollectionWriteTarget,
  operation: () => T,
): T {
  return targets.run(meta, operation);
}
export function collectionAccessTarget(
  name: string,
): CollectionWriteTarget | undefined {
  const target = targets.getStore();
  return target?.id === name ? target : undefined;
}
