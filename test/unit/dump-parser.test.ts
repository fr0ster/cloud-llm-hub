import fs from 'node:fs';
import path from 'node:path';
import {
  dumpSectionIndex,
  getDumpSection,
  MAJOR_TITLES,
  parseDump,
} from '../../srv/lib/dump-parser';

const payload = fs.readFileSync(
  path.join(__dirname, 'fixtures/zdemo01-dump.formatted.txt'),
  'utf8',
);

describe('dump-parser (lifted)', () => {
  it('parses the header', () => {
    const d = parseDump('DEV', 'x', payload);
    expect(d.header.runtimeError).toBe('RAISE_SHORTDUMP');
    expect(d.header.exceptionClass).toBe('CX_SADL_DUMP_APPL_MODEL_ERROR');
  });

  it('index lists present chapters, all canonical', () => {
    const idx = dumpSectionIndex(payload);
    expect(idx).toContain('Error analysis');
    for (const t of idx) expect(MAJOR_TITLES.has(t)).toBe(true);
  });

  it('getDumpSection returns one de-padded chapter or null', () => {
    const ea = getDumpSection(payload, 'Error analysis');
    if (!ea) throw new Error('expected Error analysis section');
    expect(ea).toContain('CX_RAP_HANDLER_NOT_IMPLEMENTED');
    for (const line of ea.split('\n')) expect(line).not.toMatch(/\s{4,}$/);
    expect(getDumpSection(payload, 'No Such Chapter')).toBeNull();
    expect(ea.length).toBeLessThan(payload.length / 4);
  });
});
