import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ISkill, ISkillManager } from '@mcp-abap-adt/llm-agent';
import { CompositeSkillManager } from '../../srv/lib/composite-skill-manager';
import { appendBaseSkills, logSkillsPool } from '../../srv/lib/skills-pool';

function skill(name: string, kind: string): ISkill {
  return {
    name,
    description: name,
    meta: {
      id: kind === 'base' ? `base:${name}` : name,
      name,
      description: name,
      kind,
    },
    getContent: async () => ({ ok: true, value: `${name} body` }),
    listResources: async () => ({ ok: true, value: [] }),
    readResource: async () => ({ ok: true, value: '' }),
  };
}
function manager(skills: ISkill[]): ISkillManager {
  return {
    listSkills: async () => ({ ok: true, value: skills }),
    getSkill: async (name) => ({
      ok: true,
      value: skills.find((s) => s.name === name),
    }),
    matchSkills: async () => ({ ok: true, value: skills }),
  };
}
test.each([
  'coordinator',
  'planner-create',
  'planner-revise',
  'executor',
  'checker',
])(
  '%s loads plugin base after profile without semantic selection',
  async (role) => {
    const pool = new CompositeSkillManager([
      {
        source: 'plugin',
        manager: manager([
          skill('base', 'base'),
          skill('info', 'informational'),
        ]),
      },
    ]);
    const prompt = await appendBaseSkills(`${role} profile`, pool);
    expect(prompt).toBe(`${role} profile\n\nbase body`);
    const selection = await (await pool.informationalSkills()).listSkills();
    expect(selection.ok && selection.value.map((s) => s.name)).toEqual([
      'info',
    ]);
    expect(prompt).not.toContain('Active Skills');
    expect(prompt).not.toContain('info body');
  },
);
test('same-name skills of both kinds load without a startup failure', async () => {
  const pool = new CompositeSkillManager([
    { source: 'plugin', manager: manager([skill('dup', 'base')]) },
    { source: 'preset', manager: manager([skill('dup', 'informational')]) },
  ]);
  await expect(logSkillsPool(pool)).resolves.toBeUndefined();
  await expect(appendBaseSkills('system', pool)).resolves.toBe(
    'system\n\ndup body',
  );
  const result = await pool.informationalSkills().listSkills();
  if (!result.ok) throw result.error;
  expect(result.value).toHaveLength(1);
  expect(await result.value[0].getContent()).toEqual({
    ok: true,
    value: '[source: global:skills/dup; trust 4.5]\ndup body',
  });
});

import { buildSkillsPool } from '../../srv/lib/skills-pool';

test('shipped file skills remain informational', async () => {
  const pool = buildSkillsPool();
  expect(await pool.baseSkills()).toEqual([]);
  const skills = await pool.informationalSkills().listSkills();
  expect(skills.ok && skills.value.length).toBeGreaterThan(0);
});

test('filesystem discovery and base bodies stay cached until explicit refresh', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'base-cache-'));
  const skillDir = path.join(dir, 'rules');
  mkdirSync(skillDir);
  const file = path.join(skillDir, 'SKILL.md');
  const write = (body: string) =>
    writeFileSync(file, `---\nname: rules\nkind: base\n---\n${body}`);
  try {
    write('original');
    const pool = buildSkillsPool({ dirs: [{ dir, source: 'test' }] });
    write('changed');
    await expect(appendBaseSkills('profile', pool)).resolves.toBe(
      'profile\n\noriginal',
    );
    await pool.refresh();
    await expect(appendBaseSkills('profile', pool)).resolves.toBe(
      'profile\n\nchanged',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent agent builds share base content by id until refresh', async () => {
  const base = skill('rules', 'base');
  const getContent = jest.fn(base.getContent);
  base.getContent = getContent;
  const pool = new CompositeSkillManager([
    { source: 'plugin', manager: manager([base]) },
  ]);
  await Promise.all([
    appendBaseSkills('one', pool),
    appendBaseSkills('two', pool),
  ]);
  expect(getContent).toHaveBeenCalledTimes(1);
  await pool.refresh();
  await appendBaseSkills('three', pool);
  expect(getContent).toHaveBeenCalledTimes(2);
});

test('disabled base skills stay out of the base set', async () => {
  const disabled = skill('off', 'base');
  disabled.meta.enabled = false;
  const pool = new CompositeSkillManager([
    { source: 'plugin', manager: manager([skill('on', 'base'), disabled]) },
  ]);
  expect((await pool.baseSkills()).map((s) => s.name)).toEqual(['on']);
});
