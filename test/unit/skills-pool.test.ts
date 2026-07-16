import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSkillsPool } from '../../srv/lib/skills-pool';

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

  it('the in-code preset wins over a plugin skill of the same name', async () => {
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
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const pool = buildSkillsPool({
      dirs: [tmp],
      pluginManager: pluginManager as any,
    });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value).toHaveLength(1);
    const content = await r.value[0].getContent();
    if (!content.ok) throw new Error('getContent failed');
    expect(content.value).toBe('preset body');
  });
});
