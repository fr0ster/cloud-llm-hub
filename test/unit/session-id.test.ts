import {
  buildSetCookie,
  carriesSessionHeader,
  honouredSessionId,
  resolveSessionId,
  SESSION_COOKIE,
  sessionIdOf,
} from '../../srv/session-id';

function req(headers: Record<string, string | undefined>) {
  return { headers } as Parameters<typeof resolveSessionId>[0];
}

describe('resolveSessionId — the cookie we issued, and nothing a caller names', () => {
  test('reads the clh_session cookie', () => {
    const r = req({
      cookie: `other=value; ${SESSION_COOKIE}=cookie-abc; another=x`,
    });
    expect(resolveSessionId(r)).toBe('cookie-abc');
  });

  test('does not read x-session-id', () => {
    expect(resolveSessionId(req({ 'x-session-id': 'hdr' }))).toBeUndefined();
  });

  test('does not read mcp-session-id', () => {
    expect(resolveSessionId(req({ 'mcp-session-id': 'mcp' }))).toBeUndefined();
  });

  test('a header naming another session changes nothing', () => {
    // The case the header existed for, and the reason it goes: whatever a
    // caller writes, the session is the one in the cookie we issued.
    const r = req({
      'x-session-id': 'victim',
      cookie: `${SESSION_COOKIE}=mine`,
    });
    expect(resolveSessionId(r)).toBe('mine');
  });

  test('returns undefined when there is no cookie', () => {
    expect(resolveSessionId(req({}))).toBeUndefined();
  });

  test('returns undefined when the clh_session value is empty', () => {
    expect(
      resolveSessionId(req({ cookie: `${SESSION_COOKIE}=` })),
    ).toBeUndefined();
  });

  test('parses the cookie when clh_session is the first entry', () => {
    expect(
      resolveSessionId(req({ cookie: `${SESSION_COOKIE}=first; other=x` })),
    ).toBe('first');
  });

  test('ignores a cookie named like a prefix of clh_session', () => {
    expect(
      resolveSessionId(req({ cookie: 'clh_sessio=nope' })),
    ).toBeUndefined();
  });
});

describe('carriesSessionHeader', () => {
  test('sees x-session-id', () => {
    expect(carriesSessionHeader(req({ 'x-session-id': 'a' }))).toBe(true);
  });

  test('sees mcp-session-id', () => {
    expect(carriesSessionHeader(req({ 'mcp-session-id': 'a' }))).toBe(true);
  });

  test('does not count a blank header', () => {
    expect(carriesSessionHeader(req({ 'x-session-id': '   ' }))).toBe(false);
  });

  test('does not count the cookie', () => {
    expect(carriesSessionHeader(req({ cookie: `${SESSION_COOKIE}=a` }))).toBe(
      false,
    );
  });
});

describe('sessionIdOf and honouredSessionId', () => {
  test('prefer what the middleware stashed over the raw cookie', () => {
    const r = {
      ...req({ cookie: `${SESSION_COOKIE}=old` }),
      sessionId: 's-new',
      sessionMinted: true,
    };
    expect(sessionIdOf(r)).toBe('s-new');
    // Minted now: the caller presented nothing we kept, so there is no
    // server-managed history to prepend.
    expect(honouredSessionId(r)).toBeUndefined();
  });

  test('a kept cookie is honoured', () => {
    const r = {
      ...req({ cookie: `${SESSION_COOKIE}=kept` }),
      sessionId: 'kept',
      sessionMinted: false,
    };
    expect(honouredSessionId(r)).toBe('kept');
  });

  test('fall back to the cookie when no middleware ran', () => {
    expect(sessionIdOf(req({ cookie: `${SESSION_COOKIE}=raw` }))).toBe('raw');
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
    expect(buildSetCookie('sid123', true)).toContain('Secure');
  });

  test('does NOT include Secure when secure=false', () => {
    expect(buildSetCookie('sid123', false)).not.toContain('Secure');
  });

  test('cookie name is SESSION_COOKIE constant', () => {
    expect(
      buildSetCookie('val', false).startsWith(`${SESSION_COOKIE}=val`),
    ).toBe(true);
  });
});
