import { EventEmitter } from 'node:events';
import {
  handleDialogueAck,
  handleDialogueEvents,
} from '../../srv/lib/dialogue-events-handler';

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
const ack = jest.fn(async (id: string) => {
  const index = pending.findIndex((m) => m.id === id);
  if (index >= 0) pending.splice(0, index + 1);
});
let taskState = 'running';
beforeEach(() => {
  pending.splice(0, pending.length, {
    id: 'm1',
    text: 'hello',
    createdAt: 123,
  });
  taskState = 'running';
  jest.clearAllMocks();
});
jest.mock('../../srv/lib/dialogue-sessions', () => ({
  dialogueFor: jest.fn(async () => ({
    session: {
      takePending,
      snapshot: () => ({
        tasks: [
          { id: 'task', worker: 'executor', goal: 'read', state: taskState },
        ],
      }),
    },
    drainPending: async () => {},
    outbox: {
      replay: (after?: string) =>
        pending.slice(
          (after ? pending.findIndex((m) => m.id === after) : -1) + 1,
        ),
      ack,
    },
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
test('unacknowledged replay across reconnect, live messages/tasks, heartbeat and disconnect cleanup', async () => {
  jest.useFakeTimers();
  const req = {
    longSession: { userId: 'alice', key: 'ls-a', destination: 'DEV' },
  };
  const res = response();
  await handleDialogueEvents(req as any, res as any);
  expect(res.write).toHaveBeenCalledWith(
    'id: m1\nevent: message\ndata: {"id":"m1","text":"hello","createdAt":123}\n\n',
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
  expect(again.write).toHaveBeenCalledWith(expect.stringContaining('id: m1'));
  expect(again.write.mock.calls[0][0]).toContain('event: tasks');
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

test('Last-Event-ID skips rendered prefix, ack removes it, ownership is enforced', async () => {
  const req = {
    headers: { 'last-event-id': 'm1' },
    longSession: { userId: 'alice', key: 'ls-a' },
    body: { id: 'm1' },
  };
  const res = response();
  await handleDialogueEvents(req as any, res as any);
  expect(res.write).toHaveBeenCalledTimes(1); // snapshot only
  await handleDialogueAck(req as any, response() as any);
  expect(pending).toEqual([]);
  expect(ack).toHaveBeenCalledWith('m1');
  const denied = response();
  await handleDialogueAck(
    { ...req, longSession: { userId: 'bob', key: 'ls-a' } } as any,
    denied as any,
  );
  expect(denied.status).toHaveBeenCalledWith(404);
  res.emit('close');
});
test.each(['running', 'done'])(
  'reconnect snapshots current %s tasks before replay',
  async (state) => {
    taskState = state;
    const res = response();
    await handleDialogueEvents(
      { longSession: { userId: 'alice', key: 'ls-a' } } as any,
      res as any,
    );
    expect(res.write.mock.calls[0][0]).toContain('event: tasks');
    expect(res.write.mock.calls[0][0]).toContain(`"state":"${state}"`);
    expect(res.write.mock.calls[1][0]).toContain('id: m1');
    res.emit('close');
  },
);
test('failed SSE write retains message for reconnect and cleans subscriber', async () => {
  const req = { longSession: { userId: 'alice', key: 'ls-a' } };
  const broken = response();
  broken.write.mockImplementation(() => {
    throw new Error('EPIPE');
  });
  await handleDialogueEvents(req as any, broken as any);
  expect(unsubscribe).toHaveBeenCalled();
  const next = response();
  await handleDialogueEvents(req as any, next as any);
  expect(next.write).toHaveBeenCalledWith(expect.stringContaining('id: m1'));
  next.emit('close');
});
