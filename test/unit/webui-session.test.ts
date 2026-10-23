import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const html = readFileSync(resolve('app/chat/webapp/index.html'), 'utf8');
describe('WebUI bootstrap readiness', () => {
  function readinessHarness() {
    const fetch = jest.fn();
    const context = {
      fetch,
      hubFetch: fetch,
      hubSignedOut: false,
      setStatus: jest.fn(),
      lockInput: jest.fn(),
      setTimeout: jest.fn(),
      modelSelect: { appendChild: jest.fn(), innerHTML: '', disabled: true },
      document: {
        createElement: jest.fn(() => ({})),
        getElementById: jest.fn(() => ({})),
      },
      populateAuxSelect: jest.fn(),
      classifierSelect: {},
      destSelect: { appendChild: jest.fn(), innerHTML: '', disabled: true },
      renderDestinations: jest.fn(),
      setIdleStatus: jest.fn(),
      showLoginGate: jest.fn(),
      unlockInput: jest.fn(),
      userInput: { focus: jest.fn() },
      refreshActiveCollections: jest.fn(),
      loginGateDone: false,
      ready: false,
      llmOnlyMode: false,
      enterLlmOnlyMode: jest.fn(),
    };
    const start = html.indexOf('        async function checkReady()');
    const source = html.slice(
      start,
      html.indexOf('        checkReady();', start),
    );
    const checkReady = runInNewContext(`${source}\ncheckReady;`, context);
    return { ...context, checkReady };
  }

  test.each([[403, 'NO MCP ROLE']])(
    'shows an actionable error for HTTP %s',
    async (status, message) => {
      const ui = readinessHarness();
      const json = jest.fn().mockRejectedValue(new Error('not JSON'));
      ui.fetch.mockResolvedValue({ status, json });

      await ui.checkReady();

      expect(ui.fetch).toHaveBeenCalledWith('/v1/models', {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      expect(ui.setStatus).toHaveBeenCalledTimes(1);
      expect(ui.setStatus).toHaveBeenCalledWith(
        expect.stringContaining(message),
        'status-error',
      );
      expect(ui.lockInput).toHaveBeenCalledWith('bootstrap');
      expect(ui.setTimeout).toHaveBeenCalledTimes(1);
      expect(ui.setTimeout).toHaveBeenCalledWith(ui.checkReady, 30000);
      expect(json).not.toHaveBeenCalled();
    },
  );

  test('recovers from access denied on the scheduled retry', async () => {
    const ui = readinessHarness();
    ui.fetch.mockResolvedValueOnce(response(403)).mockResolvedValueOnce(
      response(200, {
        data: [{ id: 'm' }],
        _agent_ready: true,
        _meta: { mcp_destination: 'D' },
        _destinations: [],
      }),
    );

    await ui.checkReady();

    expect(ui.setStatus).toHaveBeenCalledWith(
      expect.stringContaining('ACCESS DENIED'),
      'status-error',
    );
    expect(ui.lockInput).toHaveBeenCalledWith('bootstrap');
    expect(ui.unlockInput).not.toHaveBeenCalled();
    const [retry, delay] = ui.setTimeout.mock.calls[0];
    expect(delay).toBe(30000);
    ui.setStatus.mockClear();

    await retry();

    expect(ui.fetch).toHaveBeenCalledTimes(2);
    expect(ui.unlockInput).toHaveBeenCalledWith('bootstrap');
    expect(ui.setIdleStatus).toHaveBeenCalledTimes(1);
    expect(ui.showLoginGate).toHaveBeenCalledTimes(1);
    expect(ui.setStatus).not.toHaveBeenCalled();
    expect(ui.setTimeout).toHaveBeenCalledTimes(1);
  });

  test.each(['HTTP 500', 'network failure'])(
    'keeps the connecting retry for %s',
    async (failure) => {
      const ui = readinessHarness();
      if (failure === 'HTTP 500') {
        ui.fetch.mockResolvedValue(response(500));
      } else {
        ui.fetch.mockRejectedValue(new Error('offline'));
      }

      await ui.checkReady();

      expect(ui.setStatus).toHaveBeenCalledTimes(1);
      expect(ui.setStatus).toHaveBeenCalledWith(
        'CONNECTING...',
        'status-connecting',
      );
      expect(ui.setTimeout).toHaveBeenCalledTimes(1);
      expect(ui.setTimeout).toHaveBeenCalledWith(ui.checkReady, 3000);
    },
  );
});

describe('WebUI extended session protocol', () => {
  test('plain UI sends the session header and opens sessions explicitly', () => {
    expect(html).toContain('x-clh-session');
    expect(html).toMatch(/hubFetch\('\/v1\/session',\s*\{\s*method: 'POST'/);
    expect(html).toContain("localStorage.setItem('clh.session'");
  });
  test('R15 plain UI keeps sessions on pagehide and recovers by error code', () => {
    expect(html).not.toContain("sendBeacon('/v1/session/close'");
    expect(html).toContain("error?.code === 'SESSION_NOT_FOUND'");
    expect(html).toContain('Сесію перезапущено');
    expect(html).toContain('Сесію відновлено після перезапуску сервісу');
    expect(html).toContain(
      "З'єднання з SAP оновлено: стан відладки та локи втрачено",
    );
  });
});

function sessionHarness(key = '') {
  const values = new Map([['clh.session', key]]);
  const notices: string[] = [];
  const fetch = jest.fn();
  const context = {
    fetch,
    hubFetch: fetch,
    hubSignedOut: false,
    localStorage: {
      getItem: (name: string) => values.get(name),
      setItem: (name: string, value: string) => values.set(name, value),
      removeItem: (name: string) => values.delete(name),
    },
    connectedDestination: 'SAP',
    getSapCredHeaders: () => ({ 'X-SAP-Login': 'alice' }),
    document: { createElement: () => ({}) },
    chatWindow: {
      appendChild: (node: { textContent: string }) =>
        notices.push(node.textContent),
    },
    window: { addEventListener: jest.fn() },
  };
  const source = html.slice(
    html.indexOf('        let sessionKey ='),
    html.indexOf('        function stepSymbol('),
  );
  const api = runInNewContext(
    `${source}\n({ sessionFetch, closeSession });`,
    context,
  );
  return { ...api, fetch, values, notices };
}

function response(status: number, data = {}, notice = '') {
  return {
    status,
    ok: status < 400,
    json: async () => data,
    clone: () => ({ json: async () => data }),
    headers: { get: () => notice },
  };
}

describe('session request helper', () => {
  test('opens with destination, persists key and attaches credentials and key', async () => {
    const ui = sessionHarness();
    ui.fetch
      .mockResolvedValueOnce(response(201, { session: 'new-key' }))
      .mockResolvedValueOnce(response(200));
    await ui.sessionFetch('/v1/chat/completions', {
      method: 'POST',
      body: 'message',
    });
    expect(ui.fetch.mock.calls[0][0]).toBe('/v1/session');
    expect(JSON.parse(ui.fetch.mock.calls[0][1].body)).toEqual({
      destination: 'SAP',
    });
    expect(ui.values.get('clh.session')).toBe('new-key');
    expect(ui.fetch.mock.calls[1][1]).toMatchObject({
      body: 'message',
      headers: { 'x-clh-session': 'new-key', 'X-SAP-Login': 'alice' },
    });
  });

  test('reopens once by code, repeats the same request and surfaces notices', async () => {
    const ui = sessionHarness('old-key');
    ui.fetch
      .mockResolvedValueOnce(
        response(404, { error: { code: 'SESSION_NOT_FOUND' } }),
      )
      .mockResolvedValueOnce(response(201, { session: 'new-key' }))
      .mockResolvedValueOnce(response(200, {}, 'abap_session_renewed'));
    await ui.sessionFetch('/v1/rag/collections', {
      method: 'POST',
      body: 'same-body',
    });
    expect(ui.fetch).toHaveBeenCalledTimes(3);
    expect(ui.fetch.mock.calls[2][1]).toMatchObject({
      body: 'same-body',
      headers: { 'x-clh-session': 'new-key' },
    });
    expect(ui.notices).toEqual([
      'Сесію перезапущено',
      "З'єднання з SAP оновлено: стан відладки та локи втрачено",
    ]);
  });

  test('does not retry a second SESSION_NOT_FOUND', async () => {
    const ui = sessionHarness('old-key');
    const missing = response(404, { error: { code: 'SESSION_NOT_FOUND' } });
    ui.fetch
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(response(201, { session: 'new-key' }))
      .mockResolvedValueOnce(missing);
    expect(await ui.sessionFetch('/v1/chat/completions')).toBe(missing);
    expect(ui.fetch).toHaveBeenCalledTimes(3);
  });

  test.each([
    [400, 'SESSION_REQUIRED'],
    [429, 'SESSION_BUSY'],
    [404, 'OTHER'],
  ])('does not reopen for %s %s', async (status, code) => {
    const ui = sessionHarness('old-key');
    ui.fetch.mockResolvedValue(response(status, { error: { code } }));
    await ui.sessionFetch('/v1/rag/collections');
    expect(ui.fetch).toHaveBeenCalledTimes(1);
  });

  test('delete carries the key and removes it after closing', async () => {
    const ui = sessionHarness('old-key');
    ui.fetch.mockImplementation(async () => {
      expect(ui.values.get('clh.session')).toBe('old-key');
      return response(204);
    });
    await ui.closeSession();
    expect(ui.fetch.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      headers: { 'x-clh-session': 'old-key' },
    });
    expect(ui.values.has('clh.session')).toBe(false);
  });
});

test('R16 rereads storage', async () => {
  const ui = sessionHarness('old');
  ui.values.set('clh.session', 'other');
  ui.fetch.mockResolvedValue(response(200));
  await ui.sessionFetch('/v1/models');
  expect(ui.fetch.mock.calls[0][1].headers['x-clh-session']).toBe('other');
});
test('R24 failed delete forgets the key', async () => {
  const ui = sessionHarness('old');
  ui.fetch.mockRejectedValue(new Error('offline'));
  await expect(ui.closeSession()).resolves.toBeUndefined();
  expect(ui.values.has('clh.session')).toBe(false);
});
test('R24 concurrent 404 including late response reopens only once', async () => {
  const ui = sessionHarness('old');
  let late!: (r: unknown) => void;
  let oldCalls = 0;
  ui.fetch.mockImplementation((url: string, opts: any) => {
    if (url === '/v1/session')
      return Promise.resolve(response(201, { session: 'new' }));
    if (opts.headers['x-clh-session'] === 'old') {
      if (++oldCalls === 2)
        return new Promise((resolve) => {
          late = resolve;
        });
      return Promise.resolve(
        response(404, { error: { code: 'SESSION_NOT_FOUND' } }),
      );
    }
    return Promise.resolve(response(200));
  });
  const first = ui.sessionFetch('/v1/models');
  const second = ui.sessionFetch('/v1/models');
  await first;
  late(response(404, { error: { code: 'SESSION_NOT_FOUND' } }));
  await second;
  expect(
    ui.fetch.mock.calls.filter(([url]: [string]) => url === '/v1/session'),
  ).toHaveLength(1);
});
test('R22 tools open sessions and configure agent MCP', () => {
  for (const file of ['tools/test-endpoints.sh', 'tools/tutorial-test.sh']) {
    const script = readFileSync(resolve(file), 'utf8');
    expect(script).toMatch(/-X POST "\$\w+\/v1\/session"/);
    expect(script).toContain('x-clh-session:');
  }
  const config = readFileSync(
    resolve('tools/update-cline-connection.js'),
    'utf8',
  );
  expect(config).toContain("'direct-basic': '/mcp/agent/stream/http'");
  expect(config).toContain('LLM_AGENT_PLAIN_MCP=true');
});
test('R25 spec documents pinning', () => {
  expect(
    readFileSync(
      resolve('docs/superpowers/specs/2026-10-20-long-sessions-design.md'),
      'utf8',
    ),
  ).toContain('Long sessions are pinned and never evicted');
});

test('R24 failed HTTP delete forgets key and logs', async () => {
  const ui = sessionHarness('old');
  ui.fetch.mockResolvedValue(response(500));
  await expect(ui.closeSession()).resolves.toBeUndefined();
  expect(ui.values.has('clh.session')).toBe(false);
});

test.each([false, true])(
  'CLR requires SAP gate unless LLM-only mode (%s)',
  async (llmOnlyMode) => {
    const context = {
      closeSession: jest.fn(),
      ensureSession: jest.fn(),
      showSessionNotice: jest.fn(),
      fileArtifacts: {},
      conversationHistory: ['old'],
      chatWindow: { innerHTML: 'old' },
      connectedDestination: '',
      loginGateDone: true,
      llmOnlyMode,
      lockInput: jest.fn(),
      showLoginGate: jest.fn(),
    };
    const source = html.slice(
      html.indexOf('        async function clearChat()'),
      html.indexOf('        function exportSessionLog()'),
    );
    await runInNewContext(source + ';clearChat()', context);
    expect(context.showLoginGate).toHaveBeenCalledTimes(llmOnlyMode ? 0 : 1);
    expect(context.ensureSession).toHaveBeenCalledTimes(llmOnlyMode ? 1 : 0);
    if (!llmOnlyMode) {
      expect(context.loginGateDone).toBe(false);
      expect(context.lockInput).toHaveBeenCalledWith('login-gate');
    }
  },
);
