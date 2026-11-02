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
    expect(prompt).toBe(
      `${role} profile\n\n[source: system:skills/base:base; trust 4.8]\nbase body`,
    );
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
    'system\n\n[source: system:skills/base:dup; trust 4.8]\ndup body',
  );
  const result = await pool.informationalSkills().listSkills();
  if (!result.ok) throw result.error;
  expect(result.value).toHaveLength(1);
  expect(await result.value[0].getContent()).toEqual({
    ok: true,
    value: '[source: global:skills/dup; trust 3]\ndup body',
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
      'profile\n\n[source: system:skills/test/rules; trust 4.8]\noriginal',
    );
    await pool.refresh();
    await expect(appendBaseSkills('profile', pool)).resolves.toBe(
      'profile\n\n[source: system:skills/test/rules; trust 4.8]\nchanged',
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

test('corrective skill body, selection and views use correction trust and retain explicit overrides', async () => {
  const { InMemoryRag } = await import('@mcp-abap-adt/llm-agent');
  const { parseTrustDefaults } = await import('../../srv/lib/trust');
  const { TrustResolver } = await import('../../srv/lib/trust-resolver');
  const { TrustStore } = await import('../../srv/lib/trust-store');
  const { trustedSkillResults } = await import('../../srv/lib/trusted-skill');
  const { informationalSkillDocuments } = await import(
    '../../srv/lib/skills-pool'
  );
  const store = new TrustStore(new InMemoryRag(), 1);
  const resolver = new TrustResolver(
    undefined,
    store,
    parseTrustDefaults(undefined),
    { correction: 4.9 },
  );
  const pool = new CompositeSkillManager(
    [{ source: 'experience', manager: manager([skill('fix', 'correction')]) }],
    () => resolver,
  );
  const loaded = await pool.getSkill('fix');
  if (!loaded.ok || !loaded.value) throw new Error('Missing skill');
  expect(await loaded.value.getContent()).toEqual({
    ok: true,
    value: '[source: correction:skills/fix; trust 4.9]\nfix body',
  });
  const rows = await trustedSkillResults(
    [{ text: 'fix', score: 1, metadata: { id: 'skill:fix' } }],
    resolver,
    pool,
  );
  expect(rows[0].metadata).toMatchObject({
    source: 'correction:skills/fix',
    trust: 4.9,
  });
  expect(await informationalSkillDocuments(resolver, pool)).toMatchObject([
    { source: 'correction:skills/fix', trust: 4.9 },
  ]);
  await store.setRecord('skills', 'fix', 4.2, 'admin');
  expect(await loaded.value.getContent()).toEqual({
    ok: true,
    value: '[source: correction:skills/fix; trust 4.2]\nfix body',
  });
});
