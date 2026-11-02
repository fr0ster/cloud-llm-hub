import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cds from '@sap/cds';
import { buildSkillsPool, SKILLS_DIR } from '../../srv/lib/skills-pool';

function writeSkill(
  baseDir: string,
  name: string,
  description: string,
  body: string,
) {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

describe('buildSkillsPool', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it.each([
    [
      'without front matter',
      '# Plain instructions\r\nBody',
      '# Plain instructions',
    ],
    [
      'without a name',
      '---\nkind: informational\n---\nFirst line\nBody',
      'First line',
    ],
    ['with empty front matter', '---\n\n---\nEmpty metadata', 'Empty metadata'],
  ])(
    'loads a skill %s with directory defaults',
    async (_label, raw, description) => {
      const dir = path.join(tmp, 'fallback');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'SKILL.md'), raw);
      const result = await buildSkillsPool({
        dirs: [{ dir: tmp, source: 'preset' }],
      }).getSkill('preset/fallback');
      if (!result.ok) throw result.error;
      expect(result.value).toBeDefined();
      expect(result.value?.name).toBe('fallback');
      expect(result.value?.description).toBe(description);
      expect(result.value?.meta.kind).toBe('informational');
      expect(result.value?.meta.id).toBe('preset/fallback');
      const content = await result.value?.getContent();
      expect(content?.ok).toBe(true);
      if (content?.ok) expect(content.value).not.toContain('\r');
    },
  );

  it('warns and continues loading other sources when a source cannot be read', async () => {
    const bad = path.join(tmp, 'unreadable');
    const good = path.join(tmp, 'readable');
    fs.mkdirSync(bad);
    writeSkill(good, 'available', 'Available skill', 'body');
    const error = new Error('EACCES: permission denied');
    const warn = jest
      .spyOn(cds.log('skills'), 'warn')
      .mockImplementation(() => {});
    const read = jest.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
      throw error;
    });
    try {
      const pool = buildSkillsPool({ dirs: [bad, good] });
      const result = await pool.listSkills();
      if (!result.ok) throw result.error;
      expect(result.value.map((skill) => skill.meta.id)).toEqual([
        'readable/available',
      ]);
      expect(warn).toHaveBeenCalledWith(
        'skills source unavailable; skipping source',
        { source: 'unreadable', dir: bad, error: String(error) },
      );
    } finally {
      read.mockRestore();
      warn.mockRestore();
    }
  });

  it('keeps hub ids equal to directory names', async () => {
    const result = await buildSkillsPool().getSkill('activating-objects');
    if (!result.ok) throw result.error;
    expect(result.value?.meta.id).toBe('activating-objects');
    expect(fs.existsSync(path.join(SKILLS_DIR, 'activating-objects'))).toBe(
      true,
    );
  });

  it('uses portable source ids across deployment roots and selection', async () => {
    for (const root of ['local', 'cf']) {
      const dir = path.join(tmp, root, 'plugin-skills');
      writeSkill(dir, 'activate', 'Activate objects', 'body');
      const pool = buildSkillsPool({ dirs: [dir] });
      const result = await pool.getSkill('plugin-skills/activate');
      if (!result.ok) throw result.error;
      expect(result.value?.meta.id).toBe('plugin-skills/activate');
      expect(await result.value?.getContent()).toEqual({
        ok: true,
        value: '[source: global:skills/plugin-skills/activate; trust 3]\nbody',
      });
      const selection = await pool
        .informationalSkills()
        .getSkill('plugin-skills/activate');
      if (!selection.ok) throw selection.error;
      expect(selection.value?.name).toBe('plugin-skills/activate');
    }
  });

  it('separates directory sources and preserves explicit ids and display names', async () => {
    const dirs = ['one', 'two'].map((source) => {
      const dir = path.join(tmp, source, 'skills');
      writeSkill(dir, 'activate', 'Activate', 'body');
      return { dir, source };
    });
    fs.writeFileSync(
      path.join(dirs[0].dir, 'activate', 'SKILL.md'),
      '---\nid: explicit-id\nname: Display only\n---\nbody\n',
    );
    const result = await buildSkillsPool({ dirs }).listSkills();
    if (!result.ok) throw result.error;
    expect(result.value.map((skill) => skill.meta.id)).toEqual([
      'explicit-id',
      'two/activate',
    ]);
    expect(result.value[0].name).toBe('Display only');
  });

  it('requires distinct labels for directories with the same basename', () => {
    expect(() =>
      buildSkillsPool({
        dirs: [
          path.join(tmp, 'one', 'skills'),
          path.join(tmp, 'two', 'skills'),
        ],
      }),
    ).toThrow('unique and path-free');
  });

  it('loads skills from the skills directory', async () => {
    writeSkill(
      tmp,
      'creating-draft-table',
      'Create the draft table',
      'rules here',
    );
    const pool = buildSkillsPool({ dirs: [tmp] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value.map((s) => s.name)).toEqual(['creating-draft-table']);
    expect(r.value[0].description).toBe('Create the draft table');
  });

  it('a missing directory yields an empty pool, not a throw', async () => {
    const pool = buildSkillsPool({ dirs: [path.join(tmp, 'does-not-exist')] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value).toEqual([]);
  });

  it('preserves different ids with the same display name', async () => {
    writeSkill(tmp, 'dup', 'preset desc', 'preset body');
    const pluginManager = {
      listSkills: async () => ({
        ok: true as const,
        value: [
          {
            name: 'dup',
            description: 'plugin desc',
            meta: { name: 'dup', description: 'plugin desc' },
            getContent: async () => ({
              ok: true as const,
              value: 'plugin body',
            }),
            listResources: async () => ({ ok: true as const, value: [] }),
            readResource: async () => ({ ok: true as const, value: '' }),
          },
        ],
      }),
      getSkill: async () => ({ ok: true as const, value: undefined }),
      matchSkills: async () => ({ ok: true as const, value: [] }),
    };
    const pool = buildSkillsPool({
      dirs: [{ dir: tmp, source: 'preset' }],
      pluginManager,
    });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value).toHaveLength(2);
    const content = await r.value[1].getContent();
    if (!content.ok) throw new Error('getContent failed');
    expect(content.value).toBe(
      `[source: global:skills/preset/dup; trust 3]\npreset body`,
    );
  });
});
