import type { NextFunction, Request, Response } from 'express';
import type { LongSession } from '../../srv/lib/long-session';
import { clearSessionConfig } from '../../srv/lib/session-config';
import {
  type LongSessionRequest,
  SESSION_NOTICE_HEADER,
} from '../../srv/lib/session-connection';
import {
  requireLongSession,
  sessionMiddleware,
} from '../../srv/lib/session-middleware';
import { SESSION_COOKIE, SESSION_HEADER } from '../../srv/session-id';

type Stashed = Request & { sessionId?: string; sessionMinted?: boolean };

function run(
  headers: Record<string, string>,
  deps?: Parameters<typeof sessionMiddleware>[0],
) {
  const req = { headers, secure: false } as unknown as Stashed;
  const set: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      set[k] = v;
    },
  } as unknown as Response;
  let called = false;
  const next: NextFunction = () => {
    called = true;
  };
  sessionMiddleware(deps)(req, res, next);
  return { req, set, called };
}

describe('the /v1 session middleware', () => {
  it('honours the cookie it issued', () => {
    const { req, set, called } = run({ cookie: `${SESSION_COOKIE}=s-abc` });
    expect(called).toBe(true);
    expect(req.sessionId).toBe('s-abc');
    expect(req.sessionMinted).toBe(false);
    expect(set['Set-Cookie']).toBeUndefined();
  });

  it('does not let a request name its session', () => {
    const { req, set } = run({ 'x-session-id': 'victim' });
    expect(req.sessionId).not.toBe('victim');
    expect(req.sessionId).toMatch(/^s-/);
    expect(req.sessionMinted).toBe(true);
    expect(set['Set-Cookie']).toContain(`${SESSION_COOKIE}=${req.sessionId}`);
  });

  it('ignores mcp-session-id the same way', () => {
    const { req } = run({ 'mcp-session-id': 'victim' });
    expect(req.sessionId).not.toBe('victim');
  });

  it('marks the cookie Secure behind https', () => {
    const { set } = run({ 'x-forwarded-proto': 'https' });
    expect(set['Set-Cookie']).toContain('Secure');
  });

  it('mints a new session for a cookie that names no live one', () => {
    const { req, set } = run(
      { cookie: `${SESSION_COOKIE}=s-retired` },
      { isLive: () => false, userIdOf: () => 'alice' },
    );
    expect(req.sessionId).not.toBe('s-retired');
    expect(req.sessionMinted).toBe(true);
    expect(set['Set-Cookie']).toContain(`${SESSION_COOKIE}=${req.sessionId}`);
  });

  it('asks about liveness with the user from the token', () => {
    const seen: Array<[string, string]> = [];
    run(
      { cookie: `${SESSION_COOKIE}=s-1` },
      {
        isLive: (u, s) => {
          seen.push([u, s]);
          return true;
        },
        userIdOf: () => 'alice',
      },
    );
    expect(seen).toEqual([['alice', 's-1']]);
  });
});

