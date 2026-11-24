import { AsyncLocalStorage } from 'node:async_hooks';
import type { ILlm, IUsageRecorder, TokenUsage } from '@mcp-abap-adt/llm-agent';
import {
  addTokenUsage,
  contextExceededError,
  EMBEDDING_CONTEXT_EXCEEDED,
  findThrottled,
  httpStatusOf,
  LlmError,
  McpError,
  MODEL_CONTEXT_EXCEEDED,
  preserveThrottled,
  RagError,
  retryAfterSecondsOf,
  terminalRunError,
} from '@mcp-abap-adt/llm-agent';
import type { ProbeClassification } from './probe-classifier';
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

export function runErrorCode<T>(error: T): string | undefined {
  if (contextExceededError(error)) return MODEL_CONTEXT_EXCEEDED;
  let code: string | undefined;
  for (const current of failureCauses(error)) {
    if ('code' in current && typeof current.code === 'string') {
      if (current.code === EMBEDDING_CONTEXT_EXCEEDED) return current.code;
      code ??= current.code;
    }
  }
  return code;
}

export function runContextOverflow<T>(error: T): boolean {
  return (
    contextOverflowMessage(runErrorCode(error)) !== undefined &&
    failureOrigin(error) !== 'domain'
  );
}

export interface SafeFailure {
  code: string;
  message: string;
  status?: number;
  throttled?: boolean;
  retryAfterSeconds?: number;
}

/** An actionable message authored by the hub. */
export class HubError extends Error {}

const failureMessages = new Map([
  ['EMBED_ERROR', 'Embedding request failed.'],
  ['LLM_OUTPUT_TRUNCATED', 'Provider stopped at the output token limit'],
  [
    'MODEL_NOT_ALLOWED',
    'MODEL_NOT_ALLOWED: The selected model is not allowed.',
  ],
  [
    'SAP_CREDENTIALS_PENDING',
    "no SAP credentials yet; they arrive with the user's next message",
  ],
  ['SAP_AUTH_REJECTED', 'SAP connection failed: authentication rejected'],
  ['SAP_CONNECTION_FAILED', 'SAP connection failed'],
  ['COORDINATOR_STEP_FAILED', 'A coordinator work step failed.'],
  ['COORDINATOR_CHECK_FAILED', 'A coordinator check could not be completed.'],
  ['PLANNER_ERROR', 'Planner turn failed.'],
]);

const ragBackendErrors = new Set([
  'RAG_ERROR',
  'RAG_ACCESS_STORE_ERROR',
  'RAG_BACKEND_ERROR',
  'RAG_CATALOG_ERROR',
  'RAG_COUNT_ERROR',
  'RAG_CREATE_ERROR',
  'RAG_DELETE_ERROR',
  'RAG_LIST_ERROR',
  'RAG_MIGRATION_ERROR',
  'RAG_OPEN_ERROR',
  'RAG_UPDATE_ERROR',
  'QUERY_ERROR',
  'UPSERT_ERROR',
  'DELETE_ERROR',
  'CLEAR_ERROR',
  'HEALTH_CHECK_ERROR',
  'CONNECTION_ERROR',
]);

export function* failureCauses<T>(error: T) {
  const seen = new Set<object>();
  let current: object | undefined =
    typeof error === 'object' && error !== null ? error : undefined;
  while (current && !seen.has(current)) {
    seen.add(current);
    yield current;
    const cause = 'cause' in current ? current.cause : undefined;
    current = typeof cause === 'object' && cause !== null ? cause : undefined;
  }
}

type FailureOrigin =
  | 'hub'
  | 'domain'
  | 'llm'
  | 'embedding'
  | 'rag'
  | 'transport';
type ClassifiedFailure = { origin: FailureOrigin; source: object };

