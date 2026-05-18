// test/unit/rag-export.test.ts
//
// Unit tests for the browser-side RAG export reassembly helpers.
// The module is plain JS (UMD), required directly — Jest does not
// need to transpile it.
//
const RagExport = require('../../app/chat/webapp/rag-export.js');

describe('rag-export module', () => {
  it('exports the four helpers', () => {
    expect(typeof RagExport.groupChunksBySource).toBe('function');
    expect(typeof RagExport.safeSourceExportName).toBe('function');
    expect(typeof RagExport.reassembleSource).toBe('function');
    expect(typeof RagExport.groupKey).toBe('function');
  });
});

describe('groupKey', () => {
  it('returns null for orphan metadata', () => {
    expect(RagExport.groupKey({})).toBeNull();
    expect(RagExport.groupKey(null as any)).toBeNull();
    expect(RagExport.groupKey({ chunkIndex: 0 })).toBeNull();
  });

  it('encodes (source, uploadId) as JSON', () => {
    expect(RagExport.groupKey({ source: 'a.md', uploadId: 'u1' })).toBe(
      JSON.stringify(['a.md', 'u1']),
    );
  });

  it('falls back to _legacy when uploadId is missing', () => {
    expect(RagExport.groupKey({ source: 'a.md' })).toBe(
      JSON.stringify(['a.md', '_legacy']),
    );
  });

  it('keeps the source string verbatim — | in name is safe', () => {
    const key = RagExport.groupKey({ source: 'weird|name.md', uploadId: 'u1' });
    expect(key).toBe(JSON.stringify(['weird|name.md', 'u1']));
    // Different source with the same combined string under a different
    // split must produce a different key.
    const other = RagExport.groupKey({
      source: 'weird',
      uploadId: 'name.md|u1',
    });
    expect(other).not.toBe(key);
  });
});

