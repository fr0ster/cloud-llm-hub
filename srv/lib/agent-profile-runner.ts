import type {
  AgentProfileError,
  CallOptions,
  IAgentProfileRunner,
  ISmartAgent,
  ISubAgent,
  Result,
  WorkerProfile,
} from '@mcp-abap-adt/llm-agent';
import {
  currentProfileTools,
  runWithProfileTools,
  runWithRequiredProfileTools,
} from '../request-session';
import {
  effectiveProfileTools,
  guardProfileWorker,
  type RegisteredProfileTool,
} from './agent-profile-tools';

export interface AgentProfileRunnerHost {
  catalogue(): readonly RegisteredProfileTool[];
  grants(): ReadonlySet<string>;
  buildWorker(
    profile: WorkerProfile,
    preamble: string,
    options?: CallOptions,
  ): Promise<ISubAgent>;
  buildPlanner(
    systemPrompt: string,
    options?: CallOptions,
  ): Promise<ISmartAgent>;
}

/** Each resolution builds a new worker; only immutable permissions cross runs. */
export class AgentProfileRunner implements IAgentProfileRunner {
  constructor(private readonly host: AgentProfileRunnerHost) {}

  bind(
    profile: WorkerProfile,
    parent = currentProfileTools(),
  ): <T>(run: () => T) => T {
    const permissions = effectiveProfileTools({
      catalogue: this.host.catalogue(),
      grants: this.host.grants(),
      result: profile.result,
      policy: profile.tools,
      parent,
    });
    return <T>(run: () => T): T =>
      runWithRequiredProfileTools(() => runWithProfileTools(permissions, run));
  }

  async createWorker(
    input: { profile: WorkerProfile; workerBase?: string },
    options?: CallOptions,
  ): Promise<Result<ISubAgent, AgentProfileError>> {
    const profile = structuredClone(input.profile);
    const parent = currentProfileTools();
    try {
      const catalogue = this.host.catalogue();
      effectiveProfileTools({
        catalogue,
        grants: new Set(catalogue.map((tool) => tool.name)),
        result: profile.result,
        policy: profile.tools,
      });
    } catch {
      return {
        ok: false,
        error: { code: 'invalid', message: 'Invalid agent tool policy' },
      };
    }
    try {
      options?.signal?.throwIfAborted();
      const worker = guardProfileWorker(
        await this.host.buildWorker(
          profile,
          [input.workerBase ?? '', profile.systemPrompt].join('\n'),
          options,
        ),
      );
      options?.signal?.throwIfAborted();
      return {
        ok: true,
        value: {
          name: worker.name,
          description: worker.description,
          capabilities: worker.capabilities,
          run: (request) => {
            return this.bind(profile, parent)(() => worker.run(request));
          },
        },
      };
    } catch {
      return {
        ok: false,
        error: { code: 'unavailable', message: 'Agent worker unavailable' },
      };
    }
  }

  async preparePlanner(
    input: { systemPrompt: string },
    options?: CallOptions,
  ): Promise<Result<ISmartAgent, AgentProfileError>> {
    try {
      options?.signal?.throwIfAborted();
      const planner = await this.host.buildPlanner(input.systemPrompt, options);
      options?.signal?.throwIfAborted();
      return { ok: true, value: planner };
    } catch {
      return {
        ok: false,
        error: { code: 'unavailable', message: 'Agent planner unavailable' },
      };
    }
  }
}
