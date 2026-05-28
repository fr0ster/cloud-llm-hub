import {
  buildSetCookie,
  resolveSessionId,
  SESSION_COOKIE,
} from '../../srv/session-id';

function req(headers: Record<string, string | undefined>) {
  return { headers } as Parameters<typeof resolveSessionId>[0];
}

describe('resolveSessionId', () => {
  test('returns x-session-id header when present (takes precedence over cookie)', () => {
    const r = req({
      'x-session-id': '  hdr-session  ',
      cookie: `${SESSION_COOKIE}=cookie-session`,
    });
    expect(resolveSessionId(r)).toBe('hdr-session');
  });

  test('returns mcp-session-id header when x-session-id is absent', () => {
    const r = req({
      'mcp-session-id': 'mcp-abc',
      cookie: `${SESSION_COOKIE}=cookie-session`,
    });
    expect(resolveSessionId(r)).toBe('mcp-abc');
  });

  test('x-session-id takes precedence over mcp-session-id', () => {
    const r = req({
      'x-session-id': 'x-wins',
      'mcp-session-id': 'mcp-loses',
    });
    expect(resolveSessionId(r)).toBe('x-wins');
  });

  test('falls back to clh_session cookie when no header is present', () => {
    const r = req({
      cookie: `other=value; ${SESSION_COOKIE}=cookie-abc; another=x`,
    });
    expect(resolveSessionId(r)).toBe('cookie-abc');
  });

  test('returns undefined when neither header nor cookie is present', () => {
    expect(resolveSessionId(req({}))).toBeUndefined();
  });

  test('returns undefined when x-session-id is empty after trimming', () => {
    const r = req({ 'x-session-id': '   ' });
    expect(resolveSessionId(r)).toBeUndefined();
  });

  test('returns undefined when cookie is present but clh_session value is empty', () => {
    const r = req({ cookie: `${SESSION_COOKIE}=` });
    expect(resolveSessionId(r)).toBeUndefined();
  });

  test('parses cookie correctly when clh_session is the first entry', () => {
    const r = req({ cookie: `${SESSION_COOKIE}=first; other=x` });
    expect(resolveSessionId(r)).toBe('first');
  });

  test('ignores a cookie named like a prefix of clh_session', () => {
    // e.g. "clh_sessio" must NOT match "clh_session"
    const r = req({ cookie: `clh_sessio=nope` });
    expect(resolveSessionId(r)).toBeUndefined();
  });
});

describe('buildSetCookie', () => {
  test('includes HttpOnly; SameSite=Lax; Path=/', () => {
    const v = buildSetCookie('sid123', false);
    expect(v).toContain('HttpOnly');
    expect(v).toContain('SameSite=Lax');
    expect(v).toContain('Path=/');
    expect(v).toContain('sid123');
  });

  test('includes Secure when secure=true', () => {
    const v = buildSetCookie('sid123', true);
    expect(v).toContain('Secure');
  });

  test('does NOT include Secure when secure=false', () => {
    const v = buildSetCookie('sid123', false);
    expect(v).not.toContain('Secure');
  });

  test('cookie name is SESSION_COOKIE constant', () => {
    const v = buildSetCookie('val', false);
    expect(v.startsWith(`${SESSION_COOKIE}=val`)).toBe(true);
  });
});
