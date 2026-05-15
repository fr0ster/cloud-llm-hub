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
    const warningsBySource = new Map();
    for (const [src, arr] of groups.entries()) {
      arr.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
      const ws = [];

      // Duplicate chunkIndex
      const seen = new Set();
      for (const d of arr) {
        const i = d.metadata.chunkIndex;
        if (seen.has(i)) ws.push('⚠ ' + src + ': duplicate chunk index ' + i);
        seen.add(i);
      }

      // Contiguity 0..N-1 against the highest index present
      const present = new Set(arr.map((d) => d.metadata.chunkIndex));
      const max = Math.max(...arr.map((d) => d.metadata.chunkIndex));
      const missing = [];
      for (let i = 0; i <= max; i += 1) if (!present.has(i)) missing.push(i);
      if (missing.length) {
        ws.push('⚠ ' + src + ': ' + missing.length + ' chunks missing (indices ' + missing.join(',') + ')');
      }

      // totalChunks consistency
      const totals = Array.from(new Set(arr.map((d) => d.metadata.totalChunks).filter((v) => Number.isInteger(v))));
      if (totals.length > 1) {
        ws.push('⚠ ' + src + ': inconsistent totalChunks (' + totals.join(' vs ') + ')');
      } else if (totals.length === 1 && totals[0] !== arr.length) {
        ws.push('⚠ ' + src + ': expected ' + totals[0] + ' chunks, found ' + arr.length);
      }

      if (ws.length) warningsBySource.set(src, ws);
    }
    return { groups, orphans, warningsBySource };
  }
  function safeSourceExportName(_sourceName, _used) {
    throw new Error('not implemented');
  }
  function reassembleSource(_group, _safeName, _warnings) {
    throw new Error('not implemented');
  }
  return { groupChunksBySource, safeSourceExportName, reassembleSource };
});
