import { AsyncLocalStorage } from 'node:async_hooks';

export const turnSource = new AsyncLocalStorage<'webui' | 'api' | 'mcp'>();
