// app/chat/webapp/rag-export.js
//
// Pure helpers for the RAG collection export reassembly path.
// No DOM, no JSZip, no fetch — safe to import from Jest.
//
// Loaded in the browser as <script> (attaches window.RagExport) and
// required from Jest in test/unit/rag-export.test.ts.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RagExport = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function groupChunksBySource(docs) {
    const groups = new Map();
    const orphans = [];
    for (const doc of docs) {
      const md = doc && doc.metadata;
      const src = md && md.source;
      const idx = md && md.chunkIndex;
      if (src && Number.isInteger(idx)) {
        let arr = groups.get(src);
        if (!arr) {
          arr = [];
          groups.set(src, arr);
        }
        arr.push(doc);
      } else {
        orphans.push(doc);
      }
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
    }
    return { groups, orphans, warningsBySource: new Map() };
  }
  function safeSourceExportName(_sourceName, _used) {
    throw new Error('not implemented');
  }
  function reassembleSource(_group, _safeName, _warnings) {
    throw new Error('not implemented');
  }
  return { groupChunksBySource, safeSourceExportName, reassembleSource };
});
