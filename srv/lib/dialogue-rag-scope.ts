import { AsyncLocalStorage } from 'node:async_hooks';

const dialogueScope = new AsyncLocalStorage<boolean>();

export function runWithDialogueRagTools<T>(fn: () => T): T {
  return dialogueScope.run(true, fn);
}

export function isDialogueRagWorker(): boolean {
  return dialogueScope.getStore() === true;
}

export function allowsReadOnlyEffect(
  effect: 'read' | 'knowledge' | 'write',
): boolean {
  return effect === 'read' || (effect === 'knowledge' && isDialogueRagWorker());
}
