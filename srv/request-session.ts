// srv/request-session.ts

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Message } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { AgentToolPermissions } from './lib/agent-profile-tools';
import { runWithReviewSignals } from './lib/review-scope';
import type { ToolQueryAnalysis } from './lib/tool-query-analyzer';

const als = new AsyncLocalStorage<{
  sessionId?: string;
  userId?: string;
  ragIdentity?: RagCallerIdentity;
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

export interface RagCallerIdentity {
  readonly admin: boolean;
  readonly channel: 'openai' | 'anthropic' | 'mcp-agent';
}
export function getRagCallerIdentity(): RagCallerIdentity {
  return (
    als.getStore()?.ragIdentity ?? {
      admin: cds.context?.user?.is?.('MCP_Admin') ?? false,
      channel: 'openai',
    }
  );
}
export function runWithSessionId<T>(
  sessionId: string | undefined,
  fn: () => T,
  history?: Message[],
  userId?: string,
  ragIdentity: RagCallerIdentity = getRagCallerIdentity(),
): T {
  return als.run({ sessionId, history, userId, ragIdentity }, () =>
    runWithReviewSignals(fn),
  );
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

export function getRequestUserId(): string | undefined {
  const userId = als.getStore()?.userId;
  return userId && userId !== 'anonymous' ? userId : undefined;
}
const readOnlyTools = new AsyncLocalStorage<boolean>();
const profileTools = new AsyncLocalStorage<
  Pick<AgentToolPermissions, 'allows'>
>();
/** Nested scopes can only narrow the parent's permissions. */
export function runWithProfileTools<T>(
  permissions: AgentToolPermissions,
  fn: () => T,
): T {
  const parent = profileTools.getStore();
  if (!parent) return profileTools.run(permissions, fn);
  return profileTools.run(
    {
      allows: (name: string) => parent.allows(name) && permissions.allows(name),
    },
    fn,
  );
}

export function profileToolAllowed(name: string): boolean {
  return (
    profileTools.getStore()?.allows(name) ?? !requiredProfileTools.getStore()
  );
}

/** Capture a parent's immutable ceiling before crossing a deferred worker boundary. */
export function currentProfileTools():
  | Pick<AgentToolPermissions, 'allows'>
  | undefined {
  return (
    profileTools.getStore() ??
    (requiredProfileTools.getStore() ? { allows: () => false } : undefined)
  );
}
export function runWithReadOnlyTools<T>(fn: () => T): T {
  return readOnlyTools.run(true, fn);
}
export function isReadOnlyTools(): boolean {
  return readOnlyTools.getStore() === true;
}

/** Worker entry points mark scope as required; a lost policy fails closed. */
const requiredProfileTools = new AsyncLocalStorage<boolean>();
export function runWithRequiredProfileTools<T>(fn: () => T): T {
  return requiredProfileTools.run(true, fn);
}

export function hasProfileToolScope(): boolean {
  return (
    profileTools.getStore() !== undefined ||
    requiredProfileTools.getStore() === true
  );
}
