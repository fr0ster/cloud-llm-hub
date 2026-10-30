import { AsyncLocalStorage } from 'node:async_hooks';
import { collectionAccessError } from './collection-access';

type WriteScope =
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

export function assertCollectionWrite(meta: {
  collectionKind?: string;
  scope?: string;
  owner?: string;
}): void {
  if (meta.collectionKind !== 'agents') return;
  const scope = writes.getStore();
  if (scope?.origin === 'tool')
    throw new Error('TOOL_FORBIDDEN: agents configuration is REST-only');
  if (scope?.origin === 'rest') {
    const refusal = collectionAccessError(
      {
        collectionKind: meta.collectionKind,
        scope: meta.scope,
        owner: meta.owner,
      },
      scope.userId,
      scope.admin,
      'write',
    );
    if (refusal) throw new Error(refusal.message);
  }
}
