import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  CallOptions,
  PlanBrief,
  PlanRevisionInput,
  RagCaller,
} from '@mcp-abap-adt/llm-agent';
import { ProfilePlanAuthor } from '@mcp-abap-adt/llm-agent-libs';
import { callOptionsFor } from './rag-caller';

const briefs = new AsyncLocalStorage<string>();
const modes = new AsyncLocalStorage<'create' | 'revise'>();
export function planAuthorMode(): 'create' | 'revise' {
  return modes.getStore() ?? 'create';
}
export function planAuthorBriefRequest() {
  return {
    id: 'plan-author-brief',
    openedAt: Date.now(),
    text: briefs.getStore() ?? '',
  };
}

/** Keep the brief available to the library notes callback across concurrent calls. */
export class BriefPlanAuthor extends ProfilePlanAuthor {
  private readonly caller: RagCaller;

  constructor(
    options: ConstructorParameters<typeof ProfilePlanAuthor>[0] & {
      caller: RagCaller;
    },
  ) {
    super(options);
    this.caller = options.caller;
  }

  private trustedOptions(options?: CallOptions): CallOptions {
    if (options?.caller !== undefined && options.caller !== this.caller)
      throw new Error('Plan author caller does not match the trusted caller');
    if (
      options?.sessionId !== undefined &&
      options.sessionId !== this.caller.sessionId
    )
      throw new Error('Plan author session does not match the trusted caller');
    return { ...options, ...callOptionsFor(this.caller) };
  }

  override create(brief: PlanBrief, options?: CallOptions) {
    const trusted = this.trustedOptions(options);
    return briefs.run(
      [brief.goal, brief.context].filter(Boolean).join('\n'),
      () => modes.run('create', () => super.create(brief, trusted)),
    );
  }
  override revise(input: PlanRevisionInput, options?: CallOptions) {
    const trusted = this.trustedOptions(options);
    return briefs.run(
      [input.brief?.goal, input.change, input.brief?.context]
        .filter(Boolean)
        .join('\n'),
      () => modes.run('revise', () => super.revise(input, trusted)),
    );
  }
}
