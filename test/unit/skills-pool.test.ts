import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileSystemSkillManager } from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';
import { SkillKindConflict } from '../../srv/lib/composite-skill-manager';
import { buildSkillsPool, logSkillsPool } from '../../srv/lib/skills-pool';

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
    ['base', 'informational'],
    ['base', undefined],
  ])(
    'fails startup for kinds %s and %s within one source',
    async (first, second) => {
      for (const [index, kind] of [first, second].entries()) {
        const dir = path.join(tmp, String(index));
        fs.mkdirSync(dir);
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: duplicate\ndescription: test\n${kind ? `kind: ${kind}\n` : ''}---\nbody`,
        );
      }
      await expect(async () =>
        logSkillsPool(buildSkillsPool({ dirs: [tmp] })),
      ).rejects.toBeInstanceOf(SkillKindConflict);
    },
  );

  it('allows duplicate declarations of the same kind', async () => {
    for (const name of ['first', 'second']) {
      writeSkill(tmp, name, 'test', name);
      const file = path.join(tmp, name, 'SKILL.md');
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, 'utf8')
          .replace(`name: ${name}`, 'name: duplicate'),
      );
    }
    const pool = buildSkillsPool({ dirs: [tmp] });
    await expect(logSkillsPool(pool)).resolves.toBeUndefined();
    await expect(pool.listSkills()).resolves.toMatchObject({
      ok: true,
      value: [{ name: 'duplicate' }],
    });
  });

  it('compares known plugin directories with preset directories', () => {
    const pluginDir = path.join(tmp, 'plugin');
    const presetDir = path.join(tmp, 'preset');
    writeSkill(pluginDir, 'duplicate', 'test', 'plugin');
    writeSkill(presetDir, 'duplicate', 'test', 'preset');
    const file = path.join(pluginDir, 'duplicate', 'SKILL.md');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace('description:', 'kind: base\ndescription:'),
    );
    expect(() =>
      buildSkillsPool({ dirs: [presetDir], pluginDirs: [pluginDir] }),
    ).toThrow(SkillKindConflict);
  });

  it('logs and skips an unrelated manager failure', async () => {
    const warn = jest
      .spyOn(cds.log('skills'), 'warn')
      .mockImplementation(() => {});
    const scan = jest
      .spyOn(FileSystemSkillManager.prototype, 'listSkills')
      .mockRejectedValue(
        new Error('unrelated conflicting kind backend problem'),
      );
    try {
      const pool = buildSkillsPool({ dirs: [tmp] });
      await expect(logSkillsPool(pool)).resolves.toBeUndefined();
      await expect(pool.listSkills()).resolves.toEqual({ ok: true, value: [] });
      expect(warn).toHaveBeenCalledWith('skill source threw, skipping', {
        source: `preset:${tmp}`,
        error: 'Error: unrelated conflicting kind backend problem',
      });
    } finally {
      scan.mockRestore();
      warn.mockRestore();
    }
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
    const pool = buildSkillsPool({
      dirs: [tmp],
      pluginManager,
    });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value).toHaveLength(1);
    const content = await r.value[0].getContent();
    if (!content.ok) throw new Error('getContent failed');
    expect(content.value).toBe(
      '[source: global:skills/dup; trust 4.5]\npreset body',
    );
  });
});
