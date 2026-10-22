import { EventEmitter } from 'node:events';
import { handleDialogueEvents } from '../../srv/lib/dialogue-events-handler';

jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: { context: { user: { id: 'alice' } } },
}));
jest.mock('../../srv/agent-config', () => ({
  getAgentConfig: () => ({
    agent: { chatCoordinator: 'dialogue' },
    mcp: { destination: 'DEV' },
  }),
}));
const pending = [{ id: 'm1', text: 'hello', createdAt: 123 }];
let listener: (e: any) => void;
const unsubscribe = jest.fn();
const takePending = jest.fn(() => pending.splice(0));
jest.mock('../../srv/lib/dialogue-sessions', () => ({
  dialogueFor: jest.fn(async () => ({
    session: { takePending },
    subscribe: (fn: any) => {
      listener = fn;
      return unsubscribe;
    },
  })),
}));
const touch = jest.fn();
jest.mock('../../srv/lib/long-session', () => ({
  longSessionsIfReady: () => ({ touch }),
}));

function response() {
  return Object.assign(new EventEmitter(), {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  });
}
test('pending once across reconnect, live messages/tasks, heartbeat and disconnect cleanup', async () => {
  jest.useFakeTimers();
  const req = {
    longSession: { userId: 'alice', key: 'ls-a', destination: 'DEV' },
  };
  const res = response();
  await handleDialogueEvents(req as any, res as any);
  expect(res.write).toHaveBeenCalledWith(
    'event: message\ndata: {"id":"m1","text":"hello","createdAt":123}\n\n',
  );
  listener({
    kind: 'task',
    task: { id: 't', worker: 'executor', goal: 'read', state: 'done' },
  });
  expect(res.write).toHaveBeenLastCalledWith(
    expect.stringContaining('event: task'),
  );
  listener({
    kind: 'message',
    message: { id: 'm2', text: 'live', createdAt: 124 },
  });
  expect(res.write).toHaveBeenLastCalledWith(expect.stringContaining('live'));
  jest.advanceTimersByTime(15000);
  expect(res.write).toHaveBeenLastCalledWith(': heartbeat\n\n');
  // The open channel keeps the session alive: each heartbeat is activity.
  expect(touch).toHaveBeenCalledWith('alice', 'ls-a');
  res.emit('close');
  touch.mockClear();
  jest.advanceTimersByTime(30000);
  expect(touch).not.toHaveBeenCalled();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  const again = response();
  await handleDialogueEvents(req as any, again as any);
  expect(again.write).not.toHaveBeenCalled();
  expect(takePending()).toEqual([]); // next chat sees no delivered pending
  again.emit('close');
  jest.useRealTimers();
});
test.each([undefined, { userId: 'bob', key: 'ls-a' }])(
  'missing or foreign session is 404',
  async (longSession) => {
    const res = response();
    await handleDialogueEvents({ longSession } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(404);
  },
);
