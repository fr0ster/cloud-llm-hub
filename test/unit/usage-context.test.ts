import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  aggregate,
  formatCalls,
  formatSummary,
  isValidSince,
  loadRecords,
  main,
  parseRecords,
  percentile,
  type UsageRow,
} from '../../tools/usage-context';

function row(
  record: object,
  role: string | null = null,
  session = 'session-a',
): UsageRow {
  return {
    at: Date.parse('2026-10-27T10:00:00Z'),
    kind: 'llm.call',
    session_id: session,
    role,
    record_json: JSON.stringify(record),
  };
}

describe('usage context analysis', () => {
  it.each([
    '2026-10-27',
    '2024-02-29',
    '2000-02-29',
    '0000-02-29',
    '2026-10-27T10:30Z',
    '2026-10-27T10:30:45Z',
    '2026-10-27T10:30:45.123+04:00',
    '2026-10-27T10:30:00.1Z',
    '2026-10-27T10:30:00.12+02:00',
    '2026-10-27T10:30:00.123456789Z',
    '2026-10-27T10:30-05:30',
  ])('accepts ISO date %s', (value: string) => {
    expect(isValidSince(value)).toBe(true);
  });

  it.each([
    '123',
    '10/27/2026',
    '2026-02-30',
    '2026-02-29',
    '1900-02-29',
    '2026-00-01',
    '2026-13-01',
    '2026-10-00',
    '2026-04-31',
    '2026-10-27T24:00Z',
    '2026-10-27T10:60Z',
    '2026-10-27T10:30:60Z',
    '2026-10-27T10:30',
    '2026-10-27T10:30:00.Z',
    '2026-10-27T10:30:00.1234567890Z',
    '2026-10-27T10:30+24:00',
    '2026-10-27T10:30+04:60',
    ' 2026-10-27',
    '2026-10-27extra',
    '',
  ])('rejects invalid date %s before opening SQLite', (value: string) => {
    expect(isValidSince(value)).toBe(false);
    expect(() => main(['missing.sqlite', '--since', value])).toThrow(
      value ? 'Invalid --since ISO date' : 'Missing value for --since',
    );
    expect(() => loadRecords('missing.sqlite', { since: value })).toThrow(
      'Invalid --since ISO date',
    );
  });

  it('filters epoch milliseconds before counting malformed columns or JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'usage-context-'));
    const file = join(directory, 'usage.sqlite');
    try {
      const db = new DatabaseSync(file);
      try {
        db.exec(
          'CREATE TABLE USAGE_RECORDS (id INTEGER PRIMARY KEY, at INTEGER, kind TEXT, session_id TEXT, role, record_json)',
        );
        const insert = db.prepare(
          'INSERT INTO USAGE_RECORDS (at, kind, session_id, role, record_json) VALUES (?, ?, ?, ?, ?)',
        );
        const at = Date.parse('2026-10-27T00:00:00Z');
        insert.run(at, 'llm.call', 'session-a', null, '{"inputTokens":100}');
        insert.run(
          at + 100,
          'llm.call',
          'session-a',
          null,
          '{"inputTokens":200}',
        );
        insert.run(at, 'llm.call', 'session-a', 42, '{}');
        insert.run(at - 1, 'llm.call', 'session-a', 42, '{');
        insert.run(at, 'llm.call', 'other', 42, '{');
        insert.run(at - 1, 'llm.call', 'session-a', null, '{');
        insert.run(at, 'llm.call', 'other', null, '{');
      } finally {
        db.close();
      }
      const summary = aggregate(
        loadRecords(file, { session: 'session-', since: '2026-10-27' }),
      );
      expect(summary.malformedRows).toBe(1);
      expect(summary.total.calls).toBe(2);
      expect(summary.total.inputTokens.sum).toBe(300);
      const fractionalSummary = aggregate(
        loadRecords(file, {
          session: 'session-',
          since: '2026-10-27T00:00:00.1Z',
        }),
      );
      expect(fractionalSummary.malformedRows).toBe(0);
      expect(fractionalSummary.total.calls).toBe(1);
      expect(fractionalSummary.total.inputTokens.sum).toBe(200);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('filters literal case-sensitive session prefixes at the integer cutoff boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'usage-context-'));
    const file = join(directory, 'usage.sqlite');
    const prefix = "Session%_\\'";
    try {
      const db = new DatabaseSync(file);
      try {
        db.exec(
          'CREATE TABLE USAGE_RECORDS (id INTEGER PRIMARY KEY, at INTEGER, kind TEXT, session_id TEXT, role, record_json)',
        );
        const insert = db.prepare(
          "INSERT INTO USAGE_RECORDS (at, kind, session_id, role, record_json) VALUES (?, 'llm.call', ?, NULL, ?)",
        );
        const cutoff = Date.parse('2026-10-27T00:00:00.100Z');
        for (const at of [cutoff, cutoff + 1])
          insert.run(at, `${prefix}suffix`, '{}');
        insert.run(cutoff - 1, `${prefix}suffix`, '{');
        for (const session of [
          "SessionXX\\'suffix",
          "Session%X\\'suffix",
          "Session%_'suffix",
          `${prefix.toLowerCase()}suffix`,
        ])
          insert.run(cutoff, session, '{');
        insert.run('2026-10-27T00:00:00.100Z', prefix, '{}');
        insert.run(cutoff + 0.5, prefix, '{}');
        insert.run(null, prefix, '{}');
        insert.run(cutoff, prefix, '{');
      } finally {
        db.close();
      }
      const parsed = loadRecords(file, {
        session: prefix,
        since: '2026-10-27T00:00:00.100Z',
      });
      expect(parsed.records.map((record) => record.at)).toEqual([
        '2026-10-27T00:00:00.100Z',
        '2026-10-27T00:00:00.101Z',
      ]);
      expect(parsed.malformedRows).toBe(4);
      expect(loadRecords(file, { session: prefix }).malformedRows).toBe(5);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('formats 130000 calls and summary rows without exceeding argument limits', () => {
    const parsed = parseRecords([row({ inputTokens: 1 })]);
    const summary = aggregate(parsed);
    const count = 130000;
    expect(() =>
      formatCalls(Array.from({ length: count }, () => parsed.records[0])),
    ).not.toThrow();
    expect(() =>
      formatSummary({
        ...summary,
        groups: Array.from({ length: count }, () => summary.groups[0]),
        retrieval: Array.from({ length: count }, () => summary.retrieval[0]),
      }),
    ).not.toThrow();
  });

  it('uses nearest-rank percentiles without mutating input and handles empty sets', () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, 0.5)).toBe(20);
    expect(percentile(values, 0.95)).toBe(40);
    expect(percentile([], 0.95)).toBe(0);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it('aggregates token and size distributions and proportional part estimates', () => {
    const parsed = parseRecords([
      row({
        model: 'model',
        inputTokens: 100,
        outputTokens: 5,
        systemChars: 1024,
        userChars: 1024,
        context: { component: 'loop' },
      }),
      row({
        model: 'model',
        inputTokens: 300,
        outputTokens: 7,
        inputChars: 2048,
        toolChars: 2048,
        toolDefsChars: 2048,
        context: { component: 'loop' },
      }),
    ]);
    const summary = aggregate(parsed);
    expect(summary.groups).toHaveLength(1);
    expect(summary.total.inputTokens).toEqual({
      avg: 200,
      p50: 100,
      p95: 300,
      max: 300,
      sum: 400,
    });
    expect(summary.total.messageKB).toEqual({
      avg: 2,
      p50: 2,
      p95: 2,
      max: 2,
      sum: 4,
    });
    expect(summary.total.outputTokens).toBe(12);
    expect(summary.total.averagePartKB).toEqual({
      system: 0.5,
      user: 0.5,
      assistant: 0,
      toolResults: 1,
      toolDefinitions: 1,
    });
    expect(summary.total.averageEstimatedPartTokens).toEqual({
      system: 25,
      user: 25,
      assistant: 0,
      toolResults: 75,
      toolDefinitions: 75,
    });
  });

  it('counts producer message characters separately from tool definitions', () => {
    const producer = {
      systemChars: 1024,
      userChars: 2048,
      assistantChars: 3072,
      toolChars: 4096,
      inputChars: 10240,
      toolDefsChars: 5120,
    };
    const parsed = parseRecords([
      row(producer),
      row({ ...producer, inputChars: undefined }),
    ]);
    const summary = aggregate(parsed);
    expect(summary.total.messageKB).toEqual({
      sum: 20,
      avg: 10,
      p50: 10,
      p95: 10,
      max: 10,
    });
    expect(summary.total.contextKB).toEqual({
      sum: 30,
      avg: 15,
      p50: 15,
      p95: 15,
      max: 15,
    });
    expect(formatSummary(summary)).toContain('Msg KB');
    expect(formatSummary(summary)).toContain('Ctx KB');
    expect(formatCalls(parsed.records)).toContain('Msg KB');
    expect(formatCalls(parsed.records)).toContain('Ctx KB');
  });

  it.each([
    {
      args: ['missing.sqlite', '--session'],
      error: 'Missing value for --session',
    },
    {
      args: ['missing.sqlite', '--session', '--json'],
      error: 'Missing value for --session',
    },
    {
      args: ['missing.sqlite', '--unexpected'],
      error: 'Unexpected argument: --unexpected',
    },
    { args: [], error: 'Usage:' },
    { args: ['--json'], error: 'Usage:' },
  ])(
    'rejects CLI arguments $args without output',
    ({ args, error }: { args: string[]; error: string }) => {
      const output = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(() => main(args)).toThrow(error);
        expect(output).not.toHaveBeenCalled();
      } finally {
        output.mockRestore();
      }
    },
  );

  it('uses column role before context role before the missing-role label', () => {
    const parsed = parseRecords([
      row({ context: { role: 'context' } }, 'column'),
      row({ context: { role: 'context' } }),
      row({}),
    ]);
    expect(parsed.records.map((record) => record.role)).toEqual([
      'column',
      'context',
      '(none)',
    ]);
    expect(aggregate(parsed).groups).toHaveLength(3);
    expect(aggregate(parsed).total.averageEstimatedPartTokens.system).toBe(0);
  });

  it('skips and counts malformed JSON and non-object records', () => {
    const valid = row({ inputTokens: 12 });
    const parsed = parseRecords([
      valid,
      { ...valid, record_json: '{' },
      { ...valid, record_json: 'null' },
      { ...valid, record_json: '[]' },
    ]);
    expect(parsed.malformedRows).toBe(3);
    expect(aggregate(parsed).total.calls).toBe(1);
  });

  it('loads a real SQLite file read-only, filters sessions and dates, and summarizes retrieval', () => {
    const directory = mkdtempSync(join(tmpdir(), 'usage-context-'));
    const file = join(directory, 'usage.sqlite');
    try {
      const db = new DatabaseSync(file);
      try {
        db.exec(
          'CREATE TABLE USAGE_RECORDS (id INTEGER PRIMARY KEY, at INTEGER, kind TEXT, session_id TEXT, role TEXT, record_json TEXT)',
        );
        const insert = db.prepare(
          'INSERT INTO USAGE_RECORDS (at, kind, session_id, role, record_json) VALUES (?, ?, ?, ?, ?)',
        );
        const rows = [
          row({
            inputTokens: 100,
            model: 'm',
            inputChars: 1024,
            toolDefsChars: 2048,
            context: { requestId: 'request-a', turnId: 'turn-a' },
          }),
          row({ inputTokens: 900 }, null, 'other'),
          {
            ...row({ inputTokens: 50 }),
            at: Date.parse('2026-10-01T00:00:00Z'),
          },
          { ...row({}), record_json: '{' },
          {
            ...row({ values: { injected: true, chunks: 4, chars: 2048 } }),
            kind: 'x.hub.retrieval',
          },
          {
            ...row({ values: { injected: false, chunks: 99, chars: 99999 } }),
            kind: 'x.hub.retrieval',
          },
        ];
        for (const record of rows)
          insert.run(
            record.at,
            record.kind,
            record.session_id,
            record.role,
            record.record_json,
          );
      } finally {
        db.close();
      }
      const summary = aggregate(
        loadRecords(file, {
          session: 'session-',
          since: '2026-10-27T00:00:00Z',
        }),
      );
      expect(summary.total.calls).toBe(1);
      expect(summary.total.inputTokens.sum).toBe(100);
      expect(summary.malformedRows).toBe(1);
      expect(summary.retrieval).toEqual([
        {
          session: 'session-a',
          injections: 1,
          avgChunks: 4,
          avgKB: 2,
          maxKB: 2,
        },
      ]);
      expect(aggregate(loadRecords(file)).total.calls).toBe(3);
      const output: string[] = [];
      const log = jest
        .spyOn(console, 'log')
        .mockImplementation((value: string) => {
          output.push(value);
        });
      try {
        main([
          file,
          '--session',
          'session-',
          '--since',
          '2026-10-27',
          '--calls',
          '--json',
        ]);
        expect(output).toHaveLength(1);
        const result: object = JSON.parse(output[0]);
        expect(result).toEqual({
          summary,
          calls: [
            {
              sessionId: 'session-a',
              requestId: 'request-a',
              turnId: 'turn-a',
              records: [
                expect.objectContaining({
                  inputTokens: 100,
                  model: 'm',
                  messageKB: 1,
                  contextKB: 3,
                }),
              ],
            },
          ],
        });
      } finally {
        log.mockRestore();
      }
      expect(() => main([join(directory, 'missing.sqlite')])).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
