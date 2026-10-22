import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function load(path: string, dependencies: unknown[] = []) {
  let result: any;
  runInNewContext(readFileSync(path, 'utf8'), {
    sap: {
      ui: {
        define: (_: unknown, factory: (...args: any[]) => unknown) => {
          result = factory(...dependencies);
        },
      },
    },
    console,
  });
  return result;
}

const clientPath = 'app/chat/webapp/util/StreamClient.js';
test('status comments call onStatus; malformed and ordinary comments are ignored', () => {
  const client = load(clientPath);
  const onStatus = jest.fn();
  const onDelta = jest.fn();
  client._processSSE(
    ': heartbeat {}\n: keep-alive\n: status broken\n: status {"stepId":"a","state":"started"}\ndata: {"choices":[{"delta":{"content":"answer"}}]}',
    { onStatus, onDelta },
  );
  expect(onStatus).toHaveBeenCalledTimes(1);
  expect(onStatus).toHaveBeenCalledWith({ stepId: 'a', state: 'started' });
  expect(onDelta).toHaveBeenCalledWith('answer');
  expect(() => client._processSSE(': status {}', {})).not.toThrow();
});

test('controller records status, uppercases the label and renders latest step states above text safely', () => {
  let options: any;
  const formatter = {
    escapeHtml: (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    markdownToHtml: (s: string) => s,
  };
  const controller = load('app/chat/webapp/controller/Chat.controller.js', [
    { extend: (_: string, value: unknown) => value },
    {},
    {
      streamChat: (value: unknown) => {
        options = value;
      },
    },
    formatter,
  ]);
  const setProperty = jest.fn();
  const el = { innerHTML: '' };
  controller._messages = [];
  controller.getView = () => ({
    getModel: () => ({
      getProperty: (key: string) => (key === '/inputValue' ? 'hello' : false),
      setProperty,
    }),
  });
  controller._getChatWindow = () => el;
  controller._scrollToBottom = jest.fn();
  controller.onSendMessage();
  const events = [
    { stepId: '<create>', kind: 'execute', state: 'started' },
    { stepId: '<create>', kind: 'execute', state: 'done' },
    { stepId: 'check', kind: 'check', state: 'done', verdict: 'fail' },
  ];
  events.forEach((event) => {
    options.onStatus(event);
  });
  expect(setProperty).toHaveBeenLastCalledWith(
    '/statusText',
    'STEP CHECK · CHECK · DONE · FAIL',
  );
  expect(controller._messages[1].steps).toEqual(events);
  options.onDelta('answer');
  expect(el.innerHTML).toContain('&lt;create&gt; ✓ · check ✗');
  expect(el.innerHTML.indexOf('&lt;create&gt;')).toBeLessThan(
    el.innerHTML.indexOf('answer'),
  );
  expect(el.innerHTML).not.toContain('<create>');
});
