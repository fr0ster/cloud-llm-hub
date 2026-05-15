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
  function groupChunksBySource(_docs) {
    throw new Error('not implemented');
  }
  function safeSourceExportName(_sourceName, _used) {
    throw new Error('not implemented');
  }
  function reassembleSource(_group, _safeName, _warnings) {
    throw new Error('not implemented');
  }
  return { groupChunksBySource, safeSourceExportName, reassembleSource };
});
