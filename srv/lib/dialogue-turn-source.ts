import { AsyncLocalStorage } from 'node:async_hooks';

export const turnSource = new AsyncLocalStorage<'webui' | 'api' | 'mcp'>();

export const clientTurnId = new AsyncLocalStorage<string | undefined>();

export function validatedClientTurnId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value)
    ? value
    : undefined;
}
