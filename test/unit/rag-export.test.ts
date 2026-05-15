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
