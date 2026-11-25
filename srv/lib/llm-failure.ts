import { AsyncLocalStorage } from 'node:async_hooks';
import type { ILlm, IUsageRecorder, TokenUsage } from '@mcp-abap-adt/llm-agent';
import {
  addTokenUsage,
  contextExceededError,
  EMBEDDING_CONTEXT_EXCEEDED,
  findThrottled,
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  preserveThrottled,
} from '@mcp-abap-adt/llm-agent';
import { throttleCallScope, withThrottleCall } from './throttle-strategy';
import { reportWorkerActivity } from './worker-activity';

// Observe provider calls independently of the pipeline's usage and result.
interface SpendObserver {
  record: (usage: TokenUsage) => void;
  preview?: (call: symbol, usage?: TokenUsage) => void;
  onSuccessfulStreamAttempt?: () => void;
}
const spendObserver = new AsyncLocalStorage<SpendObserver | undefined>();
const zeroTokenUsage: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export function runWithoutLlmSpend<T>(run: () => T): T {
  return spendObserver.run(undefined, run);
}

export function observeLlmSpend<T>(
  run: () => T,
  record: (usage: TokenUsage) => void,
  preview?: (call: symbol, usage?: TokenUsage) => void,
): T {
  return spendObserver.run({ record, preview }, run);
}

/** Attribute one provider attempt, preserving an existing per-model breakdown. */
export function reportLlmSpend(usage: TokenUsage, model: string): void {
  spendObserver.getStore()?.record(attributeTokenUsage(usage, model));
}

/** Record a physical attempt when the provider supplied no token counters. */
export function reportUsageFreeLlmAttempt(
  model: string,
  succeeded: boolean,
): void {
  if (succeeded) spendObserver.getStore()?.onSuccessfulStreamAttempt?.();
  reportLlmSpend(zeroTokenUsage, model);
}

export function attributeTokenUsage(
  usage: TokenUsage,
  model: string,
): TokenUsage {
  return {
    ...usage,
    models: usage.models ?? {
      [model]: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        requests: 1,
        ...(usage.cachedInputTokens !== undefined
          ? { cachedInputTokens: usage.cachedInputTokens }
          : {}),
        ...(usage.cacheCreationInputTokens !== undefined
          ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
          : {}),
      },
    },
  };
}

export function captureTokenUsage() {
  let observed: TokenUsage | undefined;
  const active = new Map<symbol, TokenUsage>();
  return {
    run<T>(run: () => T): T {
      return observeLlmSpend(
        run,
        (usage) => {
          observed = addTokenUsage(observed, usage);
        },
        (call, usage) => {
          if (usage) active.set(call, usage);
          else active.delete(call);
        },
      );
    },
    usage(fallback?: TokenUsage) {
      return observed ?? fallback;
    },
    streamUsage(fallback?: TokenUsage) {
      let usage = observed;
      for (const preview of active.values())
        usage = addTokenUsage(usage, preview);
      return usage ?? fallback;
    },
  };
}

/** Ollama reports embedding tokens through the provider recorder. */
export function observeEmbeddingUsage(
  recorder?: IUsageRecorder,
): IUsageRecorder {
  const observer = spendObserver.getStore();
  const wrap = (delegate?: IUsageRecorder): IUsageRecorder => ({
    record(input) {
      if (input.kind === 'embedding.call' && input.inputTokens !== undefined) {
        observer?.record(
          attributeTokenUsage(
            {
              promptTokens: input.inputTokens,
              completionTokens: 0,
              totalTokens: input.inputTokens,
            },
            input.model,
          ),
        );
      }
      delegate?.record(input);
    },
    with: (context) => wrap(delegate?.with(context)),
  });
  return wrap(recorder);
}

const anthropicErrorCodes = new Set([
  'overloaded_error',
  'api_error',
  'rate_limit_error',
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
]);

export const modelContextMessage = 'Запит перевищує контекст моделі';
const embeddingContextMessage =
  'Вхідні дані перевищують контекст моделі ембедингів';
const unansweredWriteWarning =
  'Результат запису невідомий. Перевір стан у SAP перед повтором.';

function contextOverflowMessage(code: string | undefined): string | undefined {
  if (code === MODEL_CONTEXT_EXCEEDED) return modelContextMessage;
  if (code === EMBEDDING_CONTEXT_EXCEEDED) return embeddingContextMessage;
}

const retainedRunErrorCodes = new WeakMap<Error, string>();

/** Keep the code when an existing boundary replaces a provider error. */
export function retainRunErrorCode(error: Error, code: string | undefined) {
  if (code) retainedRunErrorCodes.set(error, code);
  return error;
}

export function runErrorCode<T>(error: T): string | undefined {
  if (contextExceededError(error)) return MODEL_CONTEXT_EXCEEDED;
  let current: object | undefined =
    typeof error === 'object' && error !== null ? error : undefined;
  const seen = new Set<object>();
  let code: string | undefined;
  while (current && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      if (current.code === EMBEDDING_CONTEXT_EXCEEDED) return current.code;
      code ??= current.code;
    }
    if (current instanceof Error) code ??= retainedRunErrorCodes.get(current);
    const cause = 'cause' in current ? current.cause : undefined;
    current = typeof cause === 'object' && cause !== null ? cause : undefined;
  }
  return code;
}

export function runContextOverflow<T>(error: T): boolean {
  return contextOverflowMessage(runErrorCode(error)) !== undefined;
}

export function clientRunFailure<T>(error: T, unansweredSapWrite = false) {
  const code = runErrorCode(error);
  if (!code) return;
  const overflow = contextOverflowMessage(code);
  if (overflow)
    return {
      code,
      message: unansweredSapWrite
        ? `${overflow}. ${unansweredWriteWarning}`
        : overflow,
      status: 400,
    };
  return { code, status: 500 };
}

