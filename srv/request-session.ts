// srv/request-session.ts
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<{ sessionId?: string }>();

export function runWithSessionId<T>(
  sessionId: string | undefined,
  fn: () => T,
): T {
  return als.run({ sessionId }, fn);
}

export function getRequestSessionId(): string | undefined {
  return als.getStore()?.sessionId;
}
