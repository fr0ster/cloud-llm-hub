import type { NextFunction, Request, Response } from 'express';
import { sessionMiddleware } from '../../srv/lib/session-middleware';
import { SESSION_COOKIE } from '../../srv/session-id';

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
