// test/unit/rag-export.test.ts
//
// Unit tests for the browser-side RAG export reassembly helpers.
// The module is plain JS (UMD), required directly — Jest does not
// need to transpile it.
//
const RagExport = require('../../app/chat/webapp/rag-export.js');

describe('rag-export module', () => {
  it('exports the three helpers', () => {
    expect(typeof RagExport.groupChunksBySource).toBe('function');
    expect(typeof RagExport.safeSourceExportName).toBe('function');
    expect(typeof RagExport.reassembleSource).toBe('function');
  });
});

describe('groupChunksBySource', () => {
  it('groups chunks by source and sorts by chunkIndex', () => {
    const docs = [
      {
        id: 'a-2',
        text: 'C',
        metadata: { source: 'a.md', chunkIndex: 2, totalChunks: 3 },
      },
      {
        id: 'a-0',
        text: 'A',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 3 },
      },
      {
        id: 'a-1',
        text: 'B',
        metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 3 },
      },
    ];
    const { groups, orphans, warningsBySource } =
      RagExport.groupChunksBySource(docs);
    const a = groups.get('a.md');
    expect(a.map((d: any) => d.id)).toEqual(['a-0', 'a-1', 'a-2']);
    expect(orphans).toEqual([]);
    expect(warningsBySource.size).toBe(0);
  });

  it('sends rag_add-style records to orphans', () => {
    const docs = [
      { id: 'standalone', text: 'X', metadata: {} },
      {
        id: 'a-0',
        text: 'A',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
      },
    ];
    const { groups, orphans } = RagExport.groupChunksBySource(docs);
    expect(groups.get('a.md')?.length).toBe(1);
    expect(orphans.map((d: any) => d.id)).toEqual(['standalone']);
  });

  it('sends docs with non-integer chunkIndex to orphans', () => {
    const docs = [
      { id: 'bad', text: 'X', metadata: { source: 'a.md', chunkIndex: 'foo' } },
    ];
    const { orphans } = RagExport.groupChunksBySource(docs as any);
    expect(orphans.map((d: any) => d.id)).toEqual(['bad']);
  });

  it('warns on missing chunk indices (gap)', () => {
    const docs = [
      {
        id: 'a-0',
        text: 'A',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 4 },
      },
      {
        id: 'a-1',
        text: 'B',
        metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 4 },
      },
      {
        id: 'a-3',
        text: 'D',
        metadata: { source: 'a.md', chunkIndex: 3, totalChunks: 4 },
      },
    ];
    const { warningsBySource } = RagExport.groupChunksBySource(docs);
    const ws = warningsBySource.get('a.md');
    expect(ws.some((w: string) => /missing.*2/.test(w))).toBe(true);
  });

  it('warns on inconsistent totalChunks within a group', () => {
    const docs = [
      {
        id: 'a-0',
        text: 'A',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 3 },
      },
      {
        id: 'a-1',
        text: 'B',
        metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 4 },
      },
    ];
    const { warningsBySource } = RagExport.groupChunksBySource(docs);
    const ws = warningsBySource.get('a.md');
    expect(ws.some((w: string) => /inconsistent totalChunks/.test(w))).toBe(
      true,
    );
  });

  it('warns on duplicate chunkIndex', () => {
    const docs = [
      {
        id: 'a-0',
        text: 'A',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 2 },
      },
      {
        id: 'a-0b',
        text: 'A2',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 2 },
      },
      {
        id: 'a-1',
        text: 'B',
        metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 2 },
      },
    ];
    const { warningsBySource } = RagExport.groupChunksBySource(docs);
    const ws = warningsBySource.get('a.md');
    expect(ws.some((w: string) => /duplicate chunk index 0/.test(w))).toBe(
      true,
    );
  });

  it('warns when group length differs from consistent totalChunks', () => {
    const docs = [
      {
        id: 'a-0',
        text: 'A',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 5 },
      },
      {
        id: 'a-1',
        text: 'B',
        metadata: { source: 'a.md', chunkIndex: 1, totalChunks: 5 },
      },
    ];
    const { warningsBySource } = RagExport.groupChunksBySource(docs);
    const ws = warningsBySource.get('a.md');
    expect(ws.some((w: string) => /expected 5 chunks, found 2/.test(w))).toBe(
      true,
    );
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
    const { name, body } = RagExport.reassembleSource(group, 'a.md', []);
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
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', []);
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
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', warnings);
    const parsed = JSON.parse(sidecar.body);
    expect(parsed.warnings).toEqual(warnings);
  });

  it('omits description from the sidecar when absent', () => {
    const group = [chunk('a-0', 'a.md', 0, 1, 'X')];
    const { sidecar } = RagExport.reassembleSource(group, 'a.md', []);
    const parsed = JSON.parse(sidecar.body);
    expect('description' in parsed).toBe(false);
  });

  it('preserves the safeName extension for txt and other formats', () => {
    const group = [chunk('a-0', 'a.txt', 0, 1, 'X')];
    const out = RagExport.reassembleSource(group, 'a.txt', []);
    expect(out.name).toBe('a.txt');
    expect(out.sidecar.name).toBe('a.txt.meta.json');
  });

  it('throws on an empty group', () => {
    expect(() => RagExport.reassembleSource([], 'a.md', [])).toThrow();
  });
});
