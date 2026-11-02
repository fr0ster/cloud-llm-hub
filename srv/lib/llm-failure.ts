import { AsyncLocalStorage } from 'node:async_hooks';
import type { ILlm, TokenUsage } from '@mcp-abap-adt/llm-agent';
import {
  findThrottled,
  LlmError,
  preserveThrottled,
} from '@mcp-abap-adt/llm-agent';
import { throttleCallScope, withThrottleCall } from './throttle-strategy';

// A failed planner result has no usage field. Observe completed model calls
// here so already-spent tokens survive the library's failed-result envelope.
const spendObserver = new AsyncLocalStorage<(usage: TokenUsage) => void>();
export function observeLlmSpend<T>(
  run: () => T,
  record: (usage: TokenUsage) => void,
): T {
  return spendObserver.run(record, run);
}

/** Report a completed model call to the innermost spend observer, if any. */
export function reportLlmSpend(usage: TokenUsage): void {
  spendObserver.getStore()?.(usage);
}

/** Keep only status facts: provider messages may contain prompts or credentials. */
export function llmFailure(error: unknown): string {
  if (findThrottled(error)) return 'LLM unavailable (HTTP 429)';
  let current = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (typeof current !== 'object') break;
    const status =
      'status' in current
        ? current.status
        : 'statusCode' in current
          ? current.statusCode
          : undefined;
    if (
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    )
      return `LLM unavailable (HTTP ${status})`;
    if (
      'response' in current &&
      typeof current.response === 'object' &&
      current.response !== null &&
      'status' in current.response
    ) {
      const code = current.response.status;
      if (
        typeof code === 'number' &&
        Number.isInteger(code) &&
        code >= 400 &&
        code <= 599
      )
        return `LLM unavailable (HTTP ${code})`;
    }
    if (current instanceof Error) {
      const code = /\b(?:HTTP\s+|status(?: code)?[ :]+)([45]\d{2})\b/i.exec(
        current.message,
      )?.[1];
      if (code) return `LLM unavailable (HTTP ${code})`;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return 'LLM unavailable (no response from model)';
}

function safeLlmError(error: unknown): LlmError {
  const safe = new LlmError(
    llmFailure(error),
    error instanceof LlmError ? error.code : undefined,
  );
  // Preserve exhausted-policy facts so an outer retry decorator cannot start
  // another six unnamed waits. No raw provider cause is attached to this error.
  const throttled = findThrottled(error);
  return throttled ? preserveThrottled(throttled, safe) : safe;
}

/** Normalize at the hub boundary before the tool loop drops structured causes. */
export function reliableLlm(inner: ILlm): ILlm {
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'chat')
        return (...args: Parameters<ILlm['chat']>) =>
          withThrottleCall(async () => {
            try {
              const result = await target.chat(...args);
              if (result.ok && result.value.usage)
                reportLlmSpend(result.value.usage);
              return result.ok
                ? result
                : {
                    ok: false as const,
                    error: safeLlmError(result.error),
                  };
            } catch (error) {
              return {
                ok: false as const,
                error: safeLlmError(error),
              };
            }
          });
      if (property === 'streamChat')
        return (...args: Parameters<ILlm['streamChat']>) => {
          // Async generators execute on next(), so enter the call scope around consumption.
          return withThrottleCall(() => {
            const iterator = target.streamChat(...args)[Symbol.asyncIterator]();
            const next = throttleCallScope();
            return (async function* () {
              let spent: TokenUsage | undefined;
              let reported = false;
              // Before a failure is yielded: the consumer computes its final
              // usage on that chunk, not after the iterator closes.
              const report = () => {
                if (reported || !spent) return;
                reported = true;
                reportLlmSpend(spent);
              };
              try {
                while (true) {
                  const item = await next(() => iterator.next());
                  if (item.done) return;
                  const result = item.value;
                  if (!result.ok) {
                    report();
                    yield {
                      ok: false as const,
                      error: safeLlmError(result.error),
                    };
                    return;
                  }
                  if (result.value.usage)
                    spent = mergeStreamUsage(spent, result.value.usage);
                  yield result;
                }
              } catch (error) {
                report();
                yield {
                  ok: false as const,
                  error: safeLlmError(error),
                };
              } finally {
                report();
                await iterator.return?.();
              }
            })();
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Is this failure the model's (an LLM error or a throttle anywhere in the cause chain)? */
export function isLlmFailure(error: unknown): boolean {
  if (findThrottled(error)) return true;
  let current = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current instanceof LlmError) return true;
    // The safe text survives a library rewrap that drops the cause chain.
    if (
      current instanceof Error &&
      current.message.startsWith('LLM unavailable (')
    )
      return true;
    if (typeof current !== 'object') return false;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Client-facing text for a failed request: the content-free LLM cause for model
 * failures; any other failure keeps its own message, as before this change.
 */
export function failureMessage(error: unknown): string {
  if (isLlmFailure(error)) return llmFailure(error);
  return error instanceof Error ? error.message : String(error);
}

/**
 * One model call may report usage in several chunks: split (input at the start,
 * output at the end) or cumulative. The larger value per field covers both.
 */
export function mergeStreamUsage(
  previous: TokenUsage | undefined,
  next: TokenUsage,
): TokenUsage {
  if (!previous) return next;
  const promptTokens = Math.max(previous.promptTokens, next.promptTokens);
  const completionTokens = Math.max(
    previous.completionTokens,
    next.completionTokens,
  );
  return {
    ...previous,
    ...next,
    promptTokens,
    completionTokens,
    totalTokens: Math.max(
      previous.totalTokens,
      next.totalTokens,
      promptTokens + completionTokens,
    ),
  };
}
