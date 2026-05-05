import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDump } from '../../srv/dump-parser';

const PAYLOAD = readFileSync(join(__dirname, '../fixtures/dump-payload.sample.txt'), 'utf-8');

describe('parseDump', () => {
  const parsed = parseDump('E19.100', 'D-001', PAYLOAD);

  test('extracts header runtime error', () => {
    expect(parsed.header.runtimeError).toBe('OBJECTS_OBJREF_NOT_ASSIGNED');
    expect(parsed.header.exceptionClass).toBe('CX_SY_REF_IS_INITIAL');
  });

  test('extracts program/include/line', () => {
    expect(parsed.header.program).toBe('ZCL_DEMO==========================CP');
    expect(parsed.header.include).toBe('ZCL_DEMO==========================CM001');
    expect(parsed.header.sourceLine).toBe(42);
  });

  test('extracts Application Component into header.category (preferred over Category)', () => {
    expect(parsed.header.category).toBe('BC-ABA-LA');
  });

  test('extracts user and client', () => {
    expect(parsed.header.abapUser).toBe('DEVELOPER1');
    expect(parsed.header.client).toBe('100');
  });

  test('parses 3-frame call stack', () => {
    expect(parsed.callStack).toHaveLength(3);
    expect(parsed.callStack[0]).toMatchObject({ position: 1, eventType: 'METHOD', line: 42 });
  });

  test('extracts source code with marker', () => {
    expect(parsed.sourceExtract?.code).toContain('lo_provider->fetch');
    expect(parsed.sourceExtract?.lineFrom).toBe(40);
    expect(parsed.sourceExtract?.lineTo).toBe(43);
  });

  test('parses variable snapshots', () => {
    const local = parsed.variables.find(v => v.scope === 'local' && v.name === 'LO_PROVIDER');
    expect(local).toBeDefined();
    expect(local?.value).toBe('<INITIAL>');
  });

  test('deduplicated referenced objects include programs from stack', () => {
    const names = parsed.referencedObjects.map(o => o.objectName);
    expect(names).toContain('ZCL_DEMO==========================CP');
    expect(names).toContain('ZREPORT_MAIN');
  });

  test('preserves rawPayload', () => {
    expect(parsed.rawPayload).toBe(PAYLOAD);
  });
});
