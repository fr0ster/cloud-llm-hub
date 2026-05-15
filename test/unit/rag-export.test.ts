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
