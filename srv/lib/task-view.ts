import type { TaskRecord } from '@mcp-abap-adt/llm-agent';

/** Task fields the WebUI shows; timestamps drive the elapsed time. */
export type TaskView = Pick<
  TaskRecord,
  | 'id'
  | 'worker'
  | 'goal'
  | 'state'
  | 'createdAt'
  | 'startedAt'
  | 'finishedAt'
  | 'error'
>;
export function taskView(task: TaskView): TaskView {
  return {
    id: task.id,
    worker: task.worker,
    goal: task.goal,
    state: task.state,
    createdAt: task.createdAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    ...(task.error === undefined ? {} : { error: task.error.slice(0, 300) }),
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
  };
}
