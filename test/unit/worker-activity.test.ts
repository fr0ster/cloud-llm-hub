import type { ILlm, IMcpClient } from '@mcp-abap-adt/llm-agent';
import { reliableLlm } from '../../srv/lib/llm-failure';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  reportWorkerActivity,
  taskActivity,
  withWorkerActivity,
} from '../../srv/lib/worker-activity';

afterEach(() => jest.useRealTimers());
test('throttles activity independently per task', () => {
  jest.useFakeTimers();
  const noteActivity = jest.fn();
  const emit = jest.fn();
  const first = taskActivity(
    't1',
    'executor',
    (action) => noteActivity('t1', action),
    emit,
  );
  const second = taskActivity(
    't2',
    'checker',
    (action) => noteActivity('t2', action),
    emit,
  );
  withWorkerActivity(first, () => {
    reportWorkerActivity('tool ReadObject');
    reportWorkerActivity('llm call');
  });
  second('llm call');
  expect(noteActivity.mock.calls).toEqual([
    ['t1', 'tool ReadObject'],
    ['t2', 'llm call'],
  ]);
  jest.advanceTimersByTime(1000);
  first('llm call');
  expect(emit).toHaveBeenCalledTimes(3);
  expect(emit).toHaveBeenLastCalledWith({
    kind: 'activity',
    taskId: 't1',
    worker: 'executor',
    action: 'llm call',
    at: Date.now(),
  });
});

test('tool and model boundaries report starts with no arguments, prompts or results', async () => {
  const report = jest.fn();
  const inner: IMcpClient = {
    listTools: jest.fn(),
    healthCheck: jest.fn(),
    callTool: async () => {
      expect(report).toHaveBeenLastCalledWith('tool GetTable');
      return { ok: true, value: { content: 'secret result' } };
    },
  };
  const llm: ILlm = {
    chat: async () => {
      expect(report).toHaveBeenLastCalledWith('llm call');
      return {
        ok: true,
        value: { content: 'secret answer', finishReason: 'stop' },
      };
    },
    async *streamChat() {
      expect(report).toHaveBeenLastCalledWith('llm call');
      yield { ok: true, value: { content: 'secret delta' } };
    },
  };
  await withWorkerActivity(report, async () => {
    await new RecordingMcpClient(inner).callTool('GetTable', {
      password: 'secret argument',
    });
    const client = reliableLlm(llm);
    await client.chat([{ role: 'user', content: 'secret prompt' }]);
    for await (const chunk of client.streamChat([]))
      expect(chunk.ok).toBe(true);
  });
  expect(report.mock.calls).toEqual([
    ['tool GetTable'],
    ['llm call'],
    ['llm call'],
  ]);
});