/** Identify the producer, including library projections that retain only a code. */
function classifyFailure<T>(error: T): ClassifiedFailure | undefined {
  let projected: ClassifiedFailure | undefined;
  let transport: object | undefined;
  for (const current of failureCauses(error)) {
    if (current instanceof HubError) return { origin: 'hub', source: current };
    if (current instanceof McpError)
      return { origin: 'domain', source: current };
    const code = 'code' in current ? current.code : undefined;
    const embedding =
      code === EMBEDDING_CONTEXT_EXCEEDED || code === 'EMBED_ERROR';
    if (current instanceof LlmError)
      return { origin: embedding ? 'embedding' : 'llm', source: current };
    if (current instanceof RagError) return { origin: 'rag', source: current };

    // A wrapper or dialogue record can retain only a code or a safe provider message.
    if (projected) continue;
    if (embedding) projected = { origin: 'embedding', source: current };
    else if (typeof code === 'string') {
      if (/^MCP_(?:ERROR$|HTTP_|UNAVAILABLE$)/.test(code))
        projected = { origin: 'domain', source: current };
      else if (code === MODEL_CONTEXT_EXCEEDED || code.startsWith('LLM_'))
        projected = { origin: 'llm', source: current };
      else if (ragBackendErrors.has(code))
        projected = { origin: 'rag', source: current };
      else if (
        /^(?:ECONN(?:ABORTED|REFUSED|RESET)|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_NETWORK|UND_ERR_[A-Z_]+)$/.test(
          code,
        )
      )
        transport ??= current;
    }
    if (
      !projected &&
      current instanceof Error &&
      current.message.startsWith('LLM unavailable (')
    )
      projected = { origin: 'llm', source: current };
  }
  if (projected) return projected;
  const details =
    typeof error === 'object' && error !== null ? error : undefined;
  const status = httpStatusOf(details);
  if (transport) return { origin: 'transport', source: transport };
  if (details && status !== undefined && status >= 400 && status <= 599)
    return { origin: 'transport', source: details };
  const limit = findThrottled(error);
  if (limit) return { origin: 'llm', source: limit };
}

export function failureOrigin<T>(error: T) {
  return classifyFailure(error)?.origin;
}

export function isInfrastructureFailure<T>(error: T): boolean {
  const origin = failureOrigin(error);
  return origin !== undefined && origin !== 'domain' && origin !== 'hub';
}

function reportedMessage<T>(error: T): string | undefined {
  if (typeof error === 'string') return error;
  for (const current of failureCauses(error)) {
    if ('message' in current && typeof current.message === 'string')
      return current.message;
  }
}

/** Keep structured facts and expose diagnostics from the hub or MCP tools. */
export function sanitizeFailure<T>(
  error: T,
  fallback: SafeFailure,
): SafeFailure {
  const classified = classifyFailure(error);
  const origin = classified?.origin;
  const verbatim = origin === 'hub' || origin === 'domain';
  const source = classified && verbatim ? classified.source : error;
  const details =
    typeof source === 'object' && source !== null ? source : undefined;
  const reportedCode = verbatim
    ? details && 'code' in details && typeof details.code === 'string'
      ? details.code
      : undefined
    : (runErrorCode(source) ?? terminalRunError(source)?.code);
  const code =
    reportedCode && /^[a-z][a-z0-9_.-]*$/i.test(reportedCode)
      ? reportedCode
      : fallback.code;
  const overflow = verbatim ? undefined : contextOverflowMessage(code);
  const limit = findThrottled(details);
  const mcpStatus = origin === 'domain' && /^MCP_HTTP_([45]\d{2})$/.exec(code);
  const status =
    httpStatusOf(details) ?? (mcpStatus ? Number(mcpStatus[1]) : undefined);
  const retryAfterSeconds = retryAfterSecondsOf(details);
  return {
    code,
    message: verbatim
      ? (reportedMessage(source) ?? fallback.message)
      : (overflow ?? failureMessages.get(code) ?? fallback.message),
    ...(overflow
      ? { status: 400 }
      : Number.isFinite(status)
        ? { status }
        : limit
          ? { status: 429 }
          : {}),
    ...((limit || (!verbatim && status === 429)) && { throttled: true }),
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
  };
}

