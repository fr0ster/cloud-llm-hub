import { EventEmitter } from 'node:events';
import {
  handleDialogueAck,
  handleDialogueEvents,
} from '../../srv/lib/dialogue-events-handler';
import { DialogueOutbox } from '../../srv/lib/dialogue-outbox';

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
let outbox: DialogueOutbox;
let listener: (e: any) => void;
const unsubscribe = jest.fn();
const persist = jest.fn(async () => {});
let taskState = 'running';
let planState: { plan?: string; planStatus?: string } = {};
beforeEach(() => {
  outbox = new DialogueOutbox(
    [{ id: 'm1', text: 'hello', createdAt: 123 }],
    persist,
  );
  taskState = 'running';
  planState = {};
  jest.clearAllMocks();
});
jest.mock('../../srv/lib/dialogue-sessions', () => ({
  dialoguePlan: (state: { plan?: string; planStatus?: string }) =>
    state.plan === undefined
      ? undefined
      : { text: state.plan, status: state.planStatus ?? 'active' },
  onDialogueCreated: jest.fn(() => () => {}),
  lookupDialogue: jest.fn(async () => ({
    session: {
      snapshot: () => ({
        ...planState,
        tasks: [
          {
            id: 'task',
            worker: 'executor',
            goal: 'read',
            state: taskState,
            createdAt: 100,
            startedAt: 200,
            output: 'secret output',
          },
        ],
      }),
    },
    outbox,
    subscribe: (fn: any, cursor?: string) => {
      listener = fn;
      const detach = outbox.subscribe(
        (message) => fn({ kind: 'message', message }),
        cursor,
      );
      return () => {
        detach();
        unsubscribe();
      };
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
  // The approuter compresses responses unless they say no-transform, and a
  // compressed SSE stream is buffered: nothing would reach the browser live.
  expect(res.setHeader).toHaveBeenCalledWith(
    'Cache-Control',
    'no-cache, no-transform',
  );
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

test('Last-Event-ID skips rendered prefix and ack ownership is enforced', async () => {
  const req = {
    headers: { 'last-event-id': 'm1' },
    longSession: { userId: 'alice', key: 'ls-a' },
    body: { id: 'm1' },
  };
  const res = response();
  await handleDialogueEvents(req as any, res as any);
  expect(res.write).toHaveBeenCalledTimes(1); // snapshot only
  await handleDialogueAck(req as any, response() as any);
  expect(outbox.pending().map((message) => message.id)).toEqual(['m1']);
  expect(persist).not.toHaveBeenCalled();
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
    expect(res.write.mock.calls[0][0]).toContain(
      '"createdAt":100,"startedAt":200',
    );
    expect(res.write.mock.calls[0][0]).not.toContain('secret output');
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
  expect(unsubscribe).not.toHaveBeenCalled();
  const next = response();
  await handleDialogueEvents(req as any, next as any);
  expect(next.write).toHaveBeenCalledWith(expect.stringContaining('id: m1'));
  next.emit('close');
});

test('events before chat stays open and attaches to creation; ack never creates', async () => {
  const sessions = jest.requireMock('../../srv/lib/dialogue-sessions');
  sessions.lookupDialogue.mockResolvedValueOnce(undefined);
  const res = response();
  const req = { longSession: { userId: 'alice', key: 'ls-a' } };
  await handleDialogueEvents(req as any, res as any);
  expect(res.flushHeaders).toHaveBeenCalled();
  expect(res.write).toHaveBeenCalledWith('event: tasks\ndata: []\n\n');
  const attach = sessions.onDialogueCreated.mock.calls.at(-1)[2];
  const handle = await sessions.lookupDialogue();
  attach(handle);
  expect(res.write).toHaveBeenCalledWith(expect.stringContaining('id: m1'));
  sessions.lookupDialogue.mockClear();
  const ackRes = response();
  await handleDialogueAck({ ...req, body: { id: 'm1' } } as any, ackRes as any);
  expect(ackRes.status).toHaveBeenCalledWith(204);
  expect(sessions.lookupDialogue).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  res.emit('close');
});

test('the view shows confirmed messages too', async () => {
  const delivery = outbox.beginDelivery();
  delivery.carried('m1');
  delivery.ended();
  await outbox.confirmByArrival();
  expect(outbox.pending()).toEqual([]);
  await outbox.add([{ id: 'm2', text: 'pending', createdAt: 124 }]);
  const res = response();
  await handleDialogueEvents(
    { longSession: { userId: 'alice', key: 'ls-a' } } as any,
    res as any,
  );
  const messages = res.write.mock.calls
    .map(([body]) => body)
    .filter((body) => body.includes('event: message'));
  expect(messages).toEqual([
    'id: m1\nevent: message\ndata: {"id":"m1","text":"hello","createdAt":123}\n\n',
    'id: m2\nevent: message\ndata: {"id":"m2","text":"pending","createdAt":124}\n\n',
  ]);
  res.emit('close');
});

test.each([undefined, {}, { id: '' }, { id: 'm1' }, { id: 'unknown' }])(
  'ack route changes nothing (body %p)',
  async (body) => {
    const delivery = outbox.beginDelivery();
    delivery.carried('m1');
    delivery.ended();
    const sessions = jest.requireMock('../../srv/lib/dialogue-sessions');
    const before = outbox.history();
    const res = response();
    await handleDialogueAck(
      { longSession: { userId: 'alice', key: 'ls-a' }, body } as any,
      res as any,
    );
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(sessions.lookupDialogue).not.toHaveBeenCalled();
    expect(outbox.pending()).toEqual(before);
    expect(outbox.history()).toEqual(before);
    expect(outbox.ackMode).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  },
);

test('settled is not sent', async () => {
  const res = response();
  await handleDialogueEvents(
    { longSession: { userId: 'alice', key: 'ls-a' } } as any,
    res as any,
  );
  res.write.mockClear();
  listener({ kind: 'settled' });
  expect(res.write).not.toHaveBeenCalled();
  await outbox.add([{ id: 'm2', text: 'complete', createdAt: 124 }]);
  expect(res.write).toHaveBeenCalledWith(
    'id: m2\nevent: message\ndata: {"id":"m2","text":"complete","createdAt":124}\n\n',
  );
  res.emit('close');
});

test.each([undefined, 'waiting_user', 'done'])(
  'plan snapshot defaults status and live updates use the same SSE event (%s)',
  async (status) => {
    planState = { plan: 'Private plan', planStatus: status };
    const res = response();
    await handleDialogueEvents(
      { longSession: { userId: 'alice', key: 'ls-a' } } as any,
      res as any,
    );
    expect(res.write).toHaveBeenCalledWith(
      `event: plan\ndata: ${JSON.stringify({ text: 'Private plan', status: status ?? 'active' })}\n\n`,
    );
    listener({ kind: 'plan', plan: { text: 'Revised', status: 'done' } });
    expect(res.write).toHaveBeenLastCalledWith(
      'event: plan\ndata: {"text":"Revised","status":"done"}\n\n',
    );
    res.emit('close');
  },
);
