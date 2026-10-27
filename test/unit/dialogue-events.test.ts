import { EventEmitter } from 'node:events';
import express, { type Request, type Response } from 'express';
import {
  handleDialogueAck,
  handleDialogueEvents,
} from '../../srv/lib/dialogue-events-handler';
import { DialogueOutbox } from '../../srv/lib/dialogue-outbox';
import type {
  DialogueEvent,
  DialogueHandle,
} from '../../srv/lib/dialogue-sessions';

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
let listener: (e: DialogueEvent) => void;
const unsubscribe = jest.fn();
const persist = jest.fn(async () => {});
let taskState = 'running';
let planState: { plan?: string; planStatus?: string } = {};
beforeEach(() => {
  outbox = new DialogueOutbox(
    [{ id: 'm1', text: 'hello', createdAt: 123, trigger: 'event' }],
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
            finishedAt: 900,
            error: 'x'.repeat(350),
            output: 'secret output',
          },
        ],
      }),
    },
    outbox,
    subscribe: (fn: (event: DialogueEvent) => void, cursor?: string) => {
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

function request(fields: {
  longSession?: { userId: string; key: string; destination?: string };
  headers?: Record<string, string>;
  body?: object;
}): Request {
  const base: Request = Object.create(express.request);
  return Object.assign(base, { headers: {} }, fields);
}
type SessionMocks = {
  lookupDialogue: jest.Mock<Promise<DialogueHandle | undefined>, []>;
  onDialogueCreated: jest.Mock<
    () => void,
    [string, string, (handle: DialogueHandle) => void]
  >;
};
function response() {
  const base: Response = Object.create(express.response);
  EventEmitter.call(base);
  return Object.assign(base, {
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
  await handleDialogueEvents(request(req), res);
  // The approuter compresses responses unless they say no-transform, and a
  // compressed SSE stream is buffered: nothing would reach the browser live.
  expect(res.setHeader).toHaveBeenCalledWith(
    'Cache-Control',
    'no-cache, no-transform',
  );
  expect(res.write).toHaveBeenCalledWith(
    'id: m1\nevent: message\ndata: {"id":"m1","text":"hello","createdAt":123,"trigger":"event"}\n\n',
  );
  listener({
    kind: 'task',
    task: {
      id: 't',
      worker: 'executor',
      goal: 'read',
      state: 'done',
      createdAt: 100,
      finishedAt: 900,
      error: 'x'.repeat(350),
    },
  });
  expect(res.write).toHaveBeenLastCalledWith(
    `event: task\ndata: ${JSON.stringify({ id: 't', worker: 'executor', goal: 'read', state: 'done', createdAt: 100, finishedAt: 900, error: 'x'.repeat(300) })}\n\n`,
  );
  listener({
    kind: 'usage',
    id: 'm1',
    usage: {
      planner: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      tasks: [
        {
          id: 't1',
          worker: 'executor',
          usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
        },
      ],
    },
  });
  expect(res.write).toHaveBeenLastCalledWith(
    'event: usage\ndata: {"id":"m1","usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16,"x_hub":{"planner":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5},"subagents":[{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11,"task_id":"t1","worker":"executor"}]}}}\n\n',
  );
  listener({
    kind: 'message',
    message: {
      id: 'm2',
      text: 'live',
      createdAt: 124,
      trigger: 'event',
      usage: {
        planner: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      },
    },
  });
  expect(res.write).toHaveBeenLastCalledWith(expect.stringContaining('live'));
  expect(res.write).toHaveBeenLastCalledWith(
    expect.stringContaining(
      '"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"x_hub":{"planner":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}}',
    ),
  );
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
  await handleDialogueEvents(request(req), again);
  expect(again.write).toHaveBeenCalledWith(expect.stringContaining('id: m1'));
  expect(again.write.mock.calls[0][0]).toContain('event: tasks');
  again.emit('close');
  jest.useRealTimers();
});
test.each([undefined, { userId: 'bob', key: 'ls-a' }])(
  'missing or foreign session is 404',
  async (longSession) => {
    const res = response();
    await handleDialogueEvents(request({ longSession }), res);
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
  await handleDialogueEvents(request(req), res);
  expect(res.write).toHaveBeenCalledTimes(1); // snapshot only
  await handleDialogueAck(request(req), response());
  expect(outbox.pending().map((message) => message.id)).toEqual(['m1']);
  expect(persist).not.toHaveBeenCalled();
  const denied = response();
  await handleDialogueAck(
    request({ ...req, longSession: { userId: 'bob', key: 'ls-a' } }),
    denied,
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
      request({ longSession: { userId: 'alice', key: 'ls-a' } }),
      res,
    );
    expect(res.write.mock.calls[0][0]).toContain('event: tasks');
    expect(res.write.mock.calls[0][0]).toContain(`"state":"${state}"`);
    expect(res.write.mock.calls[0][0]).toContain(
      '"createdAt":100,"finishedAt":900',
    );
    expect(res.write.mock.calls[0][0]).not.toContain('secret output');
    expect(res.write.mock.calls[0][0]).toContain('x'.repeat(300));
    expect(res.write.mock.calls[0][0]).not.toContain('x'.repeat(301));
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
  await handleDialogueEvents(request(req), broken);
  expect(unsubscribe).not.toHaveBeenCalled();
  const next = response();
  await handleDialogueEvents(request(req), next);
  expect(next.write).toHaveBeenCalledWith(expect.stringContaining('id: m1'));
  next.emit('close');
});

test('events before chat stays open and attaches to creation; ack never creates', async () => {
  const sessions = jest.requireMock<SessionMocks>(
    '../../srv/lib/dialogue-sessions',
  );
  sessions.lookupDialogue.mockResolvedValueOnce(undefined);
  const res = response();
  const req = { longSession: { userId: 'alice', key: 'ls-a' } };
  await handleDialogueEvents(request(req), res);
  expect(res.flushHeaders).toHaveBeenCalled();
  expect(res.write).toHaveBeenCalledWith('event: tasks\ndata: []\n\n');
  const registration = sessions.onDialogueCreated.mock.calls.at(-1);
  if (!registration) throw new Error('Missing dialogue listener');
  const attach = registration[2];
  const handle = await sessions.lookupDialogue();
  if (!handle) throw new Error('Missing dialogue handle');
  attach(handle);
  expect(res.write).toHaveBeenCalledWith(expect.stringContaining('id: m1'));
  sessions.lookupDialogue.mockClear();
  const ackRes = response();
  await handleDialogueAck(request({ ...req, body: { id: 'm1' } }), ackRes);
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
  await outbox.add([
    { id: 'm2', text: 'pending', createdAt: 124, trigger: 'event' },
  ]);
  const res = response();
  await handleDialogueEvents(
    request({ longSession: { userId: 'alice', key: 'ls-a' } }),
    res,
  );
  const messages = res.write.mock.calls
    .map(([body]) => body)
    .filter((body) => body.includes('event: message'));
  expect(messages).toEqual([
    'id: m1\nevent: message\ndata: {"id":"m1","text":"hello","createdAt":123,"trigger":"event"}\n\n',
    'id: m2\nevent: message\ndata: {"id":"m2","text":"pending","createdAt":124,"trigger":"event"}\n\n',
  ]);
  res.emit('close');
});

test.each([undefined, {}, { id: '' }, { id: 'm1' }, { id: 'unknown' }])(
  'ack route changes nothing (body %p)',
  async (body) => {
    const delivery = outbox.beginDelivery();
    delivery.carried('m1');
    delivery.ended();
    const sessions = jest.requireMock<SessionMocks>(
      '../../srv/lib/dialogue-sessions',
    );
    const before = outbox.history();
    const res = response();
    await handleDialogueAck(
      request({ longSession: { userId: 'alice', key: 'ls-a' }, body }),
      res,
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
    request({ longSession: { userId: 'alice', key: 'ls-a' } }),
    res,
  );
  res.write.mockClear();
  listener({ kind: 'settled', outcome: 'ok', trigger: 'event' });
  expect(res.write).not.toHaveBeenCalled();
  await outbox.add([
    { id: 'm2', text: 'complete', createdAt: 124, trigger: 'event' },
  ]);
  expect(res.write).toHaveBeenCalledWith(
    'id: m2\nevent: message\ndata: {"id":"m2","text":"complete","createdAt":124,"trigger":"event"}\n\n',
  );
  res.emit('close');
});

test.each([undefined, 'waiting_user', 'done'])(
  'plan snapshot defaults status and live updates use the same SSE event (%s)',
  async (status) => {
    planState = { plan: 'Private plan', planStatus: status };
    const res = response();
    await handleDialogueEvents(
      request({ longSession: { userId: 'alice', key: 'ls-a' } }),
      res,
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

test('wait events are live frames with no replay id', async () => {
  const res = response();
  await handleDialogueEvents(
    request({
      longSession: { userId: 'alice', key: 'ls-a', destination: 'DEV' },
    }),
    res,
  );
  const tasks = [
    {
      id: 't1',
      worker: 'executor',
      goal: 'read',
      state: 'running' as const,
      elapsedMs: 90000,
      toolCalls: 12,
      maxToolCalls: 40,
    },
  ];
  listener({ kind: 'wait', tasks });
  expect(res.write).toHaveBeenLastCalledWith(
    `event: wait\ndata: ${JSON.stringify({ tasks })}\n\n`,
  );
  res.emit('close');
});