describe('groupChunksBySource', () => {
  function makeDoc(
    id: string,
    source: string,
    chunkIndex: number,
    totalChunks: number,
    extra: { uploadId?: string; text?: string } = {},
  ) {
    return {
      id,
      text: extra.text ?? 'x',
      metadata: {
        source,
        chunkIndex,
        totalChunks,
        ...(extra.uploadId ? { uploadId: extra.uploadId } : {}),
      },
    };
  }

  it('groups chunks of one upload into one entry', () => {
    const docs = [
      makeDoc('a-0', 'a.md', 0, 2, { uploadId: 'u1' }),
      makeDoc('a-1', 'a.md', 1, 2, { uploadId: 'u1' }),
    ];
    const { groups, orphans } = RagExport.groupChunksBySource(docs);
    expect(orphans).toEqual([]);
    expect(groups.size).toBe(1);
    const entry = groups.get(JSON.stringify(['a.md', 'u1']));
    expect(entry).toBeDefined();
    expect(entry!.source).toBe('a.md');
    expect(entry!.uploadId).toBe('u1');
    expect(entry!.docs.map((d: any) => d.id)).toEqual(['a-0', 'a-1']);
    expect(entry!.warnings).toEqual([]);
  });

  it('groups two uploads of the same source into separate entries', () => {
    const docs = [
      makeDoc('a-u1-0', 'a.md', 0, 2, { uploadId: 'u1' }),
      makeDoc('a-u1-1', 'a.md', 1, 2, { uploadId: 'u1' }),
      makeDoc('a-u2-0', 'a.md', 0, 2, { uploadId: 'u2' }),
      makeDoc('a-u2-1', 'a.md', 1, 2, { uploadId: 'u2' }),
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    expect(groups.size).toBe(2);
    expect(groups.get(JSON.stringify(['a.md', 'u1']))!.docs.length).toBe(2);
    expect(groups.get(JSON.stringify(['a.md', 'u2']))!.docs.length).toBe(2);
  });

  it('legacy entries (no uploadId) fall under _legacy group', () => {
    const docs = [
      makeDoc('a-0', 'a.md', 0, 2), // no uploadId
      makeDoc('a-1', 'a.md', 1, 2), // no uploadId
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    expect(groups.size).toBe(1);
    const entry = groups.get(JSON.stringify(['a.md', '_legacy']));
    expect(entry).toBeDefined();
    expect(entry!.uploadId).toBe('_legacy');
    expect(entry!.docs.length).toBe(2);
  });

  it('mixes uploadId-stamped and legacy in separate entries', () => {
    const docs = [
      makeDoc('legacy-0', 'a.md', 0, 1),
      makeDoc('u1-0', 'a.md', 0, 1, { uploadId: 'u1' }),
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    expect(groups.size).toBe(2);
    expect(groups.get(JSON.stringify(['a.md', '_legacy']))).toBeDefined();
    expect(groups.get(JSON.stringify(['a.md', 'u1']))).toBeDefined();
  });

  it('docs without metadata.source go to orphans', () => {
    const docs = [
      { id: 'standalone', text: 'x', metadata: {} },
      makeDoc('a-0', 'a.md', 0, 1, { uploadId: 'u1' }),
    ];
    const { groups, orphans } = RagExport.groupChunksBySource(docs);
    expect(groups.size).toBe(1);
    expect(orphans.map((d: any) => d.id)).toEqual(['standalone']);
  });

  it('docs with non-integer chunkIndex go to orphans', () => {
    const docs = [
      { id: 'bad', text: 'x', metadata: { source: 'a.md', chunkIndex: 'foo' } },
      makeDoc('a-0', 'a.md', 0, 1, { uploadId: 'u1' }),
    ];
    const { groups, orphans } = RagExport.groupChunksBySource(docs as any);
    expect(groups.size).toBe(1);
    expect(orphans.map((d: any) => d.id)).toEqual(['bad']);
  });

  it('sorts docs within a group by chunkIndex', () => {
    const docs = [
      makeDoc('a-2', 'a.md', 2, 3, { uploadId: 'u1' }),
      makeDoc('a-0', 'a.md', 0, 3, { uploadId: 'u1' }),
      makeDoc('a-1', 'a.md', 1, 3, { uploadId: 'u1' }),
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    const entry = groups.get(JSON.stringify(['a.md', 'u1']));
    expect(entry!.docs.map((d: any) => d.id)).toEqual(['a-0', 'a-1', 'a-2']);
  });

  it('collects per-source warnings into the entry.warnings field', () => {
    const docs = [
      makeDoc('a-0', 'a.md', 0, 3, { uploadId: 'u1' }),
      makeDoc('a-2', 'a.md', 2, 3, { uploadId: 'u1' }), // gap at 1
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    const entry = groups.get(JSON.stringify(['a.md', 'u1']));
    expect(entry!.warnings.length).toBeGreaterThan(0);
  });

  it('keeps duplicate chunkIndex and inconsistent totalChunks warnings', () => {
    const docs = [
      makeDoc('a-0', 'a.md', 0, 2, { uploadId: 'u1' }),
      makeDoc('a-0b', 'a.md', 0, 3, { uploadId: 'u1' }),
    ];
    const { groups } = RagExport.groupChunksBySource(docs);
    const entry = groups.get(JSON.stringify(['a.md', 'u1']));
    expect(
      entry!.warnings.some((w: string) => /duplicate chunk index 0/.test(w)),
    ).toBe(true);
    expect(
      entry!.warnings.some((w: string) => /inconsistent totalChunks/.test(w)),
    ).toBe(true);
  });
});

describe('safeSourceExportName', () => {
  it('passes through a clean filename', () => {
    const out = RagExport.safeSourceExportName('rap-bo-creation.md', new Set());
    expect(out).toBe('rap-bo-creation.md');
  });

  it('strips directory components and parent-dir traversal', () => {
    expect(RagExport.safeSourceExportName('foo/bar.md', new Set())).toBe(
      'bar.md',
    );
    expect(RagExport.safeSourceExportName('../../etc/passwd', new Set())).toBe(
      'passwd',
    );
    expect(RagExport.safeSourceExportName('a\\b\\c.md', new Set())).toBe(
      'c.md',
    );
  });

  it('replaces unsafe characters with underscore', () => {
    expect(RagExport.safeSourceExportName('foo bar (1).md', new Set())).toBe(
      'foo_bar__1_.md',
    );
  });

  it('preserves the original extension', () => {
    expect(RagExport.safeSourceExportName('data.json', new Set())).toBe(
      'data.json',
    );
    expect(RagExport.safeSourceExportName('schema.xml', new Set())).toBe(
      'schema.xml',
    );
    expect(RagExport.safeSourceExportName('report.csv', new Set())).toBe(
      'report.csv',
    );
    expect(RagExport.safeSourceExportName('zcl_foo.abap', new Set())).toBe(
      'zcl_foo.abap',
    );
    expect(RagExport.safeSourceExportName('README.markdown', new Set())).toBe(
      'README.markdown',
    );
    expect(RagExport.safeSourceExportName('app.properties', new Set())).toBe(
      'app.properties',
    );
  });

  it('disambiguates collisions before the extension', () => {
    const used = new Set<string>();
    expect(RagExport.safeSourceExportName('a.md', used)).toBe('a.md');
    expect(RagExport.safeSourceExportName('a.md', used)).toBe('a-1.md');
    expect(RagExport.safeSourceExportName('a.md', used)).toBe('a-2.md');
  });

  it('falls back to source.txt when sanitization empties the name', () => {
    expect(RagExport.safeSourceExportName('', new Set())).toBe('source.txt');
    expect(RagExport.safeSourceExportName('/', new Set())).toBe('source.txt');
    expect(RagExport.safeSourceExportName('..', new Set())).toBe('source.txt');
  });

  it('truncates an overly long basename', () => {
    const longName = `${'x'.repeat(500)}.md`;
    const out = RagExport.safeSourceExportName(longName, new Set());
    expect(out.length).toBeLessThanOrEqual(123); // 120 basename cap + '.md'
    expect(out.endsWith('.md')).toBe(true);
  });
});

describe('reassembleSource', () => {
  function chunk(
    id: string,
    source: string,
    idx: number,
    total: number,
    text: string,
    extra: any = {},
  ) {
    return {
      id,
      text,
      createdAt: extra.createdAt,
      metadata: {
        source,
        chunkIndex: idx,
        totalChunks: total,
        description: extra.description,
      },
    };
  }

  it('joins chunk text with \\n\\n in chunkIndex order', () => {
    const group = [
      chunk('a-0', 'a.md', 0, 3, 'Hello'),
      chunk('a-1', 'a.md', 1, 3, 'World'),
      chunk('a-2', 'a.md', 2, 3, 'Bye'),
    ];
    const { name, body } = RagExport.reassembleSource(
      group,
      'a.md',
      undefined,
      [],
    );
    expect(name).toBe('a.md');
    expect(body).toBe('Hello\n\nWorld\n\nBye');
  });

  it('produces a sidecar with provenance for md sources', () => {
    const group = [
      chunk('a-0', 'a.md', 0, 2, 'X', {
        createdAt: '2026-05-15T10:00:00Z',
        description: 'desc',
      }),
      chunk('a-1', 'a.md', 1, 2, 'Y', {
        createdAt: '2026-05-15T10:00:01Z',
        description: 'desc',
      }),
    ];
    const { sidecar } = RagExport.reassembleSource(
      group,
      'a.md',
      undefined,
      [],
    );
    expect(sidecar.name).toBe('a.md.meta.json');
    const parsed = JSON.parse(sidecar.body);
    expect(parsed.source).toBe('a.md');
    expect(parsed.exportName).toBe('a.md');
    expect(parsed.description).toBe('desc');
    expect(parsed.totalChunks).toBe(2);
    expect(parsed.reassembledFrom).toEqual(['a-0', 'a-1']);
    expect(parsed.createdAt).toBe('2026-05-15T10:00:00Z');
    expect(parsed.warnings).toEqual([]);
  });

  it('passes per-source warnings through to the sidecar', () => {
    const group = [chunk('a-0', 'a.md', 0, 2, 'X')];
    const warnings = ['⚠ a.md: expected 2 chunks, found 1'];
    const { sidecar } = RagExport.reassembleSource(
      group,
      'a.md',
      undefined,
      warnings,
    );
    const parsed = JSON.parse(sidecar.body);
    expect(parsed.warnings).toEqual(warnings);
  });

  it('omits description from the sidecar when absent', () => {
    const group = [chunk('a-0', 'a.md', 0, 1, 'X')];
    const { sidecar } = RagExport.reassembleSource(
      group,
      'a.md',
      undefined,
      [],
    );
    const parsed = JSON.parse(sidecar.body);
    expect('description' in parsed).toBe(false);
  });

  it('preserves the safeName extension for txt and other formats', () => {
    const group = [chunk('a-0', 'a.txt', 0, 1, 'X')];
    const out = RagExport.reassembleSource(group, 'a.txt', undefined, []);
    expect(out.name).toBe('a.txt');
    expect(out.sidecar.name).toBe('a.txt.meta.json');
  });

  it('throws on an empty group', () => {
    expect(() =>
      RagExport.reassembleSource([], 'a.md', undefined, []),
    ).toThrow();
  });

  it('writes uploadId into the sidecar when provided', () => {
    const group = [
      {
        id: 'a-0',
        text: 'x',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
        createdAt: '2026-05-18T10:00:00Z',
      },
    ];
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', 'u1', []);
    const parsed = JSON.parse(sidecar.body);
    expect(parsed.uploadId).toBe('u1');
  });

  it('omits uploadId from the sidecar for legacy groups', () => {
    const group = [
      {
        id: 'a-0',
        text: 'x',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
        createdAt: '2026-05-18T10:00:00Z',
      },
    ];
    const { sidecar } = RagExport.reassembleSource(
      group,
      'a.md',
      undefined,
      [],
    );
    const parsed = JSON.parse(sidecar.body);
    expect('uploadId' in parsed).toBe(false);
  });
});
