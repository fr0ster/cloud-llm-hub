import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function load(path: string, deps: any[] = [], globals = {}) {
  let value: any;
  runInNewContext(readFileSync(path, 'utf8'), {
    sap: {
      ui: {
        define: (_: any, fn: any) => {
          value = fn(...deps);
        },
      },
    },
    console,
    AbortController,
    TextDecoder,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  return value;
}
test('event reader handles split frames and unsubscribe cancels', async () => {
  const client = load('app/chat/webapp/util/StreamClient.js');
  const chunks = [
    'event: message\r\ndata: {"text":"hello"}\r\n',
    '\r\nevent: task\ndata: {"id":"t","state":"done"}\n\n',
  ];
  const cancel = jest.fn(async () => {});
  const reader = {
    read: jest.fn(async () =>
      chunks.length
        ? { value: new TextEncoder().encode(chunks.shift()), done: false }
        : new Promise(() => {}),
    ),
    cancel,
    releaseLock: jest.fn(),
  };
  client._sessionFetch = jest.fn(async () => ({
    ok: true,
    body: { getReader: () => reader },
  }));
  const onMessage = jest.fn();
  const onTask = jest.fn();
  const stop = client.subscribeEvents({ onMessage, onTask });
  await new Promise((resolve) => setImmediate(resolve));
  expect(onMessage).toHaveBeenCalledWith({ text: 'hello' });
  expect(onTask).toHaveBeenCalledWith({ id: 't', state: 'done' });
  stop();
  expect(cancel).toHaveBeenCalled();
});
test('controller renders escaped planner messages and task list and unsubscribes on clear', () => {
  let callbacks: any;
  const stop = jest.fn();
  const escapeHtml = (s: string) =>
    s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const client = {
    subscribeEvents: (c: any) => {
      callbacks = c;
      return stop;
    },
    closeSession: () => new Promise(() => {}),
  };
  const c = load('app/chat/webapp/controller/Chat.controller.js', [
    { extend: (_: any, x: any) => x },
    {},
    client,
    { escapeHtml },
  ]);
  const model = { setProperty: jest.fn() };
  c.getView = () => ({ getModel: () => model });
  c._messages = [];
  c._renderChat = jest.fn();
  c._scrollToBottom = jest.fn();
  c._subscribeEvents();
  callbacks.onMessage({ text: '<img onerror=bad>', id: 'm' });
  expect(c._renderMessage(c._messages[0])).toContain('&lt;img onerror=bad&gt;');
  callbacks.onTask({ id: '<t>', goal: '<goal>', state: 'done' });
  expect(model.setProperty).toHaveBeenCalledWith('/dialogueTasks', [
    { id: '<t>', goal: '<goal>', state: 'done', icon: '✓' },
  ]);
  c.onClearHistory();
  expect(stop).toHaveBeenCalled();
});

test('event reconnect backs off from 1s to 30s and stops retrying on unsubscribe or 409', async () => {
  jest.useFakeTimers();
  const client = load('app/chat/webapp/util/StreamClient.js');
  client._sessionFetch = jest.fn(async () => {
    throw new Error('offline');
  });
  const onError = jest.fn();
  const stop = client.subscribeEvents({ onError });
  await jest.advanceTimersByTimeAsync(0);
  expect(client._sessionFetch).toHaveBeenCalledTimes(1);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const count = client._sessionFetch.mock.calls.length;
    await jest.advanceTimersByTimeAsync(delay - 1);
    expect(client._sessionFetch).toHaveBeenCalledTimes(count);
    await jest.advanceTimersByTimeAsync(1);
    expect(client._sessionFetch).toHaveBeenCalledTimes(count + 1);
  }
  stop();
  expect(jest.getTimerCount()).toBe(0);
  client._sessionFetch.mockResolvedValue({ status: 409 });
  client.subscribeEvents({ onError });
  await jest.advanceTimersByTimeAsync(0);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
