import { AsyncLocalStorage } from 'node:async_hooks';
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

const executorModel = new AsyncLocalStorage<string | undefined>();

export function currentExecutorModel(): string | undefined {
  return executorModel.getStore();
}

export type ExecutorStepArgs = [
  agentHandle: Awaited<ReturnType<typeof getSmartAgent>>,
  userId: string,
  task: string,
  worker: string,
  opts: CallOptions,
  history?: Message[],
  onReviewerUsage?: (usage: TokenUsage | undefined) => void,
  model?: string,
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
    model,
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
            model,
            workerBase: prompts.value.workerBase,
          },
          opts,
        );
        if (!prepared.ok)
          throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
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
      return executorModel.run(model, () =>
        (agentHandle.executor ?? agentHandle.agent).process(
          [...history, { role: 'user', content: task }],
          opts,
        ),
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