describe('long-session keys on /v1', () => {
  const live = {
    userId: 'alice',
    key: 'ls-1',
    createdAt: 0,
    lastActivity: 0,
    revived: false,
  } as LongSession;

  /** Runs the middleware to its end: `next`, or a written refusal. */
  async function runKeyed(
    headers: Record<string, string>,
    deps: Parameters<typeof sessionMiddleware>[0] = {},
    path = '/chat/completions',
  ) {
    const req = { headers, secure: false, path } as unknown as Stashed &
      LongSessionRequest;
    const set: Record<string, string> = {};
    const out = { status: 0, body: undefined as unknown, next: false };
    const res = {
      setHeader: (k: string, v: string) => {
        set[k] = v;
      },
      writeHead: (status: number) => {
        out.status = status;
        return res;
      },
      end: (body?: string) => {
        out.body = body ? JSON.parse(body) : undefined;
      },
    } as unknown as Response;
    await sessionMiddleware({
      userIdOf: () => 'alice',
      resolveSession: async (u, k) =>
        u === live.userId && k === live.key ? live : undefined,
      ...deps,
    })(req, res, () => {
      out.next = true;
    });
    return { req, set, out };
  }

  it('header and cookie disagree → 400 SESSION_KEY_CONFLICT', async () => {
    const { out } = await runKeyed({
      [SESSION_HEADER]: 'ls-1',
      cookie: `${SESSION_COOKIE}=s-other`,
    });
    expect(out.next).toBe(false);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({
      error: { code: 'SESSION_KEY_CONFLICT' },
    });
  });

  it('known key → req.sessionId is the key, sessionMinted false', async () => {
    const { req, set, out } = await runKeyed({ [SESSION_HEADER]: 'ls-1' });
    expect(out.next).toBe(true);
    expect(req.sessionId).toBe('ls-1');
    expect(req.sessionMinted).toBe(false);
    expect(req.longSession).toBe(live);
    expect(set['Set-Cookie']).toBeUndefined();
  });

  it('a key in the cookie is honoured as well', async () => {
    const { req } = await runKeyed({ cookie: `${SESSION_COOKIE}=ls-1` });
    expect(req.longSession).toBe(live);
  });

  it('key of another user → 404 SESSION_NOT_FOUND', async () => {
    const { req, out } = await runKeyed(
      { [SESSION_HEADER]: 'ls-1' },
      { userIdOf: () => 'mallory' },
    );
    expect(out.next).toBe(false);
    expect(out.status).toBe(404);
    expect(out.body).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } });
    expect(JSON.stringify(out.body)).toMatch(/open a new session/i);
    expect(req.longSession).toBeUndefined();
  });

  it('answers /v1/messages in the Anthropic envelope', async () => {
    const { out } = await runKeyed(
      { [SESSION_HEADER]: 'ls-gone' },
      {},
      '/messages',
    );
    expect(out.status).toBe(404);
    expect(out.body).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error', code: 'SESSION_NOT_FOUND' },
    });
  });

  it('no key → minted as before', async () => {
    const { req, set, out } = await runKeyed({});
    expect(out.next).toBe(true);
    expect(req.sessionId).toMatch(/^s-/);
    expect(req.sessionMinted).toBe(true);
    expect(req.longSession).toBeUndefined();
    expect(set['Set-Cookie']).toContain(`${SESSION_COOKIE}=${req.sessionId}`);
  });

  it('an unknown key where none is required → minted, never the stale key', async () => {
    const { req, out } = await runKeyed(
      { cookie: `${SESSION_COOKIE}=ls-gone` },
      { keyOptional: () => true },
      '/session',
    );
    expect(out.next).toBe(true);
    expect(req.sessionId).toMatch(/^s-/);
    expect(req.longSession).toBeUndefined();
  });

  it('the revival notice goes out on the first response only', async () => {
    let pending = true;
    const deps = {
      takeRevivalNotice: () => {
        const was = pending;
        pending = false;
        return was;
      },
    };
    const first = await runKeyed({ [SESSION_HEADER]: 'ls-1' }, deps);
    const second = await runKeyed({ [SESSION_HEADER]: 'ls-1' }, deps);
    expect(first.set[SESSION_NOTICE_HEADER]).toBe('revived');
    expect(second.set[SESSION_NOTICE_HEADER]).toBeUndefined();
  });

  it('a failing session store → 503, not a crash', async () => {
    const { out } = await runKeyed(
      { [SESSION_HEADER]: 'ls-1' },
      {
        resolveSession: async () => {
          throw new Error('store down');
        },
      },
    );
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({
      error: { code: 'SESSION_STORE_UNAVAILABLE' },
    });
  });
});

describe('requireLongSession — plain mode', () => {
  afterEach(() => {
    delete process.env.LLM_AGENT_PLAIN_API;
    clearSessionConfig();
  });

  function guard(dialect: 'openai' | 'anthropic', withSession: boolean) {
    const req = {
      longSession: withSession ? ({} as LongSession) : undefined,
    } as unknown as Request;
    const out = { status: 0, body: undefined as unknown, next: false };
    const res = {
      writeHead: (status: number) => {
        out.status = status;
        return res;
      },
      end: (body?: string) => {
        out.body = body ? JSON.parse(body) : undefined;
      },
    } as unknown as Response;
    requireLongSession(dialect)(req, res, () => {
      out.next = true;
    });
    return out;
  }

  it('off by default: a request without a session → 400 SESSION_REQUIRED naming both ways in', () => {
    clearSessionConfig();
    const out = guard('openai', false);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
    const text = JSON.stringify(out.body);
    expect(text).toContain('POST /v1/session');
    expect(text).toContain('/mcp/agent/stream/http');
  });

  it('Anthropic envelope on /v1/messages', () => {
    clearSessionConfig();
    expect(guard('anthropic', false).body).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'SESSION_REQUIRED' },
    });
  });

  it('a request in a session passes', () => {
    clearSessionConfig();
    expect(guard('openai', true).next).toBe(true);
  });

  it('plain mode on → passes without a session', () => {
    process.env.LLM_AGENT_PLAIN_API = 'true';
    clearSessionConfig();
    expect(guard('openai', false).next).toBe(true);
  });
});
