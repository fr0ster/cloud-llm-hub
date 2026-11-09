import type {
  AgentProfileError,
  CallOptions,
  IAgentProfileRunner,
  ISmartAgent,
  ISubAgent,
  Result,
  TrustMap,
  WorkerProfile,
} from '@mcp-abap-adt/llm-agent';
import {
  currentProfileTools,
  runWithProfileTools,
  runWithReadOnlyTools,
  runWithRequiredProfileTools,
} from '../request-session';
import {
  effectiveProfileTools,
  guardProfileWorker,
  type RegisteredProfileTool,
} from './agent-profile-tools';
import { runWithVerdictTools } from './checker-verdict-tool';
import { parseModelAllowlist, resolveAgentModel } from './model-policy';
import { withCompactRagSearch } from './rag-search-context';
import { recordReviewProfile } from './review-scope';
import {
  currentRoleModel,
  RoleModelNotAllowedError,
  roleOfProfile,
} from './role-models-scope';
import { runWithTrustResolver, type TrustResolver } from './trust-resolver';

export interface AgentProfileRunnerHost {
  trustResolver?(): TrustResolver;
  prepareTools?(role: string, options?: CallOptions): Promise<void>;
  plannerKnowledgeTools?(): string[];
  acceptsPolicyName?: (name: string) => boolean;
  catalogue(): readonly RegisteredProfileTool[];
  grants(): ReadonlySet<string>;
  buildWorker(
    profile: WorkerProfile,
    preamble: string,
    options?: CallOptions,
  ): Promise<ISubAgent>;
  buildPlanAuthor?(
    input: {
      systemPrompt: string;
      mode: 'create' | 'revise';
      trust?: TrustMap;
    },
    options?: CallOptions,
  ): Promise<ISmartAgent>;
  buildPlanner(
    systemPrompt: string,
    options?: CallOptions,
    trust?: TrustMap,
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
      acceptsPolicyName: this.host.acceptsPolicyName,
      catalogue: this.host.catalogue(),
      grants: this.host.grants(),
      result: profile.result,
      policy: profile.tools,
      parent,
    });
    const resolver = this.host.trustResolver?.().forProfile(profile);
    return <T>(run: () => T): T => {
      const scoped = () =>
        runWithVerdictTools(profile.result === 'verdict', () =>
          runWithRequiredProfileTools(() =>
            runWithProfileTools(permissions, () =>
              profile.tools === 'read-only' || profile.result === 'verdict'
                ? runWithReadOnlyTools(run)
                : run(),
            ),
          ),
        );
      return resolver ? runWithTrustResolver(resolver, scoped) : scoped();
    };
  }

  validateModel(model: string): Result<void, AgentProfileError> {
    return parseModelAllowlist().has(model)
      ? { ok: true, value: undefined }
      : {
          ok: false,
          error: { code: 'MODEL_NOT_ALLOWED', message: 'MODEL_NOT_ALLOWED' },
        };
  }

  async createWorker(
    input: { profile: WorkerProfile; workerBase?: string; model?: string },
    options?: CallOptions,
  ): Promise<Result<ISubAgent, AgentProfileError>> {
    const profile = structuredClone(input.profile);
    try {
      const requested = currentRoleModel(roleOfProfile(profile)) ?? input.model;
      const model = resolveAgentModel(
        { requested, profile: profile.model },
        parseModelAllowlist(),
        process.env.LLM_AGENT_MODEL ?? '',
      );
      if (
        !model.ok &&
        (requested !== undefined ||
          profile.model !== undefined ||
          process.env.LLM_AGENT_MODEL)
      )
        return {
          ok: false,
          error: { code: model.error, message: model.error },
        };
      if (model.ok) profile.model = model.value;
    } catch (error) {
      if (error instanceof RoleModelNotAllowedError)
        return {
          ok: false,
          error: { code: 'MODEL_NOT_ALLOWED', message: error.message },
        };
      throw error;
    }
    const parent = currentProfileTools();
    try {
      await this.host.prepareTools?.(profile.name, options);
      const catalogue = this.host.catalogue();
      effectiveProfileTools({
        acceptsPolicyName: this.host.acceptsPolicyName,
        catalogue,
        grants: new Set(catalogue.map((tool) => tool.name)),
        result: profile.result,
        policy: profile.tools,
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'invalid',
          message:
            error instanceof Error
              ? error.message
              : 'Invalid agent tool policy',
        },
      };
    }
    try {
      options?.signal?.throwIfAborted();
      const buildScope = this.bind(profile, parent);
      const worker = guardProfileWorker(
        await buildScope(() =>
          this.host.buildWorker(
            profile,
            [
              input.workerBase ?? '',
              profile.systemPrompt,
              'Hub RAG knowledge tools include collection_create, record_add and record_update for session results; coordinator persists them. Read-only refers to SAP/system mutations; knowledge storage is available subject to the effective tool policy.',
            ].join('\n'),
            options,
          ),
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
            recordReviewProfile(profile);
            return this.bind(profile, parent)(() => worker.run(request));
          },
        },
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof RoleModelNotAllowedError
            ? { code: 'MODEL_NOT_ALLOWED', message: error.message }
            : { code: 'unavailable', message: 'Agent worker unavailable' },
      };
    }
  }

  async preparePlanAuthor(
    input: {
      systemPrompt: string;
      mode: 'create' | 'revise';
      trust?: TrustMap;
    },
    options?: CallOptions,
  ): Promise<Result<ISmartAgent, AgentProfileError>> {
    try {
      options?.signal?.throwIfAborted();
      if (!this.host.buildPlanAuthor)
        throw new Error('Plan author unavailable');
      await this.host.prepareTools?.('planner', options);
      const bind = this.bind({
        name: 'planner-author',
        trust: input.trust,
        description: '',
        systemPrompt: input.systemPrompt,
        result: 'report',
        tools: {
          allow: [
            ...(this.host.plannerKnowledgeTools?.() ?? []),
            'rag_search',
            'rag_read',
            'collection_records',
            'collections_list',
          ],
        },
      });
      const scope = <T>(run: () => T): T =>
        withCompactRagSearch(() => bind(run));
      const build = this.host.buildPlanAuthor;
      const agent = await scope(() => build(input, options));
      options?.signal?.throwIfAborted();
      return {
        ok: true,
        value: {
          streamProcess: async function* (message, callOptions) {
            const stream = scope(() =>
              agent.streamProcess(message, callOptions),
            );
            const iterator = stream[Symbol.asyncIterator]();
            try {
              while (true) {
                const next = await scope(() => iterator.next());
                if (next.done) return;
                yield next.value;
              }
            } finally {
              await scope(() => iterator.return?.());
            }
          },
          process: (message, callOptions) =>
            scope(() => agent.process(message, callOptions)),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof RoleModelNotAllowedError
            ? { code: 'MODEL_NOT_ALLOWED', message: error.message }
            : { code: 'unavailable', message: 'Plan author unavailable' },
      };
    }
  }

  async preparePlanner(
    input: { systemPrompt: string; trust?: TrustMap },
    options?: CallOptions,
  ): Promise<Result<ISmartAgent, AgentProfileError>> {
    try {
      options?.signal?.throwIfAborted();
      const resolver = this.host.trustResolver?.().forProfile(input);
      const scope = <T>(run: () => T): T =>
        resolver ? runWithTrustResolver(resolver, run) : run();
      const planner = scopedAgent(
        await scope(() =>
          this.host.buildPlanner(input.systemPrompt, options, input.trust),
        ),
        scope,
      );
      options?.signal?.throwIfAborted();
      return { ok: true, value: planner };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof RoleModelNotAllowedError
            ? { code: 'MODEL_NOT_ALLOWED', message: error.message }
            : { code: 'unavailable', message: 'Agent planner unavailable' },
      };
    }
  }
}

function scopedAgent(
  agent: ISmartAgent,
  scope: <T>(run: () => T) => T,
): ISmartAgent {
  return {
    process: (messages, options) =>
      scope(() => agent.process(messages, options)),
    streamProcess: async function* (messages, options) {
      const iterator = scope(() => agent.streamProcess(messages, options))[
        Symbol.asyncIterator
      ]();
      try {
        for (;;) {
          const next = await scope(() => iterator.next());
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await scope(() => iterator.return?.());
      }
    },
  };
}
