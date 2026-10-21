import { AsyncLocalStorage } from 'node:async_hooks';

type ReviewSignals = {
  topToolScore?: number;
  completionTokens: number;
  model?: string;
};
const scope = new AsyncLocalStorage<ReviewSignals>();

export function runWithReviewSignals<T>(fn: () => T): T {
  return scope.run({ completionTokens: 0 }, fn);
}

export function getReviewSignals(): ReviewSignals | undefined {
  return scope.getStore();
}

export function recordToolScore(score: number): void {
  const signals = scope.getStore();
  if (signals && Number.isFinite(score)) {
    signals.topToolScore = Math.max(signals.topToolScore ?? -Infinity, score);
  }
}

export function recordCompletionTokens(
  model: string | undefined,
  tokens: number,
): void {
  const signals = scope.getStore();
  if (signals && Number.isFinite(tokens) && tokens >= 0) {
    signals.model = model;
    signals.completionTokens += tokens;
  }
}
