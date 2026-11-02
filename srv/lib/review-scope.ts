import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkerProfile } from '@mcp-abap-adt/llm-agent';

type ReviewSignals = {
  topToolScore?: number;
  completionTokens: number;
  model?: string;
};
const scope = new AsyncLocalStorage<ReviewSignals>();

export function runWithReviewSignals<T>(fn: () => T): T {
  return profileScope.run({ worker: false }, () =>
    scope.run({ completionTokens: 0 }, fn),
  );
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

// Mutable only within one request/worker execution; never stored on a destination.
const profileScope = new AsyncLocalStorage<{
  profile?: WorkerProfile;
  worker: boolean;
}>();

export function recordReviewProfile(profile: WorkerProfile): void {
  const current = profileScope.getStore();
  if (current && (current.worker || profile.name === 'executor'))
    current.profile = profile;
}

export function getReviewProfile(): WorkerProfile | undefined {
  return profileScope.getStore()?.profile;
}

export async function captureReviewProfile<T>(run: () => Promise<T>) {
  const current: { profile?: WorkerProfile; worker: boolean } = {
    worker: true,
  };
  const result = await profileScope.run(current, run);
  return { result, profile: current.profile };
}
