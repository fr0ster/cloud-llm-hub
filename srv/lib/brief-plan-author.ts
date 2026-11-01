import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  CallOptions,
  PlanBrief,
  PlanRevisionInput,
} from '@mcp-abap-adt/llm-agent';
import { ProfilePlanAuthor } from '@mcp-abap-adt/llm-agent-libs';

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
  override create(brief: PlanBrief, options?: CallOptions) {
    return briefs.run(
      [brief.goal, brief.context].filter(Boolean).join('\n'),
      () => modes.run('create', () => super.create(brief, options)),
    );
  }
  override revise(input: PlanRevisionInput, options?: CallOptions) {
    return briefs.run(
      [input.brief?.goal, input.change, input.brief?.context]
        .filter(Boolean)
        .join('\n'),
      () => modes.run('revise', () => super.revise(input, options)),
    );
  }
}
