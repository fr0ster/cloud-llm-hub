import type {
  AdaptiveStep,
  IAdaptiveController,
} from '@mcp-abap-adt/llm-agent';
import { CheckerAdaptiveController } from '../../srv/agent-manager';

it('rewrites plan and revision checks only, and delegates controller metadata and calls', async () => {
  const steps: AdaptiveStep[] = [
    {
      id: 'c',
      kind: 'check',
      worker: 'executor',
      goal: 'verify',
      targets: [],
      onPass: 'end',
      onFail: 'end',
    },
    {
      id: 's',
      kind: 'check',
      worker: 'self',
      goal: 'verify',
      targets: [],
      onPass: 'end',
      onFail: 'end',
    },
    { id: 'w', kind: 'work', worker: 'executor', goal: 'work' },
  ];
  const inner: IAdaptiveController = {
    name: 'test',
    model: 'model',
    plan: jest.fn(async () => ({ plan: { steps, createdAt: 1 } })),
    revise: jest.fn(async () => ({ steps })),
    check: jest.fn(),
    report: jest.fn(),
  };
  const controller = new CheckerAdaptiveController(inner);
  expect(controller.name).toBe('test');
  expect(controller.model).toBe('model');
  const plan = await controller.plan({
    request: 'test',
    history: [],
    workers: [],
  });
  const revision = await controller.revise({
    request: 'test',
    plan: plan.plan,
    records: [],
    reason: 'retry',
  });
  for (const result of [plan.plan.steps, revision.steps]) {
    expect(result[0]).toMatchObject({ worker: 'checker' });
    expect(result[1]).toBe(steps[1]);
    expect(result[2]).toBe(steps[2]);
  }
  expect(steps[0]).toMatchObject({ worker: 'executor' });
  const check = { request: 'test', step: steps[0], targets: [] } as Parameters<
    IAdaptiveController['check']
  >[0];
  await controller.check(check);
  expect(inner.check).toHaveBeenCalledWith(check);
  const report = {
    request: 'test',
    plan: plan.plan,
    records: [],
    stopReason: 'done',
  };
  await controller.report(report);
  expect(inner.report).toHaveBeenCalledWith(report);
});
