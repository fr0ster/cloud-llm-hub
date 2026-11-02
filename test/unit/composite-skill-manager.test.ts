import {
  InMemoryRag,
  type ISkill,
  type ISkillManager,
  SkillError,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  CompositeSkillManager,
  type SkillSource,
} from '../../srv/lib/composite-skill-manager';
import {
  informationalSkillDocuments,
  logSkillsPool,
} from '../../srv/lib/skills-pool';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';
import { trustedSkillResults } from '../../srv/lib/trusted-skill';

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

function manager(skills: ISkill[]): ISkillManager {
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
      '[source: global:skills/preset-id; trust 3]\npreset body',
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

test('fallback identities survive deployment moves, content edits and additions', async () => {
  const make = (dir: string, body: string): ISkill => ({
    ...skill('Same', '', body),
    meta: { name: 'Same', description: '', dir },
  });
  const skills = [make('/old/plugin/alpha', 'original')];
  const pool = new CompositeSkillManager([
    {
      source: 'plugin',
      manager: {
        ...manager([]),
        listSkills: async () => ({ ok: true, value: skills }),
      },
    },
  ]);
  const ids = async () => {
    const result = await pool.listSkills();
    if (!result.ok) throw result.error;
    return result.value.map((s) => s.meta.id);
  };
  expect(await ids()).toEqual(['plugin/alpha']);
  skills[0] = make('/new/deployment/plugin/alpha', 'edited');
  skills.push(make('/new/deployment/plugin/beta', 'another'));
  expect(await ids()).toEqual(['plugin/alpha', 'plugin/beta']);
});

test('same-name skills without locations remain usable but ambiguous with source trust', async () => {
  const warn = jest
    .spyOn(cds.log('skills'), 'warn')
    .mockImplementation(() => {});
  try {
    const store = new TrustStore(new InMemoryRag(), 3);
    const resolver = new TrustResolver(
      {},
      store,
      parseTrustDefaults(undefined),
    );
    const make = (name: string, body: string): ISkill => ({
      ...skill(name, '', body),
      meta: { name, description: '' },
    });
    const skills = [make('Same', 'first'), make('Other', 'other')];
    const pool = new CompositeSkillManager(
      [
        {
          source: 'plugin',
          manager: {
            ...manager([]),
            listSkills: async () => ({ ok: true, value: skills }),
          },
        },
      ],
      () => resolver,
    );
    await store.setSource('skills', 2, 'alice');
    await store.setRecord('skills', 'plugin/Same', 1, 'alice');
    await store.setRecord('skills', 'plugin/Other', 3, 'alice');
    skills.push(make('Same', 'second'));
    skills.reverse();
    for (let i = 0; i < 2; i++) {
      const result = await pool.listSkills();
      if (!result.ok) throw result.error;
      expect(result.value).toHaveLength(3);
      const duplicates = result.value.filter((s) => s.name === 'Same');
      expect(duplicates.map((s) => s.meta.id)).toEqual([
        'plugin/Same',
        'plugin/Same',
      ]);
      expect(duplicates.every((s) => s.meta.trustAmbiguous === true)).toBe(
        true,
      );
      const bodies = await Promise.all(duplicates.map((s) => s.getContent()));
      expect(bodies).toEqual([
        {
          ok: true,
          value: '[source: global:skills/plugin/Same; trust 2]\nsecond',
        },
        {
          ok: true,
          value: '[source: global:skills/plugin/Same; trust 2]\nfirst',
        },
      ]);
    }
    const docs = await informationalSkillDocuments(resolver, pool);
    expect(docs.map((d) => d.id)).toEqual(['plugin/Other']);
    expect(await store.getRecord('skills', 'plugin/Other')).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('explicit `id`');
  } finally {
    warn.mockRestore();
  }
});

test.each(['explicit', 'fallback'] as const)(
  'cross-source %s id collisions use live source trust for bodies and descriptions',
  async (identity) => {
    const warn = jest
      .spyOn(cds.log('skills'), 'warn')
      .mockImplementation(() => {});
    try {
      const store = new TrustStore(new InMemoryRag(), 3);
      const resolver = new TrustResolver(
        {},
        store,
        parseTrustDefaults(undefined),
      );
      const first: ISkill = skill(
        'shared',
        'first description',
        'first body',
        'plugin/shared',
      );
      if (identity === 'fallback') delete first.meta.id;
      const pool = new CompositeSkillManager(
        [
          src('plugin', manager([first])),
          src(
            'preset',
            manager([
              skill(
                'other',
                'second description',
                'second body',
                'plugin/shared',
              ),
            ]),
          ),
        ],
        () => resolver,
      );
      await store.setRecord('skills', 'plugin/shared', 1, 'alice');
      const result = await pool.listSkills();
      if (!result.ok) throw result.error;
      expect(result.value).toHaveLength(2);
      expect(result.value.every((s) => s.meta.trustAmbiguous === true)).toBe(
        true,
      );
      const rows = result.value.map((s) => ({
        text: s.description,
        score: 1,
        metadata: { id: `skill:${String(s.meta.id)}` },
      }));
      for (const [index, trust] of [3, 2, 3].entries()) {
        if (index > 0) await store.setSource('skills', trust, 'alice');
        expect(
          await Promise.all(result.value.map((s) => s.getContent())),
        ).toEqual([
          {
            ok: true,
            value: `[source: global:skills/plugin/shared; trust ${trust}]\nfirst body`,
          },
          {
            ok: true,
            value: `[source: global:skills/plugin/shared; trust ${trust}]\nsecond body`,
          },
        ]);
        const descriptions = await trustedSkillResults(rows, resolver, pool);
        expect(descriptions.map((row) => row.metadata.trust)).toEqual([
          trust,
          trust,
        ]);
      }
      expect(await informationalSkillDocuments(resolver, pool)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  },
);

test('base bodies with cross-source duplicate ids never share cached content', async () => {
  const first = {
    ...skill('first', '', 'first body', 'shared'),
    meta: { name: 'base', description: '', id: 'shared', kind: 'base' },
  };
  const second = {
    ...skill('second', '', 'second body', 'shared'),
    meta: { name: 'base', description: '', id: 'shared', kind: 'base' },
  };
  const skills: ISkill[] = [];
  const pool = new CompositeSkillManager([
    src('plugin', manager([first])),
    src('preset', {
      ...manager([]),
      listSkills: async () => ({ ok: true, value: skills }),
    }),
  ]);
  expect(await pool.baseSkillContents()).toEqual(['first body']);
  skills.push(second);
  expect(await pool.baseSkillContents()).toEqual(['first body', 'second body']);
  skills.splice(0, 1);
  expect(await pool.baseSkillContents()).toEqual(['first body']);
});

test('base body cache separates sources when an id moves between them', async () => {
  const make = (body: string): ISkill => ({
    ...skill('base', '', body, 'shared'),
    meta: { name: 'base', description: '', id: 'shared', kind: 'base' },
  });
  const first = [make('first source body')];
  const second: ISkill[] = [];
  const source = (name: string, skills: ISkill[]): SkillSource =>
    src(name, {
      ...manager([]),
      listSkills: async () => ({ ok: true, value: skills }),
    });
  const pool = new CompositeSkillManager([
    source('one', first),
    source('two', second),
  ]);
  expect(await pool.baseSkillContents()).toEqual(['first source body']);
  first.pop();
  second.push(make('second source body'));
  expect(await pool.baseSkillContents()).toEqual(['second source body']);
});
