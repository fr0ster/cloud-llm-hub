import { AsyncLocalStorage } from 'node:async_hooks';

export interface ActivityEvent {
  kind: 'activity';
  taskId: string;
  worker: string;
  action: string;
  at: number;
}
interface ActivityBoard {
  noteActivity(taskId: string, action: string): void;
}
function supportsActivity(board: object): board is ActivityBoard {
  return 'noteActivity' in board && typeof board.noteActivity === 'function';
}
/** The installed DialogueSession keeps its board private; inspect only this optional capability. */
export function noteBoardActivity(
  session: object,
  taskId: string,
  action: string,
): void {
  if (
    'board' in session &&
    typeof session.board === 'object' &&
    session.board !== null &&
    supportsActivity(session.board)
  )
    session.board.noteActivity(taskId, action);
}
const activity = new AsyncLocalStorage<(action: string) => void>();
export function reportWorkerActivity(
  action: 'llm call' | `tool ${string}`,
): void {
  activity.getStore()?.(action);
}
export function withWorkerActivity<T>(
  report: (action: string) => void,
  run: () => T,
): T {
  return activity.run(report, run);
}
export function taskActivity(
  taskId: string,
  worker: string,
  note: (action: string) => void,
  emit: (event: ActivityEvent) => void,
): (action: string) => void {
  let last: number | undefined;
  return (action) => {
    const at = Date.now();
    if (last !== undefined && at - last < 1000) return;
    last = at;
    note(action);
    emit({ kind: 'activity', taskId, worker, action, at });
  };
}
