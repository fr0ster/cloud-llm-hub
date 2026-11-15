import { RagError, type RagResult, type Result } from '@mcp-abap-adt/llm-agent';
import type { RequestHandler } from 'express';

type SearchResult = Result<RagResult[], RagError>;
type Failure = { message: string; probe: () => Promise<SearchResult> };
const failures = new Map<object, Failure>();
let probing: Promise<void> | undefined;

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
  if (!result.ok && !signal?.aborted) failures.set(store, { message, probe });
  return result;
}

/** One shared probe per arriving request batch; no timer, deadline or cached query vector. */
export async function assertToolSearchHealthy(): Promise<void> {
  if (!failures.size) return;
  if (!probing) {
    probing = (async () => {
      await Promise.all(
        [...failures].map(async ([store, failure]) => {
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
  await probing;
  const message = toolSearchFailure();
  if (message) throw new ToolSearchUnavailableError(message);
}

export const toolSearchReadinessGuard: RequestHandler = async (
  _req,
  res,
  next,
) => {
  try {
    await assertToolSearchHealthy();
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
  }
};
