import fs from 'node:fs';
import path from 'node:path';
import { buildSkillsPool } from '../../srv/lib/skills-pool';

const SKILLS_SRC = path.join(__dirname, '..', '..', 'srv', 'skills');

const EXPECTED_SKILL_DIRS = [
  'creating-draft-table',
  'creating-domain',
  'creating-data-element',
  'creating-persistent-table',
  'creating-interface-cds-view',
  'creating-projection-cds-view',
  'creating-metadata-extension',
  'creating-bdef',
  'creating-bimp',
  'creating-projection-bdef',
  'creating-service-definition',
  'creating-service-binding',
  'activating-objects',
  'enforcing-target-package',
  'reading-draft-table',
  'reading-persistent-table',
  'reading-interface-cds-view',
  'reading-bdef',
].sort();

describe('shipped skills', () => {
  it('ships exactly the agreed executor skill set', () => {
    const dirs = fs
      .readdirSync(SKILLS_SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual(EXPECTED_SKILL_DIRS);
  });

  it('every skill dir has a SKILL.md with name and description frontmatter', () => {
    const dirs = fs
      .readdirSync(SKILLS_SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const md = fs.readFileSync(path.join(SKILLS_SRC, d, 'SKILL.md'), 'utf8');
      // Key order in frontmatter is irrelevant to the YAML parser; assert each
      // key is present without anchoring on position (the earlier `^---\n` anchor
      // accidentally forced description-first).
      expect(md).toMatch(/\nname:\s*\S+/);
      expect(md).toMatch(/\ndescription:\s*\S+/);
    }
  });

  it('every skill has a unique description (so create/read variants are distinguishable)', async () => {
    const pool = buildSkillsPool({ dirs: [SKILLS_SRC] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    const descriptions = r.value.map((s) => s.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('ships creating-draft-table with the CDS-element naming rule', async () => {
    const pool = buildSkillsPool({ dirs: [SKILLS_SRC] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    const skill = r.value.find((s) => s.name === 'creating-draft-table');
    expect(skill).toBeDefined();
    const content = await skill!.getContent();
    if (!content.ok) throw new Error('getContent failed');
    expect(content.value).toContain('sych_bdl_draft_admin_inc');
    expect(content.value.toLowerCase()).toContain('cds element');
  });
});
