/**
 * Unit tests for srv/lib/principal.ts — principal identity hashing, system-scope
 * resolution, and fail-closed principal resolution.
 *
 * Under test:
 * - principalHash produces a canonical JSON-array tuple (no string-concatenation
 *   boundary collisions, e.g. "ab"+"c" vs "a"+"bc")
 * - principalHash is deterministic: an absent identity hashes as `null` on every
 *   call, regardless of whether it is omitted or passed explicitly as `null`
 * - the resulting hash never contains the raw SAP login/identity as a substring
 * - resolveSystemScope: header override wins when present, otherwise falls back
 *   to the resolved default; both collapse into a single effective value
 * - resolvePrincipal fails closed (returns null) when cdsUserId is missing or
 *   the literal 'anonymous', and returns a hash for a real user
 */

import { createHash } from 'node:crypto';
import {
  principalHash,
  resolvePrincipal,
  resolveSystemScope,
} from '../../srv/lib/principal';

describe('principalHash', () => {
  it('hashes a canonical JSON-array tuple, not a concatenated string', () => {
    // "ab" + "c" vs "a" + "bc" would collide under naive concatenation but not
    // under a JSON-array tuple.
    const hashA = principalHash({
      cdsUserId: 'ab',
      authMode: 'cbasic',
      resolvedSapIdentity: null,
      jwtSub: null,
    });
    const hashB = principalHash({
      cdsUserId: 'a',
      authMode: 'bcbasic',
      resolvedSapIdentity: null,
      jwtSub: null,
    });

    expect(hashA).not.toBe(hashB);
  });

  it('matches the exact canonical-tuple hashing algorithm', () => {
    const input = {
      cdsUserId: 'alice',
      authMode: 'jwt',
      resolvedSapIdentity: 'ALICE_SAP',
      jwtSub: 'sub-123',
    };
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          input.cdsUserId,
          input.authMode,
          input.resolvedSapIdentity,
          input.jwtSub,
        ]),
      )
      .digest('hex');

    expect(principalHash(input)).toBe(expected);
  });

  it('is deterministic: an omitted identity hashes the same as an explicit null', () => {
    const withOmitted = principalHash({ cdsUserId: 'bob', authMode: 'basic' });
    const withExplicitNull = principalHash({
      cdsUserId: 'bob',
      authMode: 'basic',
      resolvedSapIdentity: null,
      jwtSub: null,
    });

    expect(withOmitted).toBe(withExplicitNull);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const input = {
      cdsUserId: 'carol',
      authMode: 'basic',
      resolvedSapIdentity: 'CAROL_SAP',
      jwtSub: null,
    };

    expect(principalHash(input)).toBe(principalHash(input));
  });

  it('never contains the raw SAP login as a substring of the hash', () => {
    const rawLogin = 'SUPER_SECRET_LOGIN';
    const hash = principalHash({
      cdsUserId: 'dave',
      authMode: 'basic',
      resolvedSapIdentity: rawLogin,
      jwtSub: null,
    });

    expect(hash).not.toContain(rawLogin);
    // sha256 hex digest sanity check
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('resolveSystemScope', () => {
  it('lets the header override win when present', () => {
    const result = resolveSystemScope('200', {
      destinationName: 'S4HANA_DEV',
      client: '100',
    });

    expect(result).toEqual({
      resolvedDestination: 'S4HANA_DEV',
      effectiveClient: '200',
    });
  });

  it('falls back to the resolved default when the header is absent', () => {
    const result = resolveSystemScope(undefined, {
      destinationName: 'S4HANA_DEV',
      client: '100',
    });

    expect(result).toEqual({
      resolvedDestination: 'S4HANA_DEV',
      effectiveClient: '100',
    });
  });

  it('collapses a blank/whitespace-only header to the resolved default', () => {
    const result = resolveSystemScope('   ', {
      destinationName: 'S4HANA_DEV',
      client: '100',
    });

    expect(result).toEqual({
      resolvedDestination: 'S4HANA_DEV',
      effectiveClient: '100',
    });
  });

  it('trims a header override with surrounding whitespace', () => {
    const result = resolveSystemScope('  200  ', {
      destinationName: 'S4HANA_DEV',
      client: '100',
    });

    expect(result).toEqual({
      resolvedDestination: 'S4HANA_DEV',
      effectiveClient: '200',
    });
  });

  it('collapses to an empty string when neither header nor default client is set', () => {
    const result = resolveSystemScope(undefined, {
      destinationName: 'S4HANA_DEV',
    });

    expect(result).toEqual({
      resolvedDestination: 'S4HANA_DEV',
      effectiveClient: '',
    });
  });
});

describe('resolvePrincipal', () => {
  it('fails closed (returns null) when cdsUserId is missing', () => {
    expect(
      resolvePrincipal({ cdsUserId: undefined, authMode: 'basic' }),
    ).toBeNull();
  });

  it("fails closed (returns null) when cdsUserId is the literal 'anonymous'", () => {
    expect(
      resolvePrincipal({ cdsUserId: 'anonymous', authMode: 'basic' }),
    ).toBeNull();
  });

  it('returns a principalHash for a real, authenticated user', () => {
    const result = resolvePrincipal({
      cdsUserId: 'alice',
      authMode: 'basic',
      resolvedSapIdentity: 'ALICE_SAP',
      jwtSub: null,
    });

    expect(result).not.toBeNull();
    expect(result?.principalHash).toBe(
      principalHash({
        cdsUserId: 'alice',
        authMode: 'basic',
        resolvedSapIdentity: 'ALICE_SAP',
        jwtSub: null,
      }),
    );
  });
});
