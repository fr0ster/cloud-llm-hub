import type { TokenUsage } from '@mcp-abap-adt/llm-agent';
import {
  dialogueUsageToWire,
  sumPlannerUsage,
  tokenUsageToWire,
} from '../../srv/lib/usage-wire';

const usage: TokenUsage = {
  promptTokens: 3,
  completionTokens: 2,
  totalTokens: 5,
  models: {
    m: { promptTokens: 3, completionTokens: 2, totalTokens: 5, requests: 1 },
  },
};
it('maps totals and model entries', () => {
  expect(tokenUsageToWire(usage)).toEqual({
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
    models: {
      m: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        requests: 1,
      },
    },
  });
});
it('sums every delivered planner and task with task identity', () => {
  const result = dialogueUsageToWire(
    sumPlannerUsage([
      { planner: usage },
      { planner: usage, tasks: [{ id: 't1', worker: 'executor', usage }] },
    ]),
  );
  expect(result).toEqual({
    prompt_tokens: 9,
    completion_tokens: 6,
    total_tokens: 15,
    models: {
      m: {
        prompt_tokens: 9,
        completion_tokens: 6,
        total_tokens: 15,
        requests: 3,
      },
    },
    x_hub: {
      planner: {
        prompt_tokens: 6,
        completion_tokens: 4,
        total_tokens: 10,
        models: {
          m: {
            prompt_tokens: 6,
            completion_tokens: 4,
            total_tokens: 10,
            requests: 2,
          },
        },
      },
      subagents: [
        { ...tokenUsageToWire(usage), task_id: 't1', worker: 'executor' },
      ],
    },
  });
});
it('leaves absent usage absent', () => {
  expect(tokenUsageToWire(undefined)).toBeUndefined();
  expect(dialogueUsageToWire(sumPlannerUsage([undefined, {}]))).toBeUndefined();
});

it('sums planner durations and takes the maximum duration per task', () => {
  const result = sumPlannerUsage(
    [
      {
        planner: usage,
        plannerMs: 100,
        tasks: [{ id: 't1', worker: 'executor', usage, durationMs: 300 }],
      },
      {
        planner: usage,
        plannerMs: 200,
        tasks: [{ id: 't1', worker: 'executor', usage, durationMs: 250 }],
      },
      { planner: usage, tasks: [{ id: 't1', worker: 'executor', usage }] },
    ],
    { durationMs: 900 },
  );
  expect(result?.x_hub).toMatchObject({
    duration_ms: 900,
    planner: { duration_ms: 300 },
    subagents: [{ task_id: 't1', duration_ms: 300 }],
  });
});
it('omits unknown durations and preserves known zero durations', () => {
  const result = sumPlannerUsage([
    { planner: usage, tasks: [{ id: 't1', worker: 'executor', usage }] },
  ]);
  expect(result?.x_hub).not.toHaveProperty('duration_ms');
  expect(result?.x_hub.planner).not.toHaveProperty('duration_ms');
  expect(result?.x_hub.subagents?.[0]).not.toHaveProperty('duration_ms');
  expect(
    sumPlannerUsage([{ planner: usage, plannerMs: 0 }], { durationMs: 0 })
      ?.x_hub,
  ).toMatchObject({ duration_ms: 0, planner: { duration_ms: 0 } });
});

it.each([0, 120])(
  'preserves planner duration %s without planner tokens',
  (plannerMs: number) => {
    const result = sumPlannerUsage([
      {
        plannerMs,
        tasks: [{ id: 't1', worker: 'executor', usage }],
      },
    ]);
    expect(result).toEqual({
      ...usage,
      x_hub: {
        planner: { duration_ms: plannerMs },
        subagents: [
          { ...tokenUsageToWire(usage), task_id: 't1', worker: 'executor' },
        ],
      },
    });
  },
);
