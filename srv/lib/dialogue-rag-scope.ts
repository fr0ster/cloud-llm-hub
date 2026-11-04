import { AsyncLocalStorage } from 'node:async_hooks';

const dialogueScope = new AsyncLocalStorage<boolean>();

export function runWithDialogueRagTools<T>(fn: () => T): T {
  return dialogueScope.run(true, fn);
}

export function isDialogueRagWorker(): boolean {
  return dialogueScope.getStore() === true;
}

/** Offer reference readers; the canonical RAG gate still checks the target. */
export function isDialogueResultReader(name: string): boolean {
  return (
    isDialogueRagWorker() &&
    (name === 'rag_read' || name === 'collection_records')
  );
}

export function allowsReadOnlyEffect(
  effect: 'read' | 'knowledge' | 'write',
): boolean {
  return effect === 'read' || (effect === 'knowledge' && isDialogueRagWorker());
}
