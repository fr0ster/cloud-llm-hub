import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { trackCall } from './admission-scope';
import { recordCompletionTokens } from './review-scope';

const tracked = new WeakSet<ILlm>();

/**
 * An `ILlm` whose calls register against the admission in scope.
 *
 * A stream is registered when the reader starts it and settles when the reader
 * stops, whether at the end, on an early `break`, or on a throw.
 */
export function trackedLlm(inner: ILlm, captureCompletionTokens = false): ILlm {
  const healthCheck = inner.healthCheck;
  const getModels = inner.getModels;
  const register = !tracked.has(inner);
  const wrapped: ILlm = {
    get model() {
      return inner.model;
    },
    chat: async (...args: Parameters<ILlm['chat']>) => {
      const call = inner.chat(...args);
      const result = await (register ? trackCall(call) : call);
      if (captureCompletionTokens && result.ok && result.value.usage) {
        recordCompletionTokens(
          args[2]?.model ?? inner.model,
          result.value.usage.completionTokens,
        );
      }
      return result;
    },
    streamChat: (...args: Parameters<ILlm['streamChat']>) =>
      trackStream(
        inner.streamChat(...args),
        captureCompletionTokens,
        args[2]?.model ?? inner.model,
        register,
      ),
    ...(healthCheck
      ? {
          healthCheck: (...a: Parameters<NonNullable<ILlm['healthCheck']>>) =>
            healthCheck.call(inner, ...a),
        }
      : {}),
    ...(getModels
      ? {
          getModels: (...a: Parameters<NonNullable<ILlm['getModels']>>) =>
            getModels.call(inner, ...a),
        }
      : {}),
  };
  tracked.add(wrapped);
  return wrapped;
}

async function* trackStream(
  source: ReturnType<ILlm['streamChat']>,
  capture: boolean,
  model: string | undefined,
  register: boolean,
): ReturnType<ILlm['streamChat']> {
  let done = () => {};
  if (register)
    void trackCall(
      new Promise<void>((r) => {
        done = r;
      }),
    );
  let completionTokens: number | undefined;
  try {
    for await (const chunk of source) {
      if (chunk.ok && chunk.value.usage) {
        completionTokens = chunk.value.usage.completionTokens;
      }
      yield chunk;
    }
  } finally {
    if (capture && completionTokens !== undefined) {
      recordCompletionTokens(model, completionTokens);
    }
    done();
  }
}
