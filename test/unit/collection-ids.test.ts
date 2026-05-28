import {
  isPhysicalId,
  normalizeLogicalId,
  resolveByName,
  resolveRouteId,
  sanitizeUserKey,
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';

// Minimal registry stub: returns the meta fields the resolvers read.
function stubRegistry(
  ids: Record<string, { owner?: string; scope?: string; sessionId?: string }>,
) {
  return {
    getCollection: (id: string) =>
      id in ids
        ? {
            id,
            owner: ids[id].owner,
            scope: ids[id].scope,
            sessionId: ids[id].sessionId,
          }
        : null,
  } as any;
}

const aliceKey = sanitizeUserKey('alice');
const sessKey = sanitizeUserKey('alice\u0000sess1'); // session key = hash(userId \0 sessionId)

describe('collection-ids helpers', () => {
  test('sanitizeUserKey: deterministic lowercase hex, no PII', () => {
    const k = sanitizeUserKey('Oleksii@Example.COM');
    expect(k).toBe(sanitizeUserKey('Oleksii@Example.COM'));
    expect(k).toMatch(/^[a-f0-9]{16}$/);
    expect(k).not.toContain('Oleksii');
  });

  test('normalizeLogicalId: lowercases, strips, rejects __ at create, falls back for legacy', () => {
    expect(normalizeLogicalId('My-Result')).toBe('my-result');
    expect(() => normalizeLogicalId('a__b')).toThrow(); // create-time: reserved separator
    expect(normalizeLogicalId('a__b', 'orig', true)).toMatch(
      /^legacy-[a-f0-9]{8}$/,
    ); // legacy: falls back, no throw
    expect(normalizeLogicalId('!!!', 'orig-id')).toMatch(
      /^legacy-[a-f0-9]{8}$/,
    ); // empty/invalid → fallback
    expect(normalizeLogicalId('Book Catalog')).toBe('book-catalog');
  });

  test('normalizeLogicalId("!!!"): no fallbackSeed still returns legacy-<8hex>', () => {
    expect(normalizeLogicalId('!!!')).toMatch(/^legacy-[a-f0-9]{8}$/);
  });

  test('userCollectionId composes <logical>__u_<key>', () => {
    expect(userCollectionId('result', 'alice')).toBe(
      `result__u_${sanitizeUserKey('alice')}`,
    );
  });

  test('isPhysicalId detects the __ discriminator', () => {
    expect(isPhysicalId('result__u_abc')).toBe(true);
    expect(isPhysicalId('result')).toBe(false);
  });
});

describe('resolveByName', () => {
  test('read returns own private if present, else undefined (no session)', () => {
    const reg = stubRegistry({ [`result__u_${aliceKey}`]: { owner: 'alice' } });
    expect(resolveByName(reg, 'result', 'alice', undefined, false)).toBe(
      `result__u_${aliceKey}`,
    );
    expect(
      resolveByName(reg, 'missing', 'alice', undefined, false),
    ).toBeUndefined();
  });
  test('write returns own private (create-if-absent, no session)', () => {
    const reg = stubRegistry({});
    expect(resolveByName(reg, 'result', 'alice', undefined, true)).toBe(
      `result__u_${aliceKey}`,
    );
  });
  test('two users never collide', () => {
    const reg = stubRegistry({});
    expect(resolveByName(reg, 'result', 'alice', undefined, true)).not.toBe(
      resolveByName(reg, 'result', 'bob', undefined, true),
    );
  });
  test('rejects __ in name', () => {
    expect(() =>
      resolveByName(stubRegistry({}), 'a__b', 'alice', undefined, true),
    ).toThrow();
  });
  test('anonymous gets no private namespace (read or write)', () => {
    const reg = stubRegistry({});
    expect(
      resolveByName(reg, 'result', 'anonymous', undefined, true),
    ).toBeUndefined();
    expect(resolveByName(reg, 'result', '', undefined, false)).toBeUndefined();
  });
  test('session shadows user on read', () => {
    const reg = stubRegistry({
      [`result__u_${aliceKey}`]: { owner: 'alice' },
      [`result__s_${sessKey}`]: { owner: 'alice' },
    });
    expect(resolveByName(reg, 'result', 'alice', 'sess1', false)).toBe(
      `result__s_${sessKey}`,
    );
  });
  test('session read falls through to user when no session collection yet', () => {
    const reg = stubRegistry({ [`result__u_${aliceKey}`]: { owner: 'alice' } });
    expect(resolveByName(reg, 'result', 'alice', 'sess1', false)).toBe(
      `result__u_${aliceKey}`,
    );
  });
  test('write in a session defaults to the session scope', () => {
    const reg = stubRegistry({});
    expect(resolveByName(reg, 'result', 'alice', 'sess1', true)).toBe(
      `result__s_${sessKey}`,
    );
    expect(resolveByName(reg, 'result', 'alice', undefined, true)).toBe(
      `result__u_${aliceKey}`,
    );
  });
});

describe('resolveRouteId', () => {
  test('physical id (has __) -> exact lookup', () => {
    const reg = stubRegistry({ [`result__u_${aliceKey}`]: { owner: 'alice' } });
    expect(
      resolveRouteId(reg, `result__u_${aliceKey}`, 'alice', undefined, false),
    ).toBe(`result__u_${aliceKey}`);
  });
  test('bare id (no __) -> resolveByName', () => {
    const reg = stubRegistry({});
    expect(resolveRouteId(reg, 'uploads', 'alice', undefined, true)).toBe(
      `uploads__u_${aliceKey}`,
    );
  });
  test('physical id owned by another user -> undefined (no cross-user leak)', () => {
    const reg = stubRegistry({ result__u_OTHER: { owner: 'bob' } });
    expect(
      resolveRouteId(reg, 'result__u_OTHER', 'alice', undefined, false),
    ).toBeUndefined();
  });
  test('session physical id from a DIFFERENT session of the same user -> undefined', () => {
    const otherSessId = sessionCollectionId('result', 'alice', 'sessOLD'); // owned by alice, session sessOLD
    const reg = stubRegistry({
      [otherSessId]: { owner: 'alice', scope: 'session', sessionId: 'sessOLD' },
    });
    expect(
      resolveRouteId(reg, otherSessId, 'alice', 'sess1', false),
    ).toBeUndefined(); // current session is sess1
    expect(resolveRouteId(reg, otherSessId, 'alice', 'sessOLD', false)).toBe(
      otherSessId,
    ); // matching session OK
  });
});
