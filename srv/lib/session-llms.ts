import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ILlm } from '@mcp-abap-adt/llm-agent';

/** Providers have no close API; disposal drops all owned client references. */
export class SessionLlms {
  readonly quotaScope = `session:${randomUUID()}`;
  private readonly clients = new Map<string, Promise<ILlm>>();
  private closed = false;

  get(
    key: string,
    create: (quotaScope: string) => Promise<ILlm>,
  ): Promise<ILlm> {
    if (this.closed)
      return Promise.reject(new Error('Session LLM clients closed'));
    let client = this.clients.get(key);
    if (!client) {
      client = create(this.quotaScope);
      this.clients.set(key, client);
    }
    return client;
  }

  dispose(): void {
    this.closed = true;
    this.clients.clear();
  }

  run<T>(run: () => T): T {
    return sessionLlms.run(this, run);
  }
}

export const sessionLlms = new AsyncLocalStorage<SessionLlms>();
