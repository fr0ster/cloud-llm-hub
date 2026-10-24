import type { TaskRecord } from '@mcp-abap-adt/llm-agent';

/** Task fields the WebUI shows; timestamps drive the elapsed time. */
export type TaskView = Pick<
  TaskRecord,
  'id' | 'worker' | 'goal' | 'state' | 'createdAt' | 'startedAt'
>;
export function taskView(task: TaskView): TaskView {
  return {
    id: task.id,
    worker: task.worker,
    goal: task.goal,
    state: task.state,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
  };
}
