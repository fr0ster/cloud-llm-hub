/**
 * The session routes and the plain-mode switches, through `srv/server.ts`'s
 * own `bootstrap` on a real Express app: what a client sees on the wire.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const handlers: Record<string, (...args: unknown[]) => unknown> = {};
const user = { id: 'alice' };
const pass = (_req: unknown, _res: unknown, next: () => void) => next();

jest.mock(
  '@sap/cds',
  () => {
    const log = () => ({ info() {}, warn() {}, error() {}, debug() {} });
    return {
      __esModule: true,
      default: {
        on: (event: string, fn: (...args: unknown[]) => unknown) => {
          handlers[event] = fn;
        },
        log,
        middlewares: { before: [pass, pass, pass] },
        get context() {
          return {
            user: {
              id: user.id,
              is: (role: string) =>
                role !== 'system-user' && role !== 'anonymous',
            },
          };
        },
      },
      log,
    };
  },
  { virtual: true },
);
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/agent-config', () => ({
  ...jest.requireActual('../../srv/agent-config'),
  ensureAiCoreCredentials: () => {},
  getAgentConfig: () => ({
    rag: { backends: { session: 'vector' } },
    mcp: { destination: '' },
  }),
}));
jest.mock('../../srv/agent-manager', () => ({
  isProvidersReady: () => false,
  setSessionDestination: () => {},
  forgetSessionDestination: () => {},
  getSharedHistoryRag: () => undefined,
  collectionsRestoreStatus: () => ({ state: 'off' }),
}));
jest.mock('../../srv/agent-mcp', () => ({}));
jest.mock('../../srv/mcp-manager', () => ({}));
jest.mock('../../srv/rag-handler', () => ({ registerRagRoutes: () => {} }));
/** The chat handlers themselves are not under test: they say they were reached. */
jest.mock('../../srv/openai-handler', () => ({
  handleChatCompletions: (
    req: { longSession?: { key: string } },
    res: { json(b: unknown): void },
  ) => res.json({ reached: 'chat', session: req.longSession?.key ?? null }),
  handleModels: () => {},
  handleUsage: () => {},
}));
jest.mock('../../srv/anthropic-handler', () => ({
  handleAnthropicMessages: (
    req: { longSession?: { key: string } },
    res: { json(b: unknown): void },
  ) => res.json({ reached: 'messages', session: req.longSession?.key ?? null }),
}));

import express from 'express';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { longSessions } from '../../srv/lib/long-session';
import { clearSessionConfig } from '../../srv/lib/session-config';
import { SESSION_COOKIE, SESSION_HEADER } from '../../srv/session-id';

