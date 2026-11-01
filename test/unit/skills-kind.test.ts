import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildSkillsPool,
  informationalSkillDocuments,
  skillKind,
} from '../../srv/lib/skills-pool';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';

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
