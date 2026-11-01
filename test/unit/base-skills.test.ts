import type { ISkill, ISkillManager } from '@mcp-abap-adt/llm-agent';
import {
  CompositeSkillManager,
  validateSkillKinds,
} from '../../srv/lib/composite-skill-manager';
import { appendBaseSkills, logSkillsPool } from '../../srv/lib/skills-pool';

function skill(name: string, kind: string): ISkill {
  return {
    name,
    description: name,
    meta: { name, description: name, kind },
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
test('cross-manager kind collision fails validation and logging rather than disappearing during merge', async () => {
  const pool = new CompositeSkillManager([
    { source: 'plugin', manager: manager([skill('dup', 'base')]) },
    { source: 'preset', manager: manager([skill('dup', 'informational')]) },
  ]);
  const result = await validateSkillKinds(pool);
  expect(result.ok).toBe(false);
  await expect(logSkillsPool(pool)).rejects.toThrow(/dup.*kind/i);
});

import { buildSkillsPool } from '../../srv/lib/skills-pool';

test('shipped file skills remain informational', async () => {
  const pool = buildSkillsPool();
  expect(await pool.baseSkills()).toEqual([]);
  const skills = await pool.informationalSkills().listSkills();
  expect(skills.ok && skills.value.length).toBeGreaterThan(0);
});
