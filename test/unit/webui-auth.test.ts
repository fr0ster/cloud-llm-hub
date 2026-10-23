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

test.each([
  'SAP_CREDENTIALS_REQUIRED',
  'SAP_CREDENTIALS_FAILED',
  'sap_credentials_failed',
  'SAP_USER_TOKEN_REQUIRED',
  'SESSION_CREDENTIAL_MISMATCH',
  'TOOL_FORBIDDEN',
  'DESTINATION_RESOLUTION_FAILED',
])(
  'passes structured hub error %s through with its body intact',
  async (code) => {
    for (const status of [401, 403]) {
      for (const field of ['type', 'code']) {
        const ui = harness();
        const body = { error: { [field]: code, message: 'SAP refused' } };
        const response = new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
        ui.fetch.mockResolvedValue(response);
        expect(await ui.hubFetch('/v1/chat/completions')).toBe(response);
        expect(response.bodyUsed).toBe(false);
        expect(await response.json()).toEqual(body);
        expect(ui.signedOut()).toBe(false);
        expect(ui.stopDialogueEvents).not.toHaveBeenCalled();
        expect(ui.notices).toHaveLength(0);
      }
    }
  },
);

test.each([
  ['application/json', '{"error":{"code":"UNKNOWN"}}'],
  ['application/json', '{"error":"Unauthorized"}'],
  ['application/json', 'invalid JSON'],
  ['text/html', '{"error":{"type":"SAP_CREDENTIALS_REQUIRED"}}'],
])('unrecognized 401 (%s, %s) signs out', async (contentType, body) => {
  const ui = harness();
  ui.fetch.mockResolvedValue(
    new Response(body, {
      status: 401,
      headers: { 'Content-Type': contentType },
    }),
  );
  await expect(ui.hubFetch('/v1/models')).rejects.toThrow('Sign in again');
  expect(ui.signedOut()).toBe(true);
});

test.each([
  'SAP_CREDENTIALS_REQUIRED',
  'SAP_CREDENTIALS_FAILED',
  'sap_credentials_failed',
])(
  'SAP 401 %s reaches sendMessage recovery and reopens the gate',
  async (type) => {
    const ui = harness();
    const body = { error: { type, message: 'SAP refused' } };
    ui.fetch.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const response = await ui.hubFetch('/v1/chat/completions');
    const start = html.indexOf(
      '                if (!response.ok) {',
      html.indexOf('        async function sendMessage()'),
    );
    const end = html.indexOf('                const reader =', start);
    const context = {
      response,
      loginGateDone: true,
      lockInput: jest.fn(),
      showLoginGate: jest.fn(),
      destinationUsesConfiguredAuth: () => false,
      getSelectedDestination: () => 'SAP',
    };
    await expect(
      runInNewContext(`(async () => { ${html.slice(start, end)} })()`, context),
    ).rejects.toThrow('SAP refused');
    expect(context.loginGateDone).toBe(false);
    expect(context.showLoginGate).toHaveBeenCalledTimes(1);
    expect(context.lockInput).toHaveBeenCalledWith('login-gate');
    expect(ui.signedOut()).toBe(false);
  },
);

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
