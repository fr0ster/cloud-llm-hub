import type {
  AdaptiveStep,
  ControllerPlanInput,
  IAdaptiveController,
  StepRecord,
} from '@mcp-abap-adt/llm-agent';
import { CheckerAdaptiveController } from '../../srv/agent-manager';

it.each(['off', 'on'] as const)(
  '%s gates previous-run planning input while preserving current-run checks, revisions and reports',
  async (clientHistory) => {
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
    const controller = new CheckerAdaptiveController(inner, clientHistory);
    expect(controller.name).toBe('test');
    expect(controller.model).toBe('model');
    const input: ControllerPlanInput = {
      request: 'test',
      history: [],
      workers: [],
      previousRun: {
        runId: 'previous-run',
        request: 'EARLIER_REQUEST',
        plan: { steps: [], createdAt: 1 },
        steps: [],
        outcome: 'answered',
        finishedAt: 2,
      },
    };
    const plan = await controller.plan(input);
    expect(inner.plan).toHaveBeenCalledWith({
      ...input,
      previousRun: undefined,
    });
    expect(input.previousRun?.request).toBe('EARLIER_REQUEST');
    const records: StepRecord[] = [
      {
        stepId: 'w',
        kind: 'work',
        run: 1,
        status: 'done',
        output: 'CURRENT_TURN_RESULT',
        durationMs: 1,
      },
    ];
    const revise = {
      request: 'test',
      plan: plan.plan,
      records,
      reason: 'retry',
    };
    const revision = await controller.revise(revise);
    expect(inner.revise).toHaveBeenCalledWith(revise);
    for (const result of [plan.plan.steps, revision.steps]) {
      expect(result[0]).toMatchObject({ worker: 'checker' });
      expect(result[1]).toBe(steps[1]);
      expect(result[2]).toBe(steps[2]);
    }
    expect(steps[0]).toMatchObject({ worker: 'executor' });
    const check = {
      request: 'test',
      step: steps[0],
      targets: records,
    } as Parameters<IAdaptiveController['check']>[0];
    await controller.check(check);
    expect(inner.check).toHaveBeenCalledWith(check);
    const report = {
      request: 'test',
      plan: plan.plan,
      records,
      stopReason: 'done',
    };
    await controller.report(report);
    expect(inner.report).toHaveBeenCalledWith(report);
  },
);
