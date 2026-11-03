import { AsyncLocalStorage } from 'node:async_hooks';

const planAuthor = new AsyncLocalStorage<boolean>();
export function withCompactRagSearch<T>(run: () => T): T {
  return planAuthor.run(true, run);
}
export function compactRagSearch(): boolean {
  return planAuthor.getStore() === true;
}
