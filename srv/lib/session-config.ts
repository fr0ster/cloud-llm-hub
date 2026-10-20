/**
 * Long-session configuration: read from the environment, validated, cached.
 *
 * Malformed means refuse to start, naming the variable (the same rule as
 * `gatekeeper-config.ts`). Absent means the default below.
 */
import { getAgentConfig } from '../agent-config';
import { readPositiveIntFrom } from './env-int';

export type SessionStoreKind = 'none' | 'sqlite' | 'hana-vector' | 'pg-vector';

const STORES: readonly SessionStoreKind[] = [
  'none',
  'sqlite',
  'hana-vector',
  'pg-vector',
];

export interface SessionConfig {
  /** Idle time after which a session expires. */
  ttlMs: number;
  /** Sessions held at once, across every user. */
  maxSessions: number;
  /** Sessions one user may hold at once. */
  maxPerUser: number;
  /** Callers that may wait for a session slot. */
  queueLength: number;
  /** Where session state survives a restart. `none`: memory only. */
  store: SessionStoreKind;
  /** File of the `sqlite` store. */
  storePath: string;
  /** Plain (session-less) calls allowed on the HTTP API. */
  plainApi: boolean;
  /** Plain (session-less) calls allowed on MCP. */
  plainMcp: boolean;
}

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  return readPositiveIntFrom(env, name) ?? fallback;
}

function readStore(
  env: NodeJS.ProcessEnv,
  sessionBackend: string | undefined,
): SessionStoreKind {
  const raw = env.LLM_AGENT_SESSION_STORE?.trim();
  if (raw) {
    if (!(STORES as readonly string[]).includes(raw)) {
      throw new Error(
        `Invalid LLM_AGENT_SESSION_STORE: expected one of ${STORES.join(', ')}, got ${JSON.stringify(raw)}`,
      );
    }
    return raw as SessionStoreKind;
  }
  // A persistent session backend already holds the session's data; the
  // session store follows it unless told otherwise.
  return sessionBackend === 'hana-vector' || sessionBackend === 'pg-vector'
    ? sessionBackend
    : 'none';
}

export function loadSessionConfig(
  env: NodeJS.ProcessEnv = process.env,
  sessionBackend?: string,
): SessionConfig {
  const maxSessions = readPositiveInt(env, 'LLM_AGENT_MAX_SESSIONS', 50);
  const maxPerUser = readPositiveInt(env, 'LLM_AGENT_MAX_SESSIONS_PER_USER', 5);
  if (maxPerUser > maxSessions) {
    throw new Error(
      `Invalid LLM_AGENT_MAX_SESSIONS_PER_USER: ${maxPerUser} is larger than LLM_AGENT_MAX_SESSIONS=${maxSessions}. One user cannot hold more sessions than the hub allows.`,
    );
  }
  return {
    ttlMs: readPositiveInt(env, 'LLM_AGENT_SESSION_TTL_MS', 3_600_000),
    maxSessions,
    maxPerUser,
    queueLength: readPositiveInt(env, 'LLM_AGENT_SESSION_QUEUE', 2),
    store: readStore(env, sessionBackend),
    storePath: env.LLM_AGENT_SESSION_STORE_PATH?.trim() || '.data/sessions.db',
    plainApi: env.LLM_AGENT_PLAIN_API === 'true',
    plainMcp: env.LLM_AGENT_PLAIN_MCP === 'true',
  };
}

let cached: SessionConfig | undefined;

export function sessionConfig(): SessionConfig {
  if (!cached) {
    cached = loadSessionConfig(
      process.env,
      getAgentConfig().rag.backends.session,
    );
  }
  return cached;
}

/** Test seam. */
export function clearSessionConfig(): void {
  cached = undefined;
}
