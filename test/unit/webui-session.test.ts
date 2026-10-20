import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const html = readFileSync(resolve('app/chat/webapp/index.html'), 'utf8');
const client = readFileSync(
  resolve('app/chat/webapp/util/StreamClient.js'),
  'utf8',
);

describe('WebUI extended session protocol', () => {
  test('plain UI sends the session header and opens sessions explicitly', () => {
    expect(html).toContain('x-clh-session');
    expect(html).toMatch(/fetch\('\/v1\/session',\s*\{\s*method: 'POST'/);
    expect(html).toContain("localStorage.setItem('clh.session'");
  });
  test('plain UI closes on pagehide and recovers by error code', () => {
    expect(html).toContain("sendBeacon('/v1/session/close'");
    expect(html).toContain("error?.code === 'SESSION_NOT_FOUND'");
    expect(html).toContain('Сесію перезапущено');
    expect(html).toContain('Сесію відновлено після перезапуску сервісу');
    expect(html).toContain(
      "З'єднання з SAP оновлено: стан відладки та локи втрачено",
    );
  });
  test('UI5 sends the session header', () => {
    expect(client).toContain('x-clh-session');
  });
});

function sessionHarness(key = '') {
  const values = new Map([['clh.session', key]]);
  const notices: string[] = [];
  const fetch = jest.fn();
  const context = {
    fetch,
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
    html.indexOf('        // Input history'),
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