export class AgentInitializationError extends HubError {
  readonly code: string;
  readonly status?: number;
  readonly throttled?: boolean;
  readonly retryAfterSeconds?: number;

  get statusCode(): number {
    return contextOverflowMessage(this.code) ? 400 : 503;
  }

  constructor(
    failure: SafeFailure,
    readonly destination?: string,
    readonly destinationStatus?: string,
    readonly probe?: ProbeClassification,
  ) {
    super(failure.message);
    this.code = failure.code;
    this.status = failure.status;
    this.throttled = failure.throttled;
    this.retryAfterSeconds = failure.retryAfterSeconds;
  }
}

export function agentInitializationFailure<T>(error: T, destination?: string) {
  if (error instanceof AgentInitializationError) return error;
  return new AgentInitializationError(
    sanitizeFailure(error, {
      code: 'destination_unreachable',
      message: 'Agent initialization failed.',
    }),
    destination,
  );
}

export function clientRunFailure<T>(error: T, unansweredSapWrite = false) {
  const origin = failureOrigin(error);
  if (!runErrorCode(error) && (origin === undefined || origin === 'hub'))
    return;
  const safe = sanitizeFailure(error, {
    code: 'AGENT_RUN_ERROR',
    message: origin === 'llm' ? llmFailure(error) : 'Agent run failed.',
  });
  const { code, message } = safe;
  const overflow =
    origin === 'domain' ? undefined : contextOverflowMessage(code);
  if (overflow)
    return {
      code,
      message: unansweredSapWrite
        ? `${overflow}. ${unansweredWriteWarning}`
        : overflow,
      status: 400,
    };
  if (error instanceof AgentInitializationError)
    return { code, message: error.message, status: error.statusCode };
  return {
    code,
    message: unansweredSapWrite
      ? `${message} The outcome of the SAP write is unknown. Check SAP before retrying.`
      : message,
    status:
      (origin === 'domain' || !safe.throttled) &&
      safe.status !== undefined &&
      safe.status >= 400 &&
      safe.status <= 599
        ? safe.status
        : 500,
  };
}

export function safeContextExceeded<T>(error: T) {
  if (failureOrigin(error) === 'domain') return;
  const code = runErrorCode(error);
  const message = contextOverflowMessage(code);
  if (code && message) {
    const projected =
      code === EMBEDDING_CONTEXT_EXCEEDED
        ? new LlmError(message, code)
        : new HubError(message);
    return Object.assign(projected, { code, status: 400 });
  }
}

export function anthropicStreamCode<T>(error: T): string | undefined {
  for (const current of failureCauses(error)) {
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
  }
  return undefined;
}

/** Keep only status facts: provider messages may contain prompts or credentials. */
export function llmFailure<T>(error: T): string {
  if (contextExceededError(error)) return modelContextMessage;
  const streamCode = anthropicStreamCode(error);
  if (streamCode) return `LLM unavailable (${streamCode})`;
  if (findThrottled(error)) return 'LLM unavailable (HTTP 429)';
  for (const current of failureCauses(error)) {
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
  }
  return 'LLM unavailable (no response from model)';
}

/** A stream that has emitted content must never be restarted by an outer retry. */
export class StreamContentError extends LlmError {
  constructor(error: Error) {
    super(llmFailure(error), contextExceededError(error)?.code);
  }
}

function safeLlmError<T>(error: T): LlmError {
  const message = llmFailure(error);
  const facts = sanitizeFailure(error, { code: 'LLM_ERROR', message });
  if (contextOverflowMessage(facts.code))
    return Object.assign(new LlmError(facts.message, facts.code), facts);
  const safe = new LlmError(message, facts.code);
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
  return Object.assign(safe, {
    status: facts.status,
    retryAfterSeconds: facts.retryAfterSeconds,
  });
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
export function isLlmFailure<T>(error: T): boolean {
  return failureOrigin(error) === 'llm';
}

/** Client-facing text for both mapped and plain errors. */
export function failureMessage<T>(error: T): string {
  return (
    clientRunFailure(error)?.message ?? reportedMessage(error) ?? String(error)
  );
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
