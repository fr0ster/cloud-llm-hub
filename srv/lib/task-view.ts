import {
  MODEL_CONTEXT_EXCEEDED,
  type TaskRecord,
} from '@mcp-abap-adt/llm-agent';
import { modelContextMessage } from './llm-failure';

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
  | 'terminalErrorCode'
  | 'toolsSelected'
  | 'toolsAvailable'
  | 'toolCalls'
  | 'maxToolCalls'
> & { lastActivityAt?: number; currentAction?: string };
export function taskView(task: TaskView): TaskView {
  return {
    ...(task.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: task.lastActivityAt }),
    ...(task.currentAction === undefined
      ? {}
      : { currentAction: task.currentAction }),
    ...(task.toolsSelected === undefined
      ? {}
      : { toolsSelected: task.toolsSelected }),
    ...(task.toolsAvailable === undefined
      ? {}
      : { toolsAvailable: task.toolsAvailable }),
    ...(task.toolCalls === undefined ? {} : { toolCalls: task.toolCalls }),
    ...(task.maxToolCalls === undefined
      ? {}
      : { maxToolCalls: task.maxToolCalls }),
    id: task.id,
    worker: task.worker,
    goal: task.goal,
    state: task.state,
    createdAt: task.createdAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    ...(task.terminalErrorCode === MODEL_CONTEXT_EXCEEDED
      ? {
          terminalErrorCode: MODEL_CONTEXT_EXCEEDED,
          error: modelContextMessage,
        }
      : task.error === undefined
        ? {}
        : { error: task.error }),
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
  };
}
