import { type ISkillManager, SkillError } from '@mcp-abap-adt/llm-agent';
import {
  CompositeSkillManager,
  type SkillSource,
} from '../../srv/lib/composite-skill-manager';
import { logSkillsPool } from '../../srv/lib/skills-pool';

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
