import { profileFrontmatter } from '../../srv/lib/agent-profile-records';
import {
  classTrust,
  effectiveTrust,
  parseTrustDefaults,
} from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';

describe('trust defaults', () => {
  const defaults = {
    global: 3,
    system: 4.8,
    correction: 4.9,
    target: 4.3,
    docs: 4.2,
    client: 4.4,
    user: 3.5,
    session: 4,
  };
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
    expect(effectiveTrust({ scope: 'session' }, defaults)).toBe(4);
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
  expect(classTrust({ docs: undefined }, defaults).docs).toBe(4.2);
});

test('instruction overrides and MCP results rank above informational defaults', () => {
  const defaults = parseTrustDefaults(undefined);
  const ordered = [
    'correction',
    'system',
    'client',
    'target',
    'docs',
    'session',
    'user',
    'global',
  ] as const;
  expect(ordered.map((key) => defaults[key])).toEqual([
    4.9, 4.8, 4.4, 4.3, 4.2, 4, 3.5, 3,
  ]);
  for (let index = 1; index < ordered.length; index++) {
    expect(defaults[ordered[index - 1]]).toBeGreaterThan(
      defaults[ordered[index]],
    );
  }
  expect(parseTrustDefaults('correction=4.9,target=4.7')).toMatchObject({
    correction: 4.9,
    target: 4.7,
  });
  expect(classTrust({ correction: 4.2, target: 4.1 }, defaults)).toMatchObject({
    correction: 4.2,
    target: 4.1,
  });
  expect(
    profileFrontmatter.safeParse({
      kind: 'coordinator',
      name: 'coordinator',
      trust: { correction: 4.9, target: 4.6 },
    }).success,
  ).toBe(true);
});

test('client defaults and profile overrides resolve through TrustResolver', () => {
  const defaults = parseTrustDefaults('client=4.1');
  const resolver = new TrustResolver(undefined, undefined, defaults);
  expect(resolver.classDefault('client')).toBe(4.1);
  expect(
    resolver.forProfile({ trust: { client: 4.7 } }).classDefault('client'),
  ).toBe(4.7);
  expect(
    resolver.forProfile({ trust: { docs: 1 } }).classDefault('client'),
  ).toBe(4.1);
  expect(
    profileFrontmatter.safeParse({
      kind: 'coordinator',
      name: 'coordinator',
      trust: { client: 4.4 },
    }).success,
  ).toBe(true);
  expect(() => parseTrustDefaults('client=4.55')).toThrow(
    /LLM_AGENT_TRUST_DEFAULTS/,
  );
});
