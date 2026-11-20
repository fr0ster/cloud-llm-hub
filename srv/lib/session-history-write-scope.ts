import { AsyncLocalStorage } from 'node:async_hooks';
import {
  httpStatusOf,
  RagError,
  retryAfterSecondsOf,
  runWithThrottleRetry,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';

/** Shared providers select the existing strict embedding composition only for owed turns. */
export const sessionHistoryWrite = new AsyncLocalStorage<true>();
export const sessionHistoryRepair = new AsyncLocalStorage<true>();

const storeTransport = new AsyncLocalStorage<{
  url: string;
  signal: AbortSignal;
}>();
let installedFetch: typeof fetch | undefined;

/** Qdrant's Result conversion discards HTTP headers. Observe 429 before that boundary.
 * The adapter is process-wide, but only matching storage URLs in this async scope wait.
 * Request bodies used by the provider are replayable JSON strings. */
export function withHistoryStoreTransport<T>(
  url: string | undefined,
  shutdown: AbortSignal,
  run: () => T,
): T {
  if (!url) return run();
  if (globalThis.fetch !== installedFetch) {
    const transport = globalThis.fetch;
    installedFetch = (input, init) => {
      const store = storeTransport.getStore();
      const address =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (
        !store ||
        !(address === store.url || address.startsWith(`${store.url}/`))
      )
        return transport(input, init);
      const requestSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = requestSignal
        ? AbortSignal.any([requestSignal, store.signal])
        : store.signal;
      return runWithThrottleRetry(
        async () => {
          const response = await transport(input, { ...init, signal });
          if (response.status !== 429) return response;
          await response.body?.cancel();
          throw Object.assign(new RagError('Session history store throttled'), {
            status: 429,
            headers: response.headers,
          });
        },
        {
          key: `session-history-http:${store.url}`,
          strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }),
          isThrottled: (error) =>
            error instanceof Error && httpStatusOf(error) === 429,
          retryAfterSeconds: (error) =>
            error instanceof Error ? retryAfterSecondsOf(error) : undefined,
          signal,
        },
      );
    };
    globalThis.fetch = installedFetch;
  }
  return storeTransport.run(
    { url: url.replace(/\/$/, ''), signal: shutdown },
    run,
  );
}
