import fs from 'node:fs';
import path from 'node:path';

const SRC = {
  'rap-skills': 'docs/tutorials/rap-bo-book-catalog/skills',
  'rap-context': 'docs/tutorials/rap-bo-book-catalog/context',
};
const PRESETS = 'srv/presets';

function mdFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();
}

describe('preset content matches tutorial sources (no drift)', () => {
  for (const [pack, srcDir] of Object.entries(SRC)) {
    test(`${pack} files and bytes match`, () => {
      const presetDir = path.join(PRESETS, pack);
      expect(mdFiles(presetDir)).toEqual(mdFiles(srcDir));
      for (const f of mdFiles(srcDir)) {
        expect(fs.readFileSync(path.join(presetDir, f), 'utf8')).toBe(
          fs.readFileSync(path.join(srcDir, f), 'utf8'),
        );
      }
    });
  }
});
