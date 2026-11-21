import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  CallOptions,
  IAgentProfileSource,
  Message,
} from '@mcp-abap-adt/llm-agent';
import type { getSmartAgent } from '../agent-manager';
import { runWithToolGateBypass } from '../request-session';
import { callOptionsFor } from './rag-caller';
import { currentRoleModel, roleOfProfile } from './role-models-scope';
import { waitForSessionTurns } from './session-turns';
import { assertToolSearchHealthy } from './tool-search-health';

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
    model,
  ]: ExecutorStepArgs
) {
  await assertToolSearchHealthy();
  if (
    !opts.caller ||
    !opts.caller.sessionId ||
    opts.sessionId !== opts.caller.sessionId
  )
    throw new Error('A bound caller with a matching session is required');
  const caller = opts.caller;
  await waitForSessionTurns(caller.sessionId, opts.signal);
  opts = { ...opts, ...callOptionsFor(caller) };
  return runWithToolGateBypass(async () => {
    if (worker !== 'executor') {
      if (!agentHandle.profileRunner)
        throw new Error('Destination profile runner unavailable');
      const source = createAgentProfileSource(userId);
      const profile = await source.get(worker, opts);
      if (!profile.ok) throw new Error(profile.error.message);
      const prompts = await source.getPrompts(opts);
      if (!prompts.ok) throw new Error(prompts.error.message);
      const prepared = await agentHandle.profileRunner.createWorker(
        {
          profile: profile.value,
          model:
            profile.value.result === 'report'
              ? (currentRoleModel(roleOfProfile(profile.value)) ?? model)
              : undefined,
          workerBase: prompts.value.workerBase,
        },
        opts,
      );
      if (!prepared.ok)
        throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
      const result = await prepared.value.run({
        task,
        ...opts,
        ...callOptionsFor(caller),
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
    return executorModel.run(currentRoleModel('executor') ?? model, () =>
      (agentHandle.executor ?? agentHandle.agent).process(
        [...history, { role: 'user', content: task }],
        opts,
      ),
    );
  });
}
