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
