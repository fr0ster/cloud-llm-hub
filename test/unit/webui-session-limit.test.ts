import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
const loggedOut = readFileSync('app/chat/webapp/logged-out.html', 'utf8');

function storage() {
  const values = new Map([['residue', 'value']]);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: jest.fn(() => values.clear()),
  };
}

interface SessionApi {
  ensureSession: () => Promise<void>;
  sessionFetch: (url: string) => Promise<Response>;
  clearChat: () => Promise<void>;
  activeChatStreams: Set<AbortController>;
}

function harness(status: number, code?: string) {
  const context = {
    hubSignedOut: false,
    hubFetch: jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code, message: 'Session refused' },
          }),
          { status },
        ),
    ),
    localStorage: storage(),
    sessionStorage: storage(),
    navigator: {},
    window: { addEventListener: jest.fn(), location: { replace: jest.fn() } },
    connectedDestination: 'SAP',
    getSapCredHeaders: () => ({}),
    stopDialogueEvents: jest.fn(),
    lockInput: jest.fn(),
    showSessionNotice: jest.fn(),
    llmOnlyMode: false,
    console: { warn: jest.fn() },
  };
  const sessionSource = html.slice(
    html.indexOf('        let sessionKey = sessionStorage'),
    html.indexOf('        function stepSymbol('),
  );
  const clearSource = html.slice(
    html.indexOf('        async function clearChat()'),
    html.indexOf('        function exportSessionLog()'),
  );
  const api: SessionApi = runInNewContext(
    `${sessionSource}\n${clearSource}\n({ ensureSession, sessionFetch, clearChat, activeChatStreams });`,
    context,
  );
  return { context, api };
}

test.each(['ensureSession', 'sessionFetch', 'clearChat'] as const)(
  '%s blocks and leaves on SESSION_LIMIT without deleting or retrying',
  async (caller) => {
    const { context, api } = harness(429, 'SESSION_LIMIT');
    const controller = new AbortController();
    api.activeChatStreams.add(controller);
    if (caller === 'clearChat') {
      await api.clearChat();
    } else {
      const pending =
        caller === 'ensureSession'
          ? api.ensureSession()
          : api.sessionFetch('/v1/models');
      await expect(pending).rejects.toThrow('Session refused');
    }
    expect(context.hubSignedOut).toBe(true);
    expect(context.stopDialogueEvents).toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(true);
    expect(api.activeChatStreams.size).toBe(0);
    expect(context.lockInput).toHaveBeenCalledWith('signed-out');
    expect(context.localStorage.values.size).toBe(0);
    expect(context.sessionStorage.values).toEqual(
      new Map([['clh.signedOutReason', 'SESSION_LIMIT']]),
    );
    expect(context.window.location.replace).toHaveBeenCalledWith('/logout');
    expect(context.hubFetch).toHaveBeenCalledTimes(1);
    expect(context.hubFetch).toHaveBeenCalledWith(
      '/v1/session',
      expect.objectContaining({ method: 'POST' }),
    );
  },
);

test.each([
  [429, undefined],
  [429, 'SESSION_BUSY'],
  [500, 'SESSION_LIMIT'],
])(
  'HTTP %s with code %s preserves the ordinary error',
  async (status, code) => {
    const { context, api } = harness(status, code);
    await expect(api.ensureSession()).rejects.toThrow('Session refused');
    expect(context.hubSignedOut).toBe(false);
    expect(context.window.location.replace).not.toHaveBeenCalled();
    expect(context.lockInput).not.toHaveBeenCalled();
    expect(context.sessionStorage.clear).not.toHaveBeenCalled();
  },
);

test.each(['SESSION_LIMIT', '', 'OTHER'])(
  'signed-out page renders reason %s and clears storage',
  (reason) => {
    const sessionStorage = storage();
    const localStorage = storage();
    sessionStorage.setItem('clh.signedOutReason', reason);
    const heading = { textContent: 'Signed out' };
    const paragraph = {
      textContent: 'Your session has ended. Click below to sign in again.',
    };
    const script = loggedOut.slice(
      loggedOut.indexOf('<script>') + 8,
      loggedOut.indexOf('</script>'),
    );
    runInNewContext(script, {
      sessionStorage,
      localStorage,
      document: {
        querySelector: (selector: string) =>
          selector === 'h1' ? heading : paragraph,
      },
    });
    expect(heading.textContent).toBe(
      reason === 'SESSION_LIMIT' ? 'Session limit reached' : 'Signed out',
    );
    expect(paragraph.textContent).toBe(
      reason === 'SESSION_LIMIT'
        ? 'No more sessions can be opened for you right now. Close sessions you no longer need in your other tabs or clients, then sign in again.'
        : 'Your session has ended. Click below to sign in again.',
    );
    expect(sessionStorage.values.size).toBe(0);
    expect(localStorage.values.size).toBe(0);
  },
);

test.each([false, true])(
  'callers suppress inline errors only while signed out (%s)',
  async (hubSignedOut) => {
    const context = {
      hubSignedOut,
      ensureSession: jest.fn(async () => {
        throw new Error('Session refused');
      }),
      fail: jest.fn(),
      showSessionNotice: jest.fn(),
      error: new Error('Session refused'),
    };
    const gateStart = html.indexOf(
      '            try { await ensureSession(); } catch',
    );
    const gateEnd = html.indexOf('\n', gateStart);
    await runInNewContext(
      `(async () => { ${html.slice(gateStart, gateEnd)} })()`,
      context,
    );
    const clearStart = html.indexOf(
      '            catch (error)',
      html.indexOf('        async function clearChat()'),
    );
    const clearEnd = html.indexOf('\n', clearStart);
    await runInNewContext(
      `(async () => { try { throw error; } ${html.slice(clearStart, clearEnd)} })()`,
      context,
    );
    for (const render of [context.fail, context.showSessionNotice]) {
      expect(render).toHaveBeenCalledTimes(hubSignedOut ? 0 : 1);
      if (!hubSignedOut) expect(render).toHaveBeenCalledWith('Session refused');
    }
  },
);
