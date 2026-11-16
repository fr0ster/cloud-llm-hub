import { AsyncLocalStorage } from 'node:async_hooks';
import type { Message } from '@mcp-abap-adt/llm-agent';

export const turnSource = new AsyncLocalStorage<'webui' | 'api' | 'mcp'>();

export const clientTurnId = new AsyncLocalStorage<string | undefined>();
export const clientTurnMessages = new AsyncLocalStorage<Message[]>();

export function validatedClientTurnId(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value)
    ? value
    : undefined;
}
