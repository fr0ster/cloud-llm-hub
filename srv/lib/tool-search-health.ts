import { RagError, type RagResult, type Result } from '@mcp-abap-adt/llm-agent';
import type { RequestHandler } from 'express';

type SearchResult = Result<RagResult[], RagError>;
type Failure = { message: string } & (
  | { probe: () => Promise<{ ok: boolean }> }
  | { repair: Promise<void> }
);
const failures = new Map<object, Failure>();
let probing: Promise<void> | undefined;

/** Cancel one caller's wait without cancelling shared backend work. */
export async function waitForBackendWork(
  work: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return work;
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new DOMException('Backend wait aborted', 'AbortError'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

/** Report retained writes as unhealthy while their own queue repairs them. */
export function trackHubBackendRepair(
  backend: object,
  message: string,
  repair: Promise<void>,
): void {
  const failure = { message, repair };
  failures.set(backend, failure);
  const clear = () => {
    if (failures.get(backend) === failure) failures.delete(backend);
  };
  void repair.then(clear, clear);
}

export class ToolSearchUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'tool_search_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'ToolSearchUnavailableError';
  }
}

/** Backend messages can contain credentials or response bodies. Publish only our labels. */
export function toolSearchFailure(): string | undefined {
  const messages = [...failures.values()].map((failure) => failure.message);
  return messages.length ? [...new Set(messages)].join('; ') : undefined;
}

export function withToolSearchHealth(health: {
  status: number;
  body: object;
}): {
  status: number;
  body: object;
} {
  const failure = toolSearchFailure();
  return failure
    ? {
        status: 503,
        body: {
          ...health.body,
          status: 'DOWN',
          toolSearch: { error: failure },
        },
      }
    : health;
}

export async function queryToolCorpus(
  store: object,
  label: string,
  query: () => Promise<SearchResult>,
  probe: () => Promise<SearchResult>,
  signal?: AbortSignal,
  isBackendFailure: (error: RagError) => boolean = () => true,
): Promise<SearchResult> {
  const message = `Tool search unavailable: ${label} backend or embedder failed`;
  let result: SearchResult;
  try {
    result = await query();
  } catch {
    result = {
      ok: false,
      error: new RagError(message, 'TOOL_SEARCH_UNAVAILABLE'),
    };
  }
  // Caller cancellation says nothing about backend availability.
  if (!result.ok && !signal?.aborted && isBackendFailure(result.error))
    failures.set(store, { message, probe });
  return result;
}

/** Share request-driven tool probes and join background history repairs. */
export async function assertToolSearchHealthy(
  signal?: AbortSignal,
): Promise<void> {
  if (!failures.size) return;
  if (!probing) {
    probing = (async () => {
      await Promise.all(
        [...failures].map(async ([store, failure]) => {
          if (!('probe' in failure)) return;
          try {
            const result = await failure.probe();
            // A concurrent search failure must not be cleared by an older probe.
            if (result.ok && failures.get(store) === failure)
              failures.delete(store);
          } catch {
            // A failed probe leaves the original, content-free cause in place.
          }
        }),
      );
    })().finally(() => {
      probing = undefined;
    });
  }
  await waitForBackendWork(probing, signal);
  // More sessions may retain writes while the current repairs are in progress.
  while (true) {
    const repairs = [...failures.values()].flatMap((failure) =>
      'repair' in failure ? [failure.repair] : [],
    );
    if (!repairs.length) break;
    await waitForBackendWork(
      Promise.all(repairs).then(() => {}),
      signal,
    );
  }
  const message = toolSearchFailure();
  if (message) throw new ToolSearchUnavailableError(message);
}

export const toolSearchReadinessGuard: RequestHandler = async (
  req,
  res,
  next,
) => {
  // Match Express's case-insensitive routes and optional trailing slash.
  // Health reports state without starting a recovery probe.
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    /^\/(?:health|mcp\/health)\/?$/i.test(req.path)
  ) {
    next();
    return;
  }
  const disconnected = new AbortController();
  const cancel = () => {
    if (!res.writableFinished) disconnected.abort();
  };
  req.once('aborted', cancel);
  res.once('close', cancel);
  try {
    await assertToolSearchHealthy(disconnected.signal);
    next();
  } catch (error) {
    res.status(503).json({
      error: {
        code: 'tool_search_unavailable',
        message:
          error instanceof ToolSearchUnavailableError
            ? error.message
            : 'Tool search unavailable',
      },
    });
  } finally {
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
  }
};
