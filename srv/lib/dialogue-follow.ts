import type { PlannerMessage } from '@mcp-abap-adt/llm-agent';
import type { Delivery } from './dialogue-outbox';
import type { DialogueHandle } from './dialogue-sessions';

export type FollowItem =
  | { kind: 'message'; message: PlannerMessage; written(): void }
  | {
      kind: 'end';
      reason:
        | 'done'
        | 'waiting_user'
        | 'idle'
        | 'limit'
        | 'superseded'
        | 'disconnected'
        | 'error';
      note?: string;
    };
type End = Extract<FollowItem, { kind: 'end' }>;
const follows = new WeakMap<
  DialogueHandle,
  { stop(): void; ended: Promise<void> }
>();
const superseded: End = {
  kind: 'end',
  reason: 'superseded',
  note: 'A new message arrived; the work continues in its response.',
};

export async function supersedeFollow(handle: DialogueHandle): Promise<void> {
  const previous = follows.get(handle);
  previous?.stop();
  await previous?.ended;
}

export function followDialogue(
  handle: DialogueHandle,
  opts: {
    delivery: Delivery;
    since: number;
    signal: AbortSignal;
    maxMs: number;
    now?: () => number;
  },
): AsyncIterable<FollowItem> {
  // Register eagerly so even simultaneous callers supersede in invocation order.
  const previous = follows.get(handle);
  previous?.stop();
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  let forced: End | undefined;
  let wake = () => {};
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const cleanup = () => {
    clearTimeout(timer);
    unsubscribe();
    opts.signal.removeEventListener('abort', abort);
    if (follows.get(handle) === current) follows.delete(handle);
    resolveEnded();
  };
  const abort = () => {
    forced = { kind: 'end', reason: 'disconnected' };
    if (!started) cleanup();
    wake();
  };
  const current = {
    stop() {
      forced ??= superseded;
      if (!started) cleanup();
      wake();
    },
    ended,
  };
  follows.set(handle, current);
  opts.signal.addEventListener('abort', abort, { once: true });
  if (opts.signal.aborted) abort();
  const iterator = (async function* (): AsyncGenerator<FollowItem, void> {
    started = true;
    const now = opts.now ?? Date.now;
    const startedAt = now();
    let evaluate = true;
    const yielded = new Set<string>();
    try {
      await previous?.ended;
      if (forced) {
        cleanup();
        yield forced;
        return;
      }
      unsubscribe = handle.subscribe((event) => {
        if (event.kind === 'settled') {
          evaluate = true;
        }
        wake();
      });
      timer = setTimeout(
        () => {
          const { done, total } = handle.state();
          forced ??= {
            kind: 'end',
            reason: 'limit',
            note:
              total === 0
                ? 'still running'
                : `still running: ${done} of ${total} steps done`,
          };
          wake();
        },
        Math.max(0, opts.maxMs - (now() - startedAt)),
      );
      while (true) {
        // Install the waiter before inspecting state to avoid losing notifications.
        const changed = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const state = handle.state();
        if (state.lastFailedSeq > opts.since)
          forced ??= { kind: 'end', reason: 'error' };
        if (forced) {
          cleanup();
          yield forced;
          return;
        }
        const message = handle.outbox
          .pending()
          .find(
            (message) =>
              !opts.delivery.has(message.id) && !yielded.has(message.id),
          );
        if (message) {
          yielded.add(message.id);
          yield {
            kind: 'message',
            message,
            written: () => opts.delivery.carried(message.id),
          };
          continue;
        }
        if (evaluate) {
          evaluate = false;
          if (!state.turnActive && state.queuedInputs === 0) {
            const reason =
              state.status === 'done' || state.status === 'waiting_user'
                ? state.status
                : state.idle
                  ? 'idle'
                  : undefined;
            if (reason) {
              cleanup();
              yield { kind: 'end', reason };
              return;
            }
          }
        }
        await changed;
      }
    } finally {
      cleanup();
    }
  })();
  const returnIterator = iterator.return.bind(iterator);
  iterator.return = (value) => {
    if (!started) cleanup();
    return returnIterator(value);
  };
  return iterator;
}
