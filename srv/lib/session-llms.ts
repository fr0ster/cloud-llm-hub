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

/** Full session identity; keys alone are not unique across users. */
export interface LlmSessionIdentity {
  readonly userId: string;
  readonly key: string;
}

const owners = new Map<string, SessionLlms>();
const identityKey = (session: LlmSessionIdentity): string =>
  JSON.stringify([session.userId, session.key]);

export function longSessionLlms(session: LlmSessionIdentity): SessionLlms {
  const key = identityKey(session);
  let owner = owners.get(key);
  if (!owner) {
    owner = new SessionLlms();
    owners.set(key, owner);
  }
  return owner;
}

export function disposeSessionLlms(session: LlmSessionIdentity): void {
  const key = identityKey(session);
  owners.get(key)?.dispose();
  owners.delete(key);
}

/** Keep the owner installed through classification, execution and streaming. */
export async function runWithRequestLlms<T>(
  session: LlmSessionIdentity | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (session) {
    // Admission explicitly opens/revives owners via longSessionLlms. Missing
    // stable keys are closed: late requests cannot reopen them. This keeps
    // only live owners (bounded by session admission), with no tombstone growth.
    const owner = owners.get(identityKey(session));
    if (!owner) throw new Error('Session LLM clients closed');
    return owner.run(run);
  }
  // Nested internal tools belong to the enclosing request.
  if (sessionLlms.getStore()) return run();
  const owner = new SessionLlms();
  try {
    return await owner.run(run);
  } finally {
    owner.dispose();
  }
}
