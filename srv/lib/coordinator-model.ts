import { AsyncLocalStorage } from 'node:async_hooks';

const selected = new AsyncLocalStorage<string | undefined>();
export const coordinatorModel = (): string | undefined => selected.getStore();
export function withCoordinatorModel<T>(
  model: string | undefined,
  run: () => T,
): T {
  return selected.run(model, run);
}
