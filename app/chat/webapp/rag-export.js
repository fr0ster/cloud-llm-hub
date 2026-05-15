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
  function safeSourceExportName(sourceName, used) {
    const raw = String(sourceName == null ? '' : sourceName);

    // Strip directory components: last segment after the rightmost / or \
    const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    let leaf = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;

    // Reject pure-dot leftovers (".", "..") — they have no real name
    if (leaf === '' || leaf === '.' || leaf === '..') {
      leaf = '';
    }

    // Split extension off (.md / .txt / .json / .markdown / etc.).
    // Preserve everything after the final dot as the extension when the
    // dot is neither first nor last.
    let base = leaf;
    let ext = '';
    const dot = leaf.lastIndexOf('.');
    if (dot > 0 && dot < leaf.length - 1) {
      base = leaf.slice(0, dot);
      ext = '.' + leaf.slice(dot + 1);
    }

    // Sanitize basename: replace each unsafe character with underscore individually
    base = base.replace(/[^A-Za-z0-9._-]/g, '_');
    ext = ext.replace(/[^A-Za-z0-9.]+/g, '');

    // Truncate basename to the same practical limit safeExportName uses (120 chars)
    if (base.length > 120) base = base.slice(0, 120);

    if (!base) return 'source.txt';

    let candidate = base + ext;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    let n = 1;
    while (used.has(base + '-' + n + ext)) n += 1;
    candidate = base + '-' + n + ext;
    used.add(candidate);
    return candidate;
  }
  function reassembleSource(group, safeName, warnings) {
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error('reassembleSource: group must be a non-empty array');
    }
    const ws = Array.isArray(warnings) ? warnings : [];
    const sourceName = (group[0].metadata && group[0].metadata.source) || safeName;
    const joined = group.map((d) => d.text == null ? '' : String(d.text)).join('\n\n');

    // createdAt: earliest among chunks (defensive — chunks of one upload share it)
    let createdAt;
    for (const d of group) {
      if (d.createdAt && (!createdAt || d.createdAt < createdAt)) createdAt = d.createdAt;
    }

    const description = group[0].metadata && group[0].metadata.description;
    const totalChunks = group[0].metadata && group[0].metadata.totalChunks;

    const sidecarObj = {
      source: sourceName,
      exportName: safeName,
      totalChunks: Number.isInteger(totalChunks) ? totalChunks : group.length,
      reassembledFrom: group.map((d) => d.id),
      warnings: ws.slice(),
    };
    if (description !== undefined && description !== null && description !== '') {
      sidecarObj.description = description;
    }
    if (createdAt) sidecarObj.createdAt = createdAt;

    return {
      name: safeName,
      body: joined,
      sidecar: {
        name: safeName + '.meta.json',
        body: JSON.stringify(sidecarObj, null, 2) + '\n',
      },
    };
  }
  return { groupChunksBySource, safeSourceExportName, reassembleSource };
});