export function contextExceededMessage(unansweredSapWrite: boolean): string {
  return unansweredSapWrite
    ? `${modelContextMessage}. ${unansweredWriteWarning}`
    : modelContextMessage;
}

export function safeContextExceeded<T>(error: T) {
  if (contextExceededError(error))
    return Object.assign(
      new LlmError(modelContextMessage, MODEL_CONTEXT_EXCEEDED),
      { status: 400 },
    );
}

export function anthropicStreamCode(
  error: Parameters<typeof llmFailure>[0],
): string | undefined {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code =
      'code' in current && typeof current.code === 'string'
        ? current.code
        : undefined;
    const prefix =
      current instanceof Error
        ? /^(?:Anthropic stream error: ([a-z_]+):|LLM unavailable \(([a-z_]+)\)$)/
            .exec(current.message)
            ?.slice(1)
            .find(Boolean)
        : undefined;
    if (code && anthropicErrorCodes.has(code)) return code;
    if (prefix && anthropicErrorCodes.has(prefix)) return prefix;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Keep only status facts: provider messages may contain prompts or credentials. */
export function llmFailure(error: unknown): string {
  if (contextExceededError(error)) return modelContextMessage;
  const streamCode = anthropicStreamCode(error);
  if (streamCode) return `LLM unavailable (${streamCode})`;
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

/** A stream that has emitted content must never be restarted by an outer retry. */
export class StreamContentError extends LlmError {
  constructor(error: Error) {
    super(llmFailure(error), contextExceededError(error)?.code);
  }
}

function safeLlmError(error: unknown): LlmError {
  const overflow = safeContextExceeded(error);
  if (overflow) return overflow;
  const safe = new LlmError(
    llmFailure(error),
    error instanceof LlmError ? error.code : undefined,
  );
  // Preserve exhausted-policy facts so an outer retry decorator cannot start
  // another six unnamed waits. No raw provider cause is attached to this error.
  const throttled = findThrottled(error);
  if (throttled) return preserveThrottled(throttled, safe);
  if (error instanceof StreamContentError)
    // Structured classification takes precedence over HTTP digits in safe text.
    // Zero denotes a local terminal stream failure, not an HTTP response.
    return Object.assign(safe, { status: 0 });
  const streamCode = anthropicStreamCode(error);
  // The builder retries structured 503 failures before output starts.
  if (streamCode === 'overloaded_error' || streamCode === 'api_error')
    return Object.assign(safe, { status: 503 });
  return safe;
}

/** Normalize at the hub boundary before the tool loop drops structured causes. */
export function reliableLlm(inner: ILlm): ILlm {
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'chat')
        return (...args: Parameters<ILlm['chat']>) =>
          withThrottleCall(async () => {
            try {
              reportWorkerActivity('llm call');
              const result = await target.chat(...args);
              if (result.ok)
                reportLlmSpend(
                  result.value.usage ?? zeroTokenUsage,
                  target.model ?? 'unknown',
                );
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
            reportWorkerActivity('llm call');
            const next = throttleCallScope();
            const observer = spendObserver.getStore();
            let successfulAttemptReported = false;
            const streamObserver = observer && {
              ...observer,
              onSuccessfulStreamAttempt() {
                successfulAttemptReported = true;
              },
            };
            const advance = <T>(run: () => T): T =>
              spendObserver.run(streamObserver, () => next(run));
            const iterator = advance(() =>
              target.streamChat(...args)[Symbol.asyncIterator](),
            );
            const call = Symbol();
            const model = target.model ?? 'unknown';
            return (async function* () {
              let spent: TokenUsage | undefined;
              let reported = false;
              // Before a failure is yielded: the consumer computes its final
              // usage on that chunk, not after the iterator closes.
              const report = () => {
                if (reported || !spent) return;
                reported = true;
                observer?.preview?.(call);
                // The adapter's configured model serves the call; it deliberately
                // ignores client-facing model aliases in CallOptions.
                observer?.record(attributeTokenUsage(spent, model));
              };
              try {
                while (true) {
                  const item = await advance(() => iterator.next());
                  if (item.done) {
                    // A provider that reports physical attempts may have counted it.
                    if (!successfulAttemptReported && !args[2]?.signal?.aborted)
                      spent ??= zeroTokenUsage;
                    return;
                  }
                  const result = item.value;
                  if (!result.ok) {
                    report();
                    yield {
                      ok: false as const,
                      error: safeLlmError(result.error),
                    };
                    return;
                  }
                  if (result.value.usage) {
                    spent = mergeStreamUsage(spent, result.value.usage);
                    observer?.preview?.(
                      call,
                      attributeTokenUsage(spent, model),
                    );
                  }
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
                await advance(() => iterator.return?.());
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
  if (contextExceededError(error) || findThrottled(error)) return true;
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
 * Merge split or cumulative snapshots of the same usage. Input and its cache
 * counters are one observation, independent of how much output was reported.
 */
export function mergeStreamUsage(
  previous: TokenUsage | undefined,
  next: TokenUsage,
): TokenUsage {
  if (!previous) return next;
  const input =
    next.promptTokens > previous.promptTokens ||
    (next.promptTokens === previous.promptTokens &&
      (next.cachedInputTokens !== undefined ||
        next.cacheCreationInputTokens !== undefined))
      ? next
      : previous;
  const completionTokens = Math.max(
    previous.completionTokens,
    next.completionTokens,
  );
  return {
    ...previous,
    ...next,
    cachedInputTokens: input.cachedInputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    promptTokens: input.promptTokens,
    completionTokens,
    totalTokens: Math.max(
      previous.totalTokens,
      next.totalTokens,
      input.promptTokens + completionTokens,
    ),
  };
}
