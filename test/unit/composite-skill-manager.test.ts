import {
  InMemoryRag,
  type ISkill,
  type ISkillManager,
  SkillError,
} from '@mcp-abap-adt/llm-agent';
import {
  CompositeSkillManager,
  type SkillSource,
} from '../../srv/lib/composite-skill-manager';
import { logSkillsPool } from '../../srv/lib/skills-pool';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';

test.each(['returned', 'thrown'])(
  'unrelated conflicting kind error (%s) does not fail startup',
  async (mode) => {
    const broken = failingManager();
    broken.listSkills = async () => {
      const error = new SkillError(
        'unrelated conflicting kind backend problem',
      );
      if (mode === 'thrown') throw error;
      return { ok: false, error };
    };
    const pool = new CompositeSkillManager([
      src('broken', broken),
      src('good', manager([skill('good', '', '')])),
    ]);
    await expect(logSkillsPool(pool)).resolves.toBeUndefined();
    await expect(pool.listSkills()).resolves.toMatchObject({
      ok: true,
      value: [{ name: 'good' }],
    });
  },
);

function skill(name: string, description: string, body: string, id = name) {
  return {
    name,
    description,
    meta: { id, name, description },
    getContent: async () => ({ ok: true as const, value: body }),
    listResources: async () => ({ ok: true as const, value: [] }),
    readResource: async () => ({ ok: true as const, value: '' }),
  };
}

function manager(skills: ReturnType<typeof skill>[]) {
  return {
    listSkills: async () => ({ ok: true as const, value: skills }),
    getSkill: async (n: string) => ({
      ok: true as const,
      value: skills.find((s) => s.name === n),
    }),
    matchSkills: async () => ({ ok: true as const, value: skills }),
  };
}

function failingManager() {
  return {
    listSkills: async () => ({
      ok: false as const,
      error: new SkillError('plugin exploded'),
    }),
    getSkill: async () => ({
      ok: false as const,
      error: new SkillError('nope'),
    }),
    matchSkills: async () => ({
      ok: false as const,
      error: new SkillError('nope'),
    }),
  };
}

const src = (source: string, m: ISkillManager): SkillSource => ({
  source,
  manager: m,
});

describe('CompositeSkillManager', () => {
  it('merges skills from every source', async () => {
    const c = new CompositeSkillManager([
      src('plugin', manager([skill('a', 'desc a', 'body a')])),
      src('preset', manager([skill('b', 'desc b', 'b')])),
    ]);
    const r = await c.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('preserves same-name skills from separate sources', async () => {
    const c = new CompositeSkillManager([
      src(
        'plugin',
        manager([skill('dup', 'plugin desc', 'plugin body', 'plugin-id')]),
      ),
      src(
        'preset',
        manager([skill('dup', 'preset desc', 'preset body', 'preset-id')]),
      ),
    ]);
    const r = await c.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value).toHaveLength(2);
    const content = await r.value[1].getContent();
    if (!content.ok) throw new Error('getContent failed');
    expect(content.value).toBe(
      '[source: global:skills/preset-id; trust 4.5]\npreset body',
    );
  });

  it('a failing source is skipped, the rest still load', async () => {
    const c = new CompositeSkillManager([
      src('plugin', failingManager()),
      src('preset', manager([skill('b', 'desc b', 'b')])),
    ]);
    const r = await c.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value.map((s) => s.name)).toEqual(['b']);
  });

  it('getSkill finds by exact name', async () => {
    const c = new CompositeSkillManager([
      src('preset', manager([skill('b', 'desc b', 'b')])),
    ]);
    const r = await c.getSkill('b');
    if (!r.ok) throw new Error('getSkill failed');
    expect(r.value?.name).toBe('b');
    const missing = await c.getSkill('nope');
    if (!missing.ok) throw new Error('getSkill failed');
    expect(missing.value).toBeUndefined();
  });

  it('matchSkills does case-insensitive substring on name and description', async () => {
    const c = new CompositeSkillManager([
      src(
        'preset',
        manager([
          skill('creating-draft-table', 'Create the draft table', 'body'),
          skill('creating-domain', 'Create a domain', 'body'),
        ]),
      ),
    ]);
    const r = await c.matchSkills('DRAFT');
    if (!r.ok) throw new Error('matchSkills failed');
    expect(r.value.map((s) => s.name)).toEqual(['creating-draft-table']);
  });
});

test('plugin identities, trust overrides and cached base bodies survive reordering', async () => {
  const store = new TrustStore(new InMemoryRag(), 3);
  const resolver = new TrustResolver({}, store, parseTrustDefaults(undefined));
  const make = (name: string, kind: string): ISkill => ({
    ...skill(name, '', name),
    meta: { name, description: '', kind },
  });
  const skills = [
    make('alpha', 'informational'),
    make('beta', 'informational'),
    make('base-a', 'base'),
    make('base-b', 'base'),
  ];
  const pool = new CompositeSkillManager(
    [
      src('plugin', {
        ...manager([]),
        listSkills: async () => ({ ok: true, value: skills }),
      }),
    ],
    () => resolver,
  );
  await store.setRecord('skills', 'plugin/alpha', 2, 'alice');
  expect(await pool.baseSkillContents()).toEqual(['base-a', 'base-b']);
  skills.reverse();
  skills.push(make('new', 'informational'));
  expect(await pool.baseSkillContents()).toEqual(['base-b', 'base-a']);
  const alpha = await pool.getSkill('plugin/alpha');
  if (!alpha.ok) throw alpha.error;
  expect(alpha.value?.name).toBe('alpha');
  expect(await alpha.value?.getContent()).toMatchObject({
    value: '[source: global:skills/plugin/alpha; trust 2]\nalpha',
  });
  const beta = await pool.getSkill('plugin/beta');
  if (!beta.ok) throw beta.error;
  expect(beta.value?.name).toBe('beta');
});

test('colliding plugin directory names retain stable location-derived ids', async () => {
  const skills = ['one/shared', 'two/shared'].map((dir) => ({
    ...skill('Same', '', dir),
    dir,
    meta: { name: 'Same', description: '' },
  }));
  const pool = new CompositeSkillManager([
    src('plugin', {
      ...manager([]),
      listSkills: async () => ({ ok: true, value: skills }),
    }),
  ]);
  const before = await pool.listSkills();
  skills.reverse();
  const after = await pool.listSkills();
  if (!before.ok || !after.ok) throw new Error('list failed');
  expect(before.value).toHaveLength(2);
  expect(new Set(before.value.map((s) => s.meta.id)).size).toBe(2);
  expect(after.value.map((s) => s.meta.id)).toEqual(
    before.value.map((s) => s.meta.id).reverse(),
  );
});

test('plugin explicit ids retain their existing identity', async () => {
  const pool = new CompositeSkillManager([
    src('plugin', manager([skill('Display', '', 'body', 'stable-id')])),
  ]);
  const result = await pool.getSkill('stable-id');
  if (!result.ok) throw result.error;
  expect(result.value?.name).toBe('Display');
});
