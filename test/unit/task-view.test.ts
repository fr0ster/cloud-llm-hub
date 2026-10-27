import { type TaskView, taskView } from '../../srv/lib/task-view';

const task: TaskView = {
  id: 't1',
  worker: 'executor',
  goal: 'read',
  state: 'failed',
  createdAt: 100,
};
test('absent optional task fields stay absent', () => {
  expect(taskView(task)).toEqual(task);
  expect(Object.keys(taskView(task))).not.toContain('finishedAt');
  expect(Object.keys(taskView(task))).not.toContain('error');
});
test('task view carries finish time and error, truncates errors and omits output', () => {
  const record = {
    ...task,
    startedAt: 200,
    finishedAt: 900,
    error: 'x'.repeat(350),
    output: 'secret',
  };
  expect(taskView(record)).toEqual({
    ...task,
    startedAt: 200,
    finishedAt: 900,
    error: 'x'.repeat(300),
  });
  expect(taskView({ ...task, error: 'short' }).error).toBe('short');
  expect(taskView({ ...task, error: '', finishedAt: 0 })).toMatchObject({
    error: '',
    finishedAt: 0,
  });
});