require('../../srv/server');

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.LLM_AGENT_MAX_SESSIONS_PER_USER = '2';
  clearSessionConfig();
  const app = express();
  handlers.bootstrap(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.LLM_AGENT_MAX_SESSIONS_PER_USER;
  clearSessionConfig();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(async () => {
  delete process.env.LLM_AGENT_PLAIN_API;
  delete process.env.LLM_AGENT_PLAIN_MCP;
  clearSessionConfig();
  user.id = 'alice';
  await longSessions().closeAll('explicit');
});

async function openOne(body: unknown = {}) {
  const res = await fetch(`${base}/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

function chat(headers: Record<string, string> = {}, path = 'chat/completions') {
  return fetch(`${base}/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('POST /v1/session', () => {
  it('POST /v1/session → 201 with ls- key and cookie', async () => {
    const { res, body } = await openOne({ destination: 'DEV' });
    expect(res.status).toBe(201);
    expect(body).toEqual({
      session: expect.stringMatching(/^ls-/),
      ttlSeconds: 3600,
      destination: 'DEV',
    });
    expect(res.headers.get('set-cookie')).toContain(
      `${SESSION_COOKIE}=${body.session}`,
    );
    expect(longSessions().get('alice', body.session)?.destination).toBe('DEV');
  });

  it('without a destination: null', async () => {
    const { res, body } = await openOne();
    expect(res.status).toBe(201);
    expect(body.destination).toBeNull();
  });

  it('a destination that is not a string → 400', async () => {
    const { res } = await openOne({ destination: 42 });
    expect(res.status).toBe(400);
  });

  it('SESSION_LIMIT → 429', async () => {
    await openOne();
    await openOne();
    const { res, body } = await openOne();
    expect(res.status).toBe(429);
    expect(body).toMatchObject({ error: { code: 'SESSION_LIMIT' } });
  });

  it('a stale key in the cookie does not stop a new open', async () => {
    const res = await fetch(`${base}/v1/session`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=ls-gone` },
    });
    expect(res.status).toBe(201);
  });
});

describe('closing', () => {
  it('DELETE /v1/session with the header closes the long session → 204', async () => {
    const { body } = await openOne();
    const res = await fetch(`${base}/v1/session`, {
      method: 'DELETE',
      headers: { [SESSION_HEADER]: body.session },
    });
    expect(res.status).toBe(204);
    expect(longSessions().has('alice', body.session)).toBe(false);
    // Closed means gone: the key is refused from now on.
    expect((await chat({ [SESSION_HEADER]: body.session })).status).toBe(404);
  });

  it('POST /v1/session/close with the cookie (sendBeacon) → 204, cookie expired', async () => {
    const { body } = await openOne();
    const res = await fetch(`${base}/v1/session/close`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${body.session}` },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(longSessions().has('alice', body.session)).toBe(false);
  });

  it('closing a key that is already gone → 204', async () => {
    const res = await fetch(`${base}/v1/session`, {
      method: 'DELETE',
      headers: { [SESSION_HEADER]: 'ls-gone' },
    });
    expect(res.status).toBe(204);
  });

  it('without a long session: the clear-chat of today → 204', async () => {
    const res = await fetch(`${base}/v1/session`, {
      method: 'DELETE',
      headers: { cookie: `${SESSION_COOKIE}=s-plain` },
    });
    expect(res.status).toBe(204);
  });
});

describe('plain mode', () => {
  it('chat without key in default mode → 400 SESSION_REQUIRED', async () => {
    const res = await chat();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'SESSION_REQUIRED' },
    });
  });

  it('/v1/messages without key in default mode → 400 SESSION_REQUIRED', async () => {
    const res = await chat({}, 'messages');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      type: 'error',
      error: { code: 'SESSION_REQUIRED' },
    });
  });

  it('chat with the key of an open session reaches the handler in it', async () => {
    const { body } = await openOne();
    const res = await chat({ [SESSION_HEADER]: body.session });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reached: 'chat',
      session: body.session,
    });
  });

  it("plain mode on → today's behaviour", async () => {
    process.env.LLM_AGENT_PLAIN_API = 'true';
    clearSessionConfig();
    const res = await chat();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: 'chat', session: null });
    const m = await chat({}, 'messages');
    expect(await m.json()).toEqual({ reached: 'messages', session: null });
  });

  it('R16 header wins over a different cookie on the wire', async () => {
    const { body } = await openOne();
    const res = await chat({
      [SESSION_HEADER]: body.session,
      cookie: `${SESSION_COOKIE}=ls-other`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reached: 'chat',
      session: body.session,
    });
  });

  it("another user's key → 404 SESSION_NOT_FOUND", async () => {
    const { body } = await openOne();
    user.id = 'mallory';
    const res = await chat({ [SESSION_HEADER]: body.session });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  it('/mcp/stream/http default → 404 PLAIN_MCP_DISABLED', async () => {
    const res = await fetch(`${base}/mcp/stream/http`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'PLAIN_MCP_DISABLED' });
    expect(JSON.stringify(body)).toContain('/mcp/agent/stream/http');
  });

  it('the CORS preflight lets the session header through', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'OPTIONS',
    });
    expect(res.headers.get('access-control-allow-headers')).toContain(
      SESSION_HEADER,
    );
  });
});

describe('retention and an open long session', () => {
  it('its first request is admitted as presented, though it holds nothing yet', async () => {
    const { body } = await openOne();
    expect(gatekeeper.sessionIsLive('alice', body.session)).toBe(true);
    const a = await gatekeeper.admitPipeline('alice', body.session, undefined, {
      presented: true,
    });
    if (!('admitted' in a))
      throw new Error(`not admitted: ${JSON.stringify(a)}`);
    a.admitted.release();
    // Its collections are the session's to delete, not the hourly sweep's.
    expect(gatekeeper.maySweepSession('alice', body.session)).toBe(false);
  });
});
