import type {
  CallOptions,
  IAgentProfileSource,
  Message,
  TokenUsage,
} from '@mcp-abap-adt/llm-agent';
import type { getSmartAgent } from '../agent-manager';
import { getRequestHistory, runWithToolGateBypass } from '../request-session';
import { renderNotice } from './notify-policy';
import {
  captureReviewProfile,
  getReviewSignals,
  recordReviewProfile,
} from './review-scope';
import { evaluateGated } from './step-reviewer';
import { resolverFor } from './trust-resolver';

export type ExecutorStepArgs = [
  agentHandle: Awaited<ReturnType<typeof getSmartAgent>>,
  userId: string,
  task: string,
  worker: string,
  opts: CallOptions,
  history?: Message[],
  onReviewerUsage?: (usage: TokenUsage | undefined) => void,
];

/** Executes within the caller's existing request, admission and connection scope. */
export async function runExecutorStep(
  createAgentProfileSource: (userId: string) => IAgentProfileSource,
  ...[
    agentHandle,
    userId,
    task,
    worker,
    opts,
    history = [],
    onReviewerUsage,
  ]: ExecutorStepArgs
) {
  const traceId = opts.trace?.traceId ?? '';
  const { result, profile: reviewedProfile } = await captureReviewProfile(() =>
    runWithToolGateBypass(async () => {
      if (worker !== 'executor') {
        if (!agentHandle.profileRunner)
          throw new Error('Destination profile runner unavailable');
        const source = createAgentProfileSource(userId);
        const profile = await source.get(worker, opts);
        if (!profile.ok) throw new Error(profile.error.message);
        recordReviewProfile(profile.value);
        const prompts = await source.getPrompts(opts);
        if (!prompts.ok) throw new Error(prompts.error.message);
        const prepared = await agentHandle.profileRunner.createWorker(
          {
            profile: profile.value,
            workerBase: prompts.value.workerBase,
          },
          opts,
        );
        if (!prepared.ok) throw new Error(prepared.error.message);
        const result = await prepared.value.run({
          task,
          ...opts,
          ...(history.length
            ? {
                context: `Previous session conversation:\n${JSON.stringify(history)}`,
              }
            : {}),
        });
        if (
          result.errorClass ||
          result.stopped ||
          result.status === 'awaiting-external'
        )
          return {
            ok: false as const,
            error: new Error(result.output || 'Worker did not complete'),
          };
        return {
          ok: true as const,
          value: {
            content: result.output,
            usage: result.usage,
            iterations: undefined,
            toolCallCount: undefined,
            stopReason: undefined,
          },
        };
      }
      return (agentHandle.executor ?? agentHandle.agent).process(
        [...history, { role: 'user', content: task }],
        opts,
      );
    }),
  );
  const toolTrust = reviewedProfile?.trust
    ? (agentHandle.toolTrustFor?.(
        (agentHandle.trustResolver ?? resolverFor({})).forProfile(
          reviewedProfile,
        ),
      ) ?? agentHandle.toolTrust)
    : agentHandle.toolTrust;
  if (
    result.ok &&
    agentHandle.executor &&
    agentHandle.recMcp &&
    agentHandle.criticLlm
  ) {
    const verdict = await evaluateGated({
      toolTrust,
      usage: opts.usage,
      content: result.value.content ?? '',
      records: agentHandle.recMcp.getToolRecords(traceId),
      ...getReviewSignals(),
      llm: agentHandle.criticLlm,
      request: task,
      task,
      history: getRequestHistory(),
    });
    onReviewerUsage?.(verdict.usage);
    if (!verdict.ok) {
      return {
        ...result,
        value: {
          ...result.value,
          content: (result.value.content ?? '') + renderNotice(verdict),
        },
      };
    }
  }
  return result;
}
