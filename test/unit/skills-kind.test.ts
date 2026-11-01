import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillKindConflict } from '../../srv/lib/composite-skill-manager';
import {
  buildSkillsPool,
  informationalSkillDocuments,
  logSkillsPool,
  skillKind,
} from '../../srv/lib/skills-pool';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';

test('preset directory collision fails startup from compared kinds', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-collision-'));
  try {
    const dirs = ['base', 'informational'].map((kind) => {
      const dir = path.join(root, kind);
      mkdirSync(path.join(dir, 'duplicate'), { recursive: true });
      writeFileSync(
        path.join(dir, 'duplicate', 'SKILL.md'),
        `---\nname: duplicate\ndescription: test\nkind: ${kind}\n---\nbody`,
      );
      return dir;
    });
    await expect(
      logSkillsPool(buildSkillsPool({ dirs })),
    ).rejects.toBeInstanceOf(SkillKindConflict);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unspecified skills are informational', () => {
  expect(skillKind('missing')).toBe('informational');
});

test('front matter declares base skills and defaults to informational', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trust-skills-'));
  try {
    for (const name of ['base', 'info']) {
      mkdirSync(path.join(dir, name));
      writeFileSync(
        path.join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: test\n${name === 'base' ? 'kind: base\n' : ''}---\nbody`,
      );
    }
    expect(skillKind('base', [dir])).toBe('base');
    expect(skillKind('info', [dir])).toBe('informational');
    const pool = buildSkillsPool({ dirs: [dir] });
    const base = await pool.getSkill('base');
    expect(base).toMatchObject({ ok: true, value: { meta: { kind: 'base' } } });
    const documents = await informationalSkillDocuments(
      new TrustResolver(undefined, undefined, parseTrustDefaults(undefined)),
      pool,
    );
    expect(documents.map((doc) => doc.id)).toEqual(['info']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
