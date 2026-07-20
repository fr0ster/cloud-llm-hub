import fs from 'node:fs';
import path from 'node:path';
import { SKILL_EXPOSITIONS } from '../../srv/lib/skill-expositions';

const SKILLS_SRC = path.join(__dirname, '..', '..', 'srv', 'skills');

describe('SKILL_EXPOSITIONS', () => {
  it('tags every shipped skill with an exposition', () => {
    const dirs = fs
      .readdirSync(SKILLS_SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const d of dirs) {
      expect(SKILL_EXPOSITIONS[d]).toBeDefined();
    }
  });

  it('scopes write skills (creating/activating/enforcing) to high', () => {
    expect(SKILL_EXPOSITIONS['creating-domain']).toBe('high');
    expect(SKILL_EXPOSITIONS['creating-draft-table']).toBe('high');
    expect(SKILL_EXPOSITIONS['creating-service-binding']).toBe('high');
    expect(SKILL_EXPOSITIONS['activating-objects']).toBe('high');
    expect(SKILL_EXPOSITIONS['enforcing-target-package']).toBe('high');
  });

  it('keeps read skills at readonly and the dump skill at system', () => {
    expect(SKILL_EXPOSITIONS['reading-persistent-table']).toBe('readonly');
    expect(SKILL_EXPOSITIONS['reading-bdef']).toBe('readonly');
    expect(SKILL_EXPOSITIONS['reading-short-dumps']).toBe('system');
  });

  it('uses only valid exposition levels', () => {
    const valid = new Set([
      'readonly',
      'search',
      'system',
      'compact',
      'high',
      'low',
    ]);
    for (const v of Object.values(SKILL_EXPOSITIONS)) {
      expect(valid.has(v)).toBe(true);
    }
  });
});
