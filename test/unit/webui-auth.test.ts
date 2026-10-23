import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
function harness() {
  const notices: any[] = [];
  const storage = new Map<string, string>();
  const context = {
    fetch: jest.fn(),
    URL,
    userInput: { value: 'unsent draft' },
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    window: { location: { href: 'https://hub.invalid/', reload: jest.fn() } },
    stopDialogueEvents: jest.fn(),
    document: {
      createElement: () => ({
        appendChild(child: any) {
          Object.assign(this, { action: child });
        },
      }),
    },
    chatWindow: { appendChild: (node: any) => notices.push(node) },
  };
  const source = html.slice(
    html.indexOf(
      "        userInput.value = sessionStorage.getItem('clh.draft')",
    ),
    html.indexOf('        let sessionKey ='),
  );
  const api = runInNewContext(
    `${source};({hubFetch, signedOut: () => hubSignedOut})`,
    context,
  );
  return { ...context, ...api, notices, storage };
}

test.each([
  { status: 401 },
  { status: 302 },
  { status: 200, contentType: 'text/html; charset=utf-8' },
  {
    status: 200,
    redirected: true,
    url: 'https://login.invalid/oauth/authorize',
  },
  { status: 0, type: 'opaqueredirect' },
])('login response %j signs out once before JSON parsing', async (result) => {
  const ui = harness();
  const json = jest.fn();
  ui.fetch.mockResolvedValue({
    ...result,
    json,
    headers: { get: () => result.contentType || '' },
  });
  await expect(ui.hubFetch('/v1/models')).rejects.toThrow('Sign in again');
  await expect(ui.hubFetch('/v1/rag/collections')).rejects.toThrow(
    'Sign in again',
  );
  expect(json).not.toHaveBeenCalled();
  expect(ui.fetch.mock.calls[0][1].redirect).toBe('manual');
  expect(ui.fetch).toHaveBeenCalledTimes(1);
  expect(ui.notices).toHaveLength(1);
  expect(ui.stopDialogueEvents).toHaveBeenCalledTimes(1);
  expect(ui.signedOut()).toBe(true);
  expect(ui.userInput.value).toBe('unsent draft');
  expect(ui.notices[0].action.textContent).toBe('Sign in again');
  ui.notices[0].action.onclick();
  expect(ui.storage.get('clh.draft')).toBe('unsent draft');
  expect(ui.window.location.reload).toHaveBeenCalledTimes(1);
});

test.each([
  '/v1/chat/completions',
  '/v1/models',
  '/v1/session/events',
  '/v1/rag/collections',
  '/v1/tools',
])('guards hub endpoint %s', async (url) => {
  const ui = harness();
  ui.fetch.mockResolvedValue({ status: 401 });
  await expect(ui.hubFetch(url)).rejects.toThrow('Sign in again');
});

test('passes JSON and event streams through without consuming their bodies', async () => {
  const ui = harness();
  for (const contentType of ['application/json', 'text/event-stream']) {
    const response = {
      status: 200,
      headers: { get: () => contentType },
      json: jest.fn(),
    };
    ui.fetch.mockResolvedValue(response);
    expect(await ui.hubFetch('/v1/session/events')).toBe(response);
    expect(response.json).not.toHaveBeenCalled();
  }
  expect(ui.notices).toHaveLength(0);
});

test('all hub calls use the guard and events cannot reconnect while signed out', () => {
  expect(html.match(/\bfetch\(/g)).toHaveLength(1);
  expect(html).toContain(
    'if (!stopped && !hubSignedOut) { timer = setTimeout(connect, delay)',
  );
  expect(html).toContain('if (hubSignedOut) return;');
});

test.each(['', 'new draft'])(
  'auth failure restores the submitted input without overwriting newer typing: %s',
  (draft) => {
    const start = html.indexOf(
      '                if (hubSignedOut) {',
      html.indexOf('        async function sendMessage()'),
    );
    const end = html.indexOf('                const durationSec', start);
    const context = {
      hubSignedOut: true,
      userInput: { value: draft },
      text: 'submitted draft',
      document: { getElementById: () => ({ remove: jest.fn() }) },
      thinkingId: 'thinking',
      unlockInput: jest.fn(),
    };
    runInNewContext(`(function () { ${html.slice(start, end)} })()`, context);
    expect(context.userInput.value).toBe(draft || 'submitted draft');
  },
);
