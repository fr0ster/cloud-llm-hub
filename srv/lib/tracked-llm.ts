import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { trackCall } from './admission-scope';

const tracked = new WeakSet<ILlm>();

/**
 * An `ILlm` whose calls register against the admission in scope.
 *
 * A stream is registered when the reader starts it and settles when the reader
 * stops, whether at the end, on an early `break`, or on a throw.
 */
export function trackedLlm(inner: ILlm): ILlm {
  const healthCheck = inner.healthCheck;
  const getModels = inner.getModels;
  const register = !tracked.has(inner);
  const wrapped: ILlm = {
    get model() {
      return inner.model;
    },
    chat: async (...args: Parameters<ILlm['chat']>) => {
      const call = inner.chat(...args);
      return register ? trackCall(call) : call;
    },
    streamChat: (...args: Parameters<ILlm['streamChat']>) =>
      trackStream(inner.streamChat(...args), register),
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
  register: boolean,
): ReturnType<ILlm['streamChat']> {
  let done = () => {};
  if (register)
    void trackCall(
      new Promise<void>((r) => {
        done = r;
      }),
    );
  try {
    yield* source;
  } finally {
    done();
  }
}
