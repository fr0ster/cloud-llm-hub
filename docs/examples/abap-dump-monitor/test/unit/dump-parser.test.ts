import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDump } from '../../srv/dump-parser';

const fix = (name: string) => readFileSync(join(__dirname, `../fixtures/${name}`), 'utf-8');

describe('parseDump (synthetic minimal fixture)', () => {
  const parsed = parseDump('E19.100', 'D-001', fix('dump-payload.sample.txt'));

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

  test('parses variable snapshots with frameNo + scope from frame header', () => {
    const v = parsed.variables.find(x => x.name === 'LO_PROVIDER');
    expect(v).toBeDefined();
    expect(v?.value).toBe('<INITIAL>');
    expect(v?.frameNo).toBe(1);
    expect(v?.scope).toBe('method');
  });

  test('preserves rawPayload', () => {
    expect(parsed.rawPayload).toBe(rawText('dump-payload.sample.txt'));
  });
});

function rawText(name: string): string { return fix(name); }

describe('parseDump (real anonymized fixtures)', () => {
  describe('STRING_LENGTH_NEGATIVE — 13 frames, hex variables with continuation lines', () => {
    const parsed = parseDump('E19.100', 'D-stringlen', fix('dump-payload.string-length.real.txt'));
    test('header', () => {
      expect(parsed.header.runtimeError).toBe('STRING_LENGTH_NEGATIVE');
      expect(parsed.header.exceptionClass).toBe('CX_SY_RANGE_OUT_OF_BOUNDS');
      expect(parsed.header.category).toBe('BC-DWB-AIE-DP');
      expect(parsed.header.abapUser).toBe('DEMOUSER1');
    });
    test('parses 13 call stack frames including bottom MODULE (PBO) row', () => {
      expect(parsed.callStack).toHaveLength(13);
      const top = parsed.callStack.find(f => f.position === 13);
      const bottom = parsed.callStack.find(f => f.position === 1);
      expect(top?.eventType).toBe('METHOD');
      expect(bottom?.eventType).toBe('MODULE (PBO)');
      expect(bottom?.program).toBe('SAPMHTTP');
    });
    test('variable count is reasonable — no continuation-line pollution', () => {
      // Without the fix, hex continuation rows were treated as variable names,
      // inflating count to 70+. Real var count is ~30 in the trimmed fixture.
      expect(parsed.variables.length).toBeGreaterThan(10);
      expect(parsed.variables.length).toBeLessThan(50);
      // None of the names should be a hex-only string (signature of pollution).
      for (const v of parsed.variables) {
        expect(v.name).not.toMatch(/^[0-9A-F]{20,}\\?$/);
      }
    });
    test('frameNo + scope populated from frame separator', () => {
      const v = parsed.variables.find(x => x.name === 'LS_TOKEN-STR');
      expect(v?.frameNo).toBe(13);
      expect(v?.scope).toBe('method');
    });
    test('drops ABAP runtime-internal helpers (%_PRINT, <%_*>) from variables', () => {
      for (const v of parsed.variables) {
        expect(v.name).not.toMatch(/^%_/);
        expect(v.name).not.toMatch(/^<%_/);
      }
    });
    test('value is collapsed to printable first row, hex/char rows dropped', () => {
      // Pick any variable whose raw representation had multi-line hex output
      // (LS_TOKEN-TYPE was a 1-byte char with hex follow-up rows). Value
      // must be a single line and truncated=true marks the dropped rows.
      const v = parsed.variables.find(x => x.name === 'LS_TOKEN-TYPE');
      expect(v).toBeDefined();
      expect(v?.value).not.toContain('\n');
      expect(v?.truncated).toBe(true);
    });
  });

  describe('DATREF_NOT_ASSIGNED — workflow user, 18 frames', () => {
    const parsed = parseDump('E19.100', 'D-nullref', fix('dump-payload.null-ref.real.txt'));
    test('header', () => {
      expect(parsed.header.runtimeError).toBe('DATREF_NOT_ASSIGNED');
      expect(parsed.header.abapUser).toBe('SAP_WFRT');
      expect(parsed.header.category).toBe('CA-MDG-PF-BP');
    });
    test('parses 18 frames', () => {
      expect(parsed.callStack).toHaveLength(18);
    });
  });

  describe('COMPUTE_INT_PLUS_OVERFLOW — DDIC, 3 frames', () => {
    const parsed = parseDump('E19.100', 'D-intover', fix('dump-payload.int-overflow.real.txt'));
    test('header', () => {
      expect(parsed.header.runtimeError).toBe('COMPUTE_INT_PLUS_OVERFLOW');
      expect(parsed.header.exceptionClass).toBe('CX_SY_ARITHMETIC_OVERFLOW');
      expect(parsed.header.abapUser).toBe('DDIC');
      expect(parsed.header.client).toBe('000');
    });
    test('parses 3 frames with namespace-prefixed program', () => {
      expect(parsed.callStack).toHaveLength(3);
      expect(parsed.callStack[0]).toMatchObject({
        position: 3,
        eventType: 'METHOD',
        program: '/IWFND/CL_METERING_DB=========CP'
      });
    });
  });
});
