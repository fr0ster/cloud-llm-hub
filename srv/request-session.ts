// srv/request-session.ts

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Message } from '@mcp-abap-adt/llm-agent';
import { runWithReviewSignals } from './lib/review-scope';
import type { ToolQueryAnalysis } from './lib/tool-query-analyzer';

const als = new AsyncLocalStorage<{
  sessionId?: string;
  toolGateDecision?: Promise<ToolQueryAnalysis>;
  /**
   * The conversation BEFORE this request's new user message.
   *
   * It rides the request scope because the path it has to cross drops it. The
   * DAG coordinator composes each worker's prompt as a single deterministic
   * STRING (`composeNodeTask`: "Task: …"), and the executor hands that string
   * to the agent — which reads an array as a conversation and a string as a
   * lone message with no history. So the turns assembled by the channel reach
   * the planner and then stop, and every request looks like a first one.
   */
  history?: Message[];
}>();

export function runWithSessionId<T>(
  sessionId: string | undefined,
  fn: () => T,
  history?: Message[],
): T {
  return als.run({ sessionId, history }, () => runWithReviewSignals(fn));
}

export function getRequestSessionId(): string | undefined {
  return als.getStore()?.sessionId;
}

/** The turns preceding this request's new user message; empty when there are none. */
export function getRequestHistory(): Message[] {
  return als.getStore()?.history ?? [];
}

const toolGateScope = new AsyncLocalStorage<boolean>();
export function runWithToolGateBypass<T>(fn: () => T): T {
  return toolGateScope.run(true, fn);
}
export function isToolGateBypassed(): boolean {
  return toolGateScope.getStore() === true;
}

/** First search owns analysis; later searches retain their own search text. */
export async function requestToolGateDecision(
  text: string,
  analyze: () => Promise<ToolQueryAnalysis>,
): Promise<ToolQueryAnalysis> {
  const scope = als.getStore();
  if (!scope) return analyze();
  if (scope.toolGateDecision) {
    const decision = await scope.toolGateDecision;
    return { text, needsAbapSystem: decision.needsAbapSystem };
  }
  scope.toolGateDecision = analyze();
  return scope.toolGateDecision;
}
