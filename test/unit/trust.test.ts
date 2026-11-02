import { profileFrontmatter } from '../../srv/lib/agent-profile-records';
import {
  classTrust,
  effectiveTrust,
  parseTrustDefaults,
} from '../../srv/lib/trust';

describe('trust defaults', () => {
  const defaults = { global: 4.5, system: 4.5, docs: 3.5, user: 3, session: 2 };
  test('built-in and partial defaults', () => {
    expect(parseTrustDefaults(undefined)).toEqual(defaults);
    expect(parseTrustDefaults('user=4,session=1.5')).toEqual({
      ...defaults,
      user: 4,
      session: 1.5,
    });
  });
  test.each(['user=6', 'user=x', 'nope=1', 'user', 'user=4.55'])(
    'rejects %s',
    (value) => {
      expect(() => parseTrustDefaults(value)).toThrow(
        /LLM_AGENT_TRUST_DEFAULTS/,
      );
    },
  );
  test('precedence', () => {
    expect(
      effectiveTrust({ record: 1, collection: 4, scope: 'user' }, defaults),
    ).toBe(1);
    expect(effectiveTrust({ collection: 4, scope: 'user' }, defaults)).toBe(4);
    expect(effectiveTrust({ scope: 'session' }, defaults)).toBe(2);
    expect(classTrust({ docs: 4 }, defaults)).toEqual({ ...defaults, docs: 4 });
    expect(classTrust(undefined, defaults)).toEqual(defaults);
  });
  test('profile maps are validated', () => {
    const profile = { kind: 'coordinator', name: 'coordinator' };
    expect(
      profileFrontmatter.safeParse({ ...profile, trust: { docs: 4 } }).success,
    ).toBe(true);
    expect(
      profileFrontmatter.safeParse({ ...profile, trust: { nope: 1 } }).success,
    ).toBe(false);
    expect(
      profileFrontmatter.safeParse({ ...profile, trust: { docs: 6 } }).success,
    ).toBe(false);
  });
});

test('an omitted class in a partial map always keeps a mandatory default', () => {
  const defaults = parseTrustDefaults(undefined);
  expect(classTrust({ docs: undefined }, defaults).docs).toBe(3.5);
});
