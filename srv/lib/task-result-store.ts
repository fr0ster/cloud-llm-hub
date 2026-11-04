import type {
  CallOptions,
  ITaskResultStore,
  Result,
  TaskResultRef,
  TaskResultStoreError,
} from '@mcp-abap-adt/llm-agent';
import { sessionCollectionId } from '../collection-ids';
import {
  type CollectionRegistry,
  sessionCollectionTtlMs,
} from '../rag-collections';
import { RagWriteError } from './rag-write-error';

/** Cancellation bounds only the caller's wait; an in-flight backend write may finish. */
async function cancellable<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Task result operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
    const finish = () => signal.removeEventListener('abort', abort);
    const settle = async () => {
      try {
        signal.throwIfAborted();
        resolve(await operation());
      } catch (error) {
        reject(error);
      } finally {
        finish();
      }
    };
    void settle();
  });
}

/** One information collection, owned by exactly one user/session pair. */
export function createTaskResultStore(
  registrySource: CollectionRegistry | (() => CollectionRegistry),
  scope: { userId: string; sessionKey: string },
): ITaskResultStore {
  let resolvedRegistry: CollectionRegistry | undefined;
  const getRegistry = (): CollectionRegistry =>
    (resolvedRegistry ??=
      typeof registrySource === 'function' ? registrySource() : registrySource);
  const logicalId = 'task-results';
  const collectionId = sessionCollectionId(
    logicalId,
    scope.userId,
    scope.sessionKey,
  );
  const ref = (record: string, text: string): TaskResultRef => ({
    collection: logicalId,
    record,
    chars: text.length,
  });
  async function checkScope(registry: CollectionRegistry): Promise<void> {
    if (!scope.userId || scope.userId === 'anonymous' || !scope.sessionKey)
      throw new Error('Task results require an authenticated session');
    const meta = await registry.getCollection(collectionId);
    if (
      meta &&
      (meta.collectionKind !== 'task-results' ||
        meta.scope !== 'session' ||
        meta.owner !== scope.userId ||
        meta.sessionId !== scope.sessionKey)
    )
      throw new Error('Task result collection scope mismatch');
  }
  async function run<T>(
    operation: () => Promise<T>,
    options?: CallOptions,
  ): Promise<Result<T, TaskResultStoreError>> {
    try {
      const value = await cancellable(operation, options?.signal);
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: options?.signal?.aborted
            ? 'aborted'
            : error instanceof RagWriteError && error.code === 'RECORD_EXISTS'
              ? 'exists'
              : 'unavailable',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  return {
    put: (entry, options) =>
      run(async () => {
        const registry = getRegistry();
        await checkScope(registry);
        options?.signal?.throwIfAborted();
        await registry.getOrCreateCollection({
          id: collectionId,
          logicalId,
          displayName: logicalId,
          description: 'Immutable session task results, read by id.',
          collectionKind: 'task-results',
          scope: 'session',
          owner: scope.userId,
          sessionId: scope.sessionKey,
          expiresAt: Date.now() + sessionCollectionTtlMs(),
        });
        await checkScope(registry);
        options?.signal?.throwIfAborted();
        // Create-once is atomic per process. Backends upsert, so independent
        // processes can race; this is acceptable for a single-instance deployment.
        try {
          await registry.addDocument(
            collectionId,
            {
              id: entry.id,
              text: entry.output,
              metadata: {
                kind: 'task-result',
                taskId: entry.id,
                ...(entry.stepId === undefined ? {} : { stepId: entry.stepId }),
                worker: entry.worker,
                goal: entry.goal,
                result: entry.result,
                outcome: entry.outcome,
                summary: entry.summary,
                chars: entry.output.length,
                ...(entry.verdict === undefined
                  ? {}
                  : { verdict: entry.verdict }),
              },
            },
            undefined,
            {
              createOnly: true,
              signal: options?.signal,
              usage: options?.usage,
            },
          );
        } catch (error) {
          if (
            !(error instanceof RagWriteError) ||
            error.code !== 'RECORD_EXISTS'
          )
            throw error;
          const existing = await registry.getDocument(collectionId, entry.id);
          if (!existing || existing.text !== entry.output) throw error;
          return ref(entry.id, existing.text);
        }
        const stored = await registry.getDocument(collectionId, entry.id);
        if (!stored || stored.text !== entry.output)
          throw new Error('Task result is not readable');
        return ref(entry.id, stored.text);
      }, options),
    read: (reference, options) =>
      run(async () => {
        const registry = getRegistry();
        await checkScope(registry);
        // Never resolve an arbitrary collection supplied in a reference.
        if (
          reference.collection !== logicalId &&
          reference.collection !== collectionId
        )
          throw new Error('Task result reference is outside this session');
        const doc = await registry.getDocument(collectionId, reference.record);
        if (!doc) throw new Error('Task result not found');
        return doc.text;
      }, options),
  };
}
