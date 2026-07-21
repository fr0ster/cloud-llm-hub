/**
 * `IPlanner` that skips planning entirely: it always returns a 1-node DAG
 * bound to the `executor` worker, using the caller's prompt verbatim as the
 * node goal. No LLM call, no reasoning — deterministic by construction.
 *
 * The Task 1 vehicle spike pinned the exact `DagPlan`/`PlanNode` shapes and confirmed
 * `DagPlan.createdAt` is REQUIRED with no default, and that `node.agent` is
 * how a node binds to a worker in the `workers` Map passed to the DAG
 * coordinator.
 */

import type {
  DagPlan,
  IPlanner,
  PlannerInput,
  PlannerResult,
} from '@mcp-abap-adt/llm-agent';

export class FixedExecutorPlanner implements IPlanner {
  readonly name = 'fixed-executor';
  readonly model?: string;

  async plan(input: PlannerInput): Promise<PlannerResult> {
    const plan: DagPlan = {
      nodes: [{ id: 'exec', goal: input.prompt, agent: 'executor' }],
      createdAt: Date.now(),
    };
    return { plan };
  }
}
