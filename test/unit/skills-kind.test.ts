import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendBaseSkills,
  buildSkillsPool,
  informationalSkillDocuments,
  logSkillsPool,
} from '../../srv/lib/skills-pool';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';

test('same-name base and informational skills load and startup succeeds', async () => {
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
    const pool = buildSkillsPool({ dirs });
    await expect(logSkillsPool(pool)).resolves.toBeUndefined();
    await expect(appendBaseSkills('system', pool)).resolves.toBe(
      'system\n\n[source: system:skills/base/duplicate; trust 4.8]\nbody',
    );
    const result = await pool.informationalSkills().listSkills();
    if (!result.ok) throw result.error;
    expect(result.value).toHaveLength(1);
    expect(await result.value[0].getContent()).toEqual({
      ok: true,
      value: `[source: system:skills/${path.basename(dirs[1])}/duplicate; trust 4.8]\nbody`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one filesystem source preserves different ids with the same name and kind', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'skill-ids-'));
  try {
    for (const id of ['base-one', 'base-two', 'info']) {
      mkdirSync(path.join(dir, id));
      writeFileSync(
        path.join(dir, id, 'SKILL.md'),
        `---\nname: shared\ndescription: test\nkind: ${id === 'info' ? 'informational' : 'base'}\n---\n${id}`,
      );
    }
    const pool = buildSkillsPool({ dirs: [dir] });
    await expect(logSkillsPool(pool)).resolves.toBeUndefined();
    await expect(appendBaseSkills('system', pool)).resolves.toBe(
      `system\n\n[source: system:skills/${path.basename(dir)}/base-one; trust 4.8]\nbase-one\n\n[source: system:skills/${path.basename(dir)}/base-two; trust 4.8]\nbase-two`,
    );
    const info = await pool.informationalSkills().listSkills();
    if (!info.ok) throw info.error;
    expect(info.value.map((skill) => skill.name)).toEqual([
      `${path.basename(dir)}/info`,
    ]);
    expect(await info.value[0].getContent()).toEqual({
      ok: true,
      value: `[source: system:skills/${path.basename(dir)}/info; trust 4.8]\ninfo`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    const pool = buildSkillsPool({ dirs: [dir] });
    const base = await pool.getSkill(`${path.basename(dir)}/base`);
    expect(base).toMatchObject({ ok: true, value: { meta: { kind: 'base' } } });
    const documents = await informationalSkillDocuments(
      new TrustResolver(undefined, undefined, parseTrustDefaults(undefined)),
      pool,
    );
    expect(documents.map((doc) => doc.id)).toEqual([
      `${path.basename(dir)}/info`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
