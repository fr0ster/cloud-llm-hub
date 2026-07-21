import type { PlannerInput } from '@mcp-abap-adt/llm-agent';
import { FixedExecutorPlanner } from '../../srv/lib/fixed-executor-planner';

function baseInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    prompt: 'do X',
    agents: [{ name: 'executor' }],
    sessionId: 's1',
    ...overrides,
  };
}

describe('FixedExecutorPlanner', () => {
  it('has the fixed-executor name and no model', () => {
    const planner = new FixedExecutorPlanner();
    expect(planner.name).toBe('fixed-executor');
    expect(planner.model).toBeUndefined();
  });

  it('plans exactly one node bound to the executor worker', async () => {
    const planner = new FixedExecutorPlanner();
    const { plan, usage } = await planner.plan(baseInput());

    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0].agent).toBe('executor');
    expect(typeof plan.createdAt).toBe('number');
    expect(usage).toBeUndefined();
  });

  it('is deterministic — no LLM call, same input yields an equivalent single-node plan', async () => {
    const planner = new FixedExecutorPlanner();
    const input = baseInput({ prompt: 'do the same thing again' });

    const first = await planner.plan(input);
    const second = await planner.plan(input);

    expect(first.plan.nodes).toEqual(second.plan.nodes);
  });

  it('uses the prompt as the node goal', async () => {
    const planner = new FixedExecutorPlanner();
    const { plan } = await planner.plan(
      baseInput({ prompt: 'do the specific thing' }),
    );

    expect(plan.nodes[0].goal).toBe('do the specific thing');
  });
});
