import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { trackCall } from './admission-scope';

/**
 * An `ILlm` whose calls register against the admission in scope.
 *
 * A stream is registered when the reader starts it and settles when the reader
 * stops, whether at the end, on an early `break`, or on a throw.
 */
export function trackedLlm(inner: ILlm): ILlm {
  const healthCheck = inner.healthCheck;
  const getModels = inner.getModels;
  return {
    get model() {
      return inner.model;
    },
    chat: (...args: Parameters<ILlm['chat']>) => trackCall(inner.chat(...args)),
    streamChat: (...args: Parameters<ILlm['streamChat']>) =>
      trackStream(inner.streamChat(...args)),
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
}

async function* trackStream<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  let done!: () => void;
  void trackCall(
    new Promise<void>((r) => {
      done = r;
    }),
  );
  try {
    for await (const chunk of source) yield chunk;
  } finally {
    done();
  }
}
